"""Bulk email verification jobs — one per user, with all job state in Redis.

Keys (per user, prefix ``sfmail:verify:<user_id>``):
  :queue     list  emails waiting to be checked (left = next)
  :inflight  list  emails being checked right now
  :seen      set   every email in this job, so pasting the same list again doesn't re-check anything
  :meta      hash  state, total, done, failed, s:<status> counts, started_at, updated_at

The task that does the checking lives in the API process. "Stop" cancels it and leaves half-checked emails in
``inflight``; "Start" moves them back to the front of the queue, so the job resumes exactly where it stopped.
A job that was running when the API went down is still "running" in Redis and is picked up again on startup.

Assumes a single API process (the default uvicorn command) — several processes would each resume the job.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone

import redis.asyncio as aioredis
from sqlalchemy import select

from app.config import settings
from app.database import async_session
from app.models import Contact, User, Verification
from app.services import limits
from app.services.verifier import verify_email

log = logging.getLogger(__name__)

CONCURRENCY = 5
DONE_TTL_SECONDS = 30 * 24 * 3600  # finished jobs disappear after 30 days; stopped ones are kept until Start/Discard
PARTS = ("queue", "inflight", "seen", "meta")

_redis: aioredis.Redis | None = None
_tasks: dict[uuid.UUID, asyncio.Task] = {}
_stopping: set[uuid.UUID] = set()  # users whose task is being cancelled by Stop (vs. the API shutting down)
_locks: dict[uuid.UUID, asyncio.Lock] = {}


def redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis


def _k(uid: uuid.UUID, part: str) -> str:
    return f"sfmail:verify:{uid}:{part}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lock(uid: uuid.UUID) -> asyncio.Lock:
    return _locks.setdefault(uid, asyncio.Lock())


async def _set_ttl(uid: uuid.UUID) -> None:
    """Only finished jobs expire. A stopped job must still be there however long it takes to press Start."""
    done = await _state(uid) == "done"
    p = redis().pipeline(transaction=False)
    for part in PARTS:
        if done:
            p.expire(_k(uid, part), DONE_TTL_SECONDS)
        else:
            p.persist(_k(uid, part))
    await p.execute()


async def _state(uid: uuid.UUID) -> str | None:
    return await redis().hget(_k(uid, "meta"), "state")


async def _remaining(uid: uuid.UUID) -> int:
    p = redis().pipeline(transaction=False)
    p.llen(_k(uid, "queue"))
    p.llen(_k(uid, "inflight"))
    q, f = await p.execute()
    return q + f


# ── Results ──────────────────────────────────────────────────────────────────

async def save_result(db, user_id: uuid.UUID, res: dict) -> None:
    """Store a verification, count it against the user's credits and update the matching contact (no commit)."""
    db.add(Verification(user_id=user_id, email=res["email"], status=res["status"], reason=res["reason"], details=res))
    await limits.bump_usage(db, user_id, verifications=1)
    c = (await db.execute(select(Contact).where(Contact.user_id == user_id, Contact.email == res["email"]))).scalar_one_or_none()
    if c:
        c.verify_status, c.verify_reason, c.verified_at = res["status"], res["reason"], datetime.now(timezone.utc)


async def _persist(uid: uuid.UUID, res: dict) -> bool:
    """Write one result to Postgres. False = out of credits, nothing written."""
    async with async_session() as db:
        user = await db.get(User, uid)
        if await limits.verification_credits_left(db, user) <= 0:
            return False
        await save_result(db, uid, res)
        await db.commit()
    return True


async def _finish(uid: uuid.UUID, email: str, status: str | None) -> None:
    """Take an email off the job: counted as done (with its status) or, when status is None, as failed."""
    meta = _k(uid, "meta")
    p = redis().pipeline(transaction=True)
    p.lrem(_k(uid, "inflight"), 1, email)
    if status is None:
        p.hincrby(meta, "failed", 1)
    else:
        p.hincrby(meta, "done", 1)
        p.hincrby(meta, f"s:{status}", 1)
    p.hset(meta, "updated_at", _now())
    await p.execute()


async def _save(uid: uuid.UUID, email: str, res: dict) -> None:
    """Runs shielded, so a Stop can't interrupt it between the DB write and the Redis bookkeeping."""
    try:
        if not await _persist(uid, res):
            p = redis().pipeline(transaction=True)
            p.lrem(_k(uid, "inflight"), 1, email)
            p.lpush(_k(uid, "queue"), email)
            p.hset(_k(uid, "meta"), "state", "no_credits")
            await p.execute()
            return
        await _finish(uid, email, res["status"])
    except Exception:  # noqa: BLE001
        log.exception("saving bulk verification for %s failed", email)
        try:
            await _finish(uid, email, None)
        except Exception:  # noqa: BLE001
            log.exception("could not update bulk job for %s", email)


# ── Runner ───────────────────────────────────────────────────────────────────

async def _worker(uid: uuid.UUID, saving: set[asyncio.Task]) -> bool:
    """Check emails until the queue is empty or the job leaves "running". Returns True if it crashed."""
    try:
        while await _state(uid) == "running":
            email = await redis().lmove(_k(uid, "queue"), _k(uid, "inflight"), "LEFT", "RIGHT")
            if email is None:
                return False
            try:
                res = await verify_email(email)
            except asyncio.CancelledError:
                raise  # stays in `inflight`; moved back to the queue on the next Start
            except Exception:  # noqa: BLE001
                log.exception("verifying %s failed", email)
                await _finish(uid, email, None)
                continue
            t = asyncio.ensure_future(_save(uid, email, res))
            saving.add(t)
            t.add_done_callback(saving.discard)
            await asyncio.shield(t)
        return False
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — e.g. Redis went away; the job is left resumable
        log.exception("bulk verification worker crashed")
        return True


