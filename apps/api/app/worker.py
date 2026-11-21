"""Background worker: `python -m app.worker`

Runs the campaign engine and the IMAP reply/bounce poller on fixed intervals. A Redis lock per job
makes it safe to run several worker processes (only one executes each job at a time).
"""

import asyncio
import logging
import signal

import redis.asyncio as aioredis

from app.config import settings
from app.services import engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("worker")


async def _every(name: str, seconds: int, fn, r: aioredis.Redis, stop: asyncio.Event) -> None:
    while not stop.is_set():
        lock = r.lock(f"sfmail:job:{name}", timeout=max(seconds * 3, 60), blocking=False)
        if await lock.acquire():
            try:
                await fn()
            except Exception:  # noqa: BLE001
                log.exception("job %s crashed", name)
            finally:
                try:
                    await lock.release()
                except Exception:  # noqa: BLE001 — lock may have expired
                    pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows
            pass
    r = aioredis.from_url(settings.REDIS_URL)
    log.info("worker started (engine every %ss, replies every %ss)", settings.ENGINE_TICK_SECONDS, settings.REPLY_POLL_SECONDS)
    await asyncio.gather(
        _every("engine", settings.ENGINE_TICK_SECONDS, engine.tick, r, stop),
        _every("replies", settings.REPLY_POLL_SECONDS, engine.poll_replies, r, stop),
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
