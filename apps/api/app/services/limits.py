"""Server-side enforcement of the limits the super admin sets per user."""

import uuid
from datetime import date

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Campaign, Contact, Domain, Mailbox, UsageDaily, User


def _deny(msg: str):
    raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, msg)


async def _count(db: AsyncSession, model, user_id: uuid.UUID, *extra) -> int:
    q = select(func.count()).select_from(model).where(model.user_id == user_id, *extra)
    return (await db.execute(q)).scalar_one()


async def ensure_can_add_domain(db: AsyncSession, user: User):
    if await _count(db, Domain, user.id) >= user.max_domains:
        _deny(f"Domain limit reached ({user.max_domains}). Ask your admin to raise it.")


async def ensure_can_add_mailbox(db: AsyncSession, user: User):
    if await _count(db, Mailbox, user.id) >= user.max_mailboxes:
        _deny(f"Mailbox limit reached ({user.max_mailboxes}). Ask your admin to raise it.")


async def ensure_can_launch_campaign(db: AsyncSession, user: User):
    active = await _count(db, Campaign, user.id, Campaign.status == "running")
    if active >= user.max_campaigns:
        _deny(f"Active campaign limit reached ({user.max_campaigns}).")


async def contacts_remaining(db: AsyncSession, user: User) -> int:
    return max(0, user.max_contacts - await _count(db, Contact, user.id))


async def usage_today(db: AsyncSession, user_id: uuid.UUID) -> UsageDaily | None:
    return await db.get(UsageDaily, (user_id, date.today()))


async def usage_month(db: AsyncSession, user_id: uuid.UUID) -> tuple[int, int]:
    first = date.today().replace(day=1)
    q = select(func.coalesce(func.sum(UsageDaily.emails_sent), 0), func.coalesce(func.sum(UsageDaily.verifications), 0)).where(
        UsageDaily.user_id == user_id, UsageDaily.day >= first
    )
    sent, verifs = (await db.execute(q)).one()
    return int(sent), int(verifs)


async def sending_capacity(db: AsyncSession, user: User) -> int:
    """How many more emails this user may send right now (daily and monthly caps)."""
    today = await usage_today(db, user.id)
    sent_today = today.emails_sent if today else 0
    sent_month, _ = await usage_month(db, user.id)
    return max(0, min(user.max_daily_emails - sent_today, user.max_monthly_emails - sent_month))


async def verification_credits_left(db: AsyncSession, user: User) -> int:
    _, used = await usage_month(db, user.id)
    return max(0, user.verify_credits_monthly - used)


async def bump_usage(db: AsyncSession, user_id: uuid.UUID, *, emails: int = 0, verifications: int = 0):
    stmt = insert(UsageDaily).values(user_id=user_id, day=date.today(), emails_sent=emails, verifications=verifications)
    stmt = stmt.on_conflict_do_update(
        index_elements=[UsageDaily.user_id, UsageDaily.day],
        set_={
            "emails_sent": UsageDaily.emails_sent + emails,
            "verifications": UsageDaily.verifications + verifications,
        },
    )
    await db.execute(stmt)