async def _run(uid: uuid.UUID) -> None:
    saving: set[asyncio.Task] = set()
    shutting_down = crashed = relaunch = False
    try:
        crashed = any(await asyncio.gather(*(_worker(uid, saving) for _ in range(CONCURRENCY))))
    except asyncio.CancelledError:
        # Cancelled without a Stop = the API is shutting down. Leave the job "running" so startup resumes it.
        shutting_down = uid not in _stopping
    finally:
        try:
            if saving:
                await asyncio.gather(*saving, return_exceptions=True)
            if not shutting_down:
                state = await _state(uid)
                if await _remaining(uid) == 0 and state in ("running", "paused"):
                    await redis().hset(_k(uid, "meta"), "state", "done")
                elif state == "running" and not crashed:
                    relaunch = True  # emails were added just as the workers ran out of work
                elif state == "running":
                    await redis().hset(_k(uid, "meta"), "state", "paused")
                await _set_ttl(uid)
        except Exception:  # noqa: BLE001
            log.exception("could not settle bulk job state")
        _stopping.discard(uid)
        if relaunch:
            _tasks[uid] = asyncio.create_task(_run(uid))
        else:
            _tasks.pop(uid, None)


async def _start_locked(uid: uuid.UUID) -> None:
    t = _tasks.get(uid)
    if t and not t.done():
        if await _state(uid) == "running":
            return
        await t  # a run that hit "no credits" may still be finishing its last checks
    # Emails that were mid-check when the job stopped go back to the front, in their original order.
    while await redis().lmove(_k(uid, "inflight"), _k(uid, "queue"), "RIGHT", "LEFT"):
        pass
    meta = _k(uid, "meta")
    if not await redis().llen(_k(uid, "queue")):
        await redis().hset(meta, "state", "done")
        await _set_ttl(uid)
        return
    await redis().hset(meta, "state", "running")
    await redis().hsetnx(meta, "started_at", _now())
    _tasks[uid] = asyncio.create_task(_run(uid))


# ── Public API ───────────────────────────────────────────────────────────────

async def status(uid: uuid.UUID) -> dict:
    p = redis().pipeline(transaction=False)
    p.hgetall(_k(uid, "meta"))
    p.llen(_k(uid, "queue"))
    p.lrange(_k(uid, "inflight"), 0, -1)
    meta, qlen, inflight = await p.execute()
    return {
        "state": meta.get("state", "idle"),
        "total": int(meta.get("total", 0)),
        "done": int(meta.get("done", 0)),
        "failed": int(meta.get("failed", 0)),
        "remaining": qlen + len(inflight),
        "by_status": {k[2:]: int(v) for k, v in meta.items() if k.startswith("s:")},
        "current": inflight,
        "started_at": meta.get("started_at"),
        "updated_at": meta.get("updated_at"),
    }


async def enqueue(uid: uuid.UUID, emails: list[str], credits: int) -> tuple[int, int]:
    """Add emails to the user's job (starting a fresh one if the last finished) and start it.

    Returns (queued, skipped_for_credits). Emails already in the job (waiting or checked) are ignored.
    """
    async with _lock(uid):
        if await _state(uid) in (None, "done"):
            await redis().delete(*(_k(uid, p) for p in PARTS))
        already = await redis().smismember(_k(uid, "seen"), emails) if emails else []
        fresh = [e for e, dup in zip(emails, already) if not dup]
        queued = fresh[:credits]
        if queued:
            p = redis().pipeline(transaction=True)
            p.sadd(_k(uid, "seen"), *queued)
            p.rpush(_k(uid, "queue"), *queued)
            p.hincrby(_k(uid, "meta"), "total", len(queued))
            p.hsetnx(_k(uid, "meta"), "state", "paused")
            await p.execute()
            await _set_ttl(uid)
            if await _state(uid) != "running" or uid not in _tasks:
                await _start_locked(uid)
        return len(queued), len(fresh) - len(queued)


async def start(uid: uuid.UUID) -> None:
    async with _lock(uid):
        await _start_locked(uid)


async def stop(uid: uuid.UUID) -> bool:
    """Stop the running job. False when nothing was running."""
    async with _lock(uid):
        if await _state(uid) != "running":
            return False
        await redis().hset(_k(uid, "meta"), "state", "paused")
        t = _tasks.get(uid)
        if t and not t.done():
            _stopping.add(uid)
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
        return True


async def clear(uid: uuid.UUID) -> bool:
    """Throw the job away. False when it's still running."""
    async with _lock(uid):
        if await _state(uid) == "running":
            return False
        await redis().delete(*(_k(uid, p) for p in PARTS))
        return True


async def remaining(uid: uuid.UUID) -> int:
    return await _remaining(uid)


async def resume_running() -> None:
    """On API startup: carry on with every job that was running when the API last went down, and make sure
    stopped jobs don't carry an expiry (older versions set one)."""
    try:
        async for key in redis().scan_iter(match="sfmail:verify:*:meta", count=200):
            uid = uuid.UUID(key.split(":")[2])
            state = await redis().hget(key, "state")
            if state == "running":
                log.info("resuming bulk verification for user %s", uid)
                await start(uid)
            else:
                await _set_ttl(uid)
    except Exception:  # noqa: BLE001 — never block startup on this
        log.exception("could not resume bulk verifications")


async def shutdown() -> None:
    tasks = [t for t in _tasks.values() if not t.done()]
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    if _redis is not None:
        await _redis.aclose()
