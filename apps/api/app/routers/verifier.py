import asyncio
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.deps import DB, CurrentUser, get_owned
from app.database import async_session
from app.models import Contact, ContactList, User, Verification, list_contacts
from app.services import limits
from app.services.verifier import verify_email

router = APIRouter(prefix="/verify", tags=["verifier"])


class VerifyIn(BaseModel):
    email: str


class BulkIn(BaseModel):
    list_id: uuid.UUID | None = None
    emails: list[str] = []
    only_unknown: bool = True


async def _record(db, user_id, res: dict):
    db.add(Verification(user_id=user_id, email=res["email"], status=res["status"], reason=res["reason"], details=res))
    await limits.bump_usage(db, user_id, verifications=1)


@router.post("")
async def verify_one(body: VerifyIn, user: CurrentUser, db: DB):
    if await limits.verification_credits_left(db, user) <= 0:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "No verification credits left this month")
    res = await verify_email(body.email)
    await _record(db, user.id, res)
    c = (await db.execute(select(Contact).where(Contact.user_id == user.id, Contact.email == res["email"]))).scalar_one_or_none()
    if c:
        c.verify_status, c.verify_reason, c.verified_at = res["status"], res["reason"], datetime.now(timezone.utc)
    await db.commit()
    return res


async def _bulk_job(user_id: uuid.UUID, emails: list[str]):
    sem = asyncio.Semaphore(5)

    async def one(email: str):
        async with sem:
            return await verify_email(email)

    for i in range(0, len(emails), 25):
        chunk = emails[i:i + 25]
        results = await asyncio.gather(*(one(e) for e in chunk), return_exceptions=True)
        async with async_session() as db:
            user = await db.get(User, user_id)
            for res in results:
                if isinstance(res, Exception):
                    continue
                if await limits.verification_credits_left(db, user) <= 0:
                    await db.commit()
                    return
                await _record(db, user_id, res)
                c = (await db.execute(select(Contact).where(Contact.user_id == user_id, Contact.email == res["email"]))).scalar_one_or_none()
                if c:
                    c.verify_status, c.verify_reason, c.verified_at = res["status"], res["reason"], datetime.now(timezone.utc)
                await db.commit()


@router.post("/bulk")
async def verify_bulk(body: BulkIn, user: CurrentUser, db: DB, background: BackgroundTasks):
    emails = [e.strip().lower() for e in body.emails if "@" in e]
    if body.list_id:
        await get_owned(db, ContactList, body.list_id, user)
        stmt = (select(Contact.email).join(list_contacts, list_contacts.c.contact_id == Contact.id)
                .where(list_contacts.c.list_id == body.list_id))
        if body.only_unknown:
            stmt = stmt.where(Contact.verify_status == "unknown")
        emails += list((await db.execute(stmt)).scalars())
    emails = list(dict.fromkeys(emails))
    credits = await limits.verification_credits_left(db, user)
    if not emails:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to verify")
    if credits <= 0:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "No verification credits left this month")
    queued = emails[:credits]
    background.add_task(_bulk_job, user.id, queued)
    return {"queued": len(queued), "skipped_no_credits": len(emails) - len(queued)}


@router.get("/history")
async def history(user: CurrentUser, db: DB, limit: int = 100):
    rows = (await db.execute(
        select(Verification).where(Verification.user_id == user.id).order_by(Verification.created_at.desc()).limit(min(limit, 500))
    )).scalars().all()
    return [{"id": v.id, "email": v.email, "status": v.status, "reason": v.reason, "created_at": v.created_at,
             "details": v.details} for v in rows]


@router.get("/summary")
async def summary(user: CurrentUser, db: DB):
    rows = (await db.execute(
        select(Contact.verify_status, func.count()).where(Contact.user_id == user.id).group_by(Contact.verify_status)
    )).all()
    return {"by_status": {s: n for s, n in rows}, "credits_left": await limits.verification_credits_left(db, user),
            "credits_monthly": user.verify_credits_monthly}
