import uuid

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Contact, ContactList, Verification, list_contacts
from app.services import bulk_verify, limits
from app.services.verifier import verify_email

router = APIRouter(prefix="/verify", tags=["verifier"])


class VerifyIn(BaseModel):
    email: str


class BulkIn(BaseModel):
    list_id: uuid.UUID | None = None
    emails: list[str] = []
    only_unknown: bool = True


@router.post("")
async def verify_one(body: VerifyIn, user: CurrentUser, db: DB):
    if await limits.verification_credits_left(db, user) <= 0:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "No verification credits left this month")
    res = await verify_email(body.email)
    await bulk_verify.save_result(db, user.id, res)
    await db.commit()
    return res


# Bulk jobs live in Redis (see app.services.bulk_verify). Stop / Start pause and resume where it left off.

@router.post("/bulk")
async def verify_bulk(body: BulkIn, user: CurrentUser, db: DB):
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
    queued, skipped = await bulk_verify.enqueue(user.id, emails, credits)
    return {"queued": queued, "skipped_no_credits": skipped, "job": await bulk_verify.status(user.id)}


@router.get("/bulk/status")
async def bulk_status(user: CurrentUser):
    return await bulk_verify.status(user.id)


@router.post("/bulk/stop")
async def bulk_stop(user: CurrentUser):
    if not await bulk_verify.stop(user.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "No verification is running")
    return await bulk_verify.status(user.id)


@router.post("/bulk/start")
async def bulk_start(user: CurrentUser, db: DB):
    if not await bulk_verify.remaining(user.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Nothing left to verify")
    if await limits.verification_credits_left(db, user) <= 0:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "No verification credits left this month")
    await bulk_verify.start(user.id)
    return await bulk_verify.status(user.id)


@router.post("/bulk/clear")
async def bulk_clear(user: CurrentUser):
    if not await bulk_verify.clear(user.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Stop the verification first")
    return {"ok": True}


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
