import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Campaign, Contact, Domain, Event, Mailbox, Message, UsageDaily
from app.routers.auth import build_usage
from app.services import transport
from app.services.renderer import strip_tracking

router = APIRouter(tags=["dashboard"])

RANGES = {"1D": 1, "1W": 7, "1M": 30, "6M": 182, "1Y": 365}


@router.get("/dashboard")
async def dashboard(user: CurrentUser, db: DB):
    usage = await build_usage(db, user)
    since = date.today() - timedelta(days=182)
    six_month_sent = (await db.execute(
        select(func.coalesce(func.sum(UsageDaily.emails_sent), 0)).where(UsageDaily.user_id == user.id, UsageDaily.day >= since)
    )).scalar_one()
    mailboxes = (await db.execute(select(Mailbox).where(Mailbox.user_id == user.id).order_by(Mailbox.health_score.desc()))).scalars().all()
    domains = (await db.execute(select(Domain).where(Domain.user_id == user.id).order_by(Domain.health_score.desc().nulls_last()))).scalars().all()
    start = datetime.combine(date.today(), datetime.min.time(), timezone.utc)
    week = start - timedelta(days=7)
    sent_by_mb = dict((await db.execute(
        select(Message.mailbox_id, func.count()).where(Message.user_id == user.id, Message.sent_at >= start).group_by(Message.mailbox_id)
    )).all())
    last_week = dict((await db.execute(
        select(Message.mailbox_id, func.count()).where(Message.user_id == user.id, Message.sent_at >= week, Message.sent_at < start)
        .group_by(Message.mailbox_id)
    )).all())
    mb_counts = dict((await db.execute(select(Mailbox.domain_id, func.count()).where(Mailbox.user_id == user.id).group_by(Mailbox.domain_id))).all())
    totals = (await db.execute(
        select(func.count().filter(Message.status != "failed"), func.count(Message.opened_at), func.count(Message.replied_at),
               func.count().filter(Message.status == "bounced"))
        .where(Message.user_id == user.id, Message.sent_at >= start - timedelta(days=30))
    )).one()
    return {
        "usage": usage,
        "emails_sent_6m": int(six_month_sent),
        "rates_30d": {"sent": totals[0], "opened": totals[1], "replied": totals[2], "bounced": totals[3]},
        "mailboxes": [
            {"id": m.id, "email": m.email, "provider": m.provider, "status": m.status, "health_score": m.health_score,
             "warmup_enabled": m.warmup_enabled, "warmup": m.warmup, "daily_limit": m.daily_limit,
             "sent_today": sent_by_mb.get(m.id, 0), "avg_last_week": round(last_week.get(m.id, 0) / 7, 1),
             "last_error": m.last_error}
            for m in mailboxes
        ],
        "domains": [
            {"id": d.id, "name": d.name, "health_score": d.health_score, "verified": d.verified,
             "mailboxes": mb_counts.get(d.id, 0),
             "issues": [k for k in ("spf", "dkim", "dmarc", "mx", "blacklists") if (d.last_check or {}).get(k, {}).get("status") == "fail"]}
            for d in domains
        ],
    }


@router.get("/dashboard/performance")
async def performance(user: CurrentUser, db: DB, range_: str = Query("1M", alias="range")):
    days = RANGES.get(range_, 30)
    now = datetime.now(timezone.utc)
    if days == 1:
        since = now - timedelta(hours=24)
        bucket = func.date_trunc("hour", Message.sent_at)
        step, n = timedelta(hours=1), 24
        base = since.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    elif days <= 30:
        since = now - timedelta(days=days)
        bucket = func.date_trunc("day", Message.sent_at)
        step, n = timedelta(days=1), days
        base = since.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    else:
        since = now - timedelta(days=days)
        bucket = func.date_trunc("week", Message.sent_at)
        step, n = timedelta(weeks=1), days // 7
        base = (since - timedelta(days=since.weekday())).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(weeks=1)
    rows = (await db.execute(
        select(bucket, func.count(), func.count(Message.opened_at), func.count(Message.replied_at))
        .where(Message.user_id == user.id, Message.sent_at >= since, Message.status != "failed").group_by(bucket)
    )).all()
    by = {b.replace(tzinfo=timezone.utc) if b.tzinfo is None else b: (s, o, r) for b, s, o, r in rows}
    points = []
    for i in range(n):
        t = base + step * i
        s, o, r = by.get(t, (0, 0, 0))
        points.append({"t": t.isoformat(), "sent": s, "opened": o, "replied": r})
    return {"range": range_, "points": points}


# ── Unified inbox (basic) ───────────────────────────────────────

@router.get("/inbox")
async def inbox(user: CurrentUser, db: DB, mailbox_id: uuid.UUID | None = None, campaign_id: uuid.UUID | None = None,
                page: int = Query(1, ge=1), size: int = Query(30, le=100)):
    stmt = (select(Message, Contact.first_name, Contact.last_name, Contact.company, Mailbox.email, Campaign.name)
            .outerjoin(Contact, Contact.id == Message.contact_id)
            .outerjoin(Mailbox, Mailbox.id == Message.mailbox_id)
            .outerjoin(Campaign, Campaign.id == Message.campaign_id)
            .where(Message.user_id == user.id, Message.replied_at.is_not(None)))
    if mailbox_id:
        stmt = stmt.where(Message.mailbox_id == mailbox_id)
    if campaign_id:
        stmt = stmt.where(Message.campaign_id == campaign_id)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(Message.replied_at.desc()).offset((page - 1) * size).limit(size))).all()
    return {"total": total, "items": [
        {"id": m.id, "to": m.to_email, "name": f"{fn or ''} {ln or ''}".strip(), "company": co, "mailbox": mb,
         "campaign": cname, "subject": m.subject, "reply": m.reply_snippet, "replied_at": m.replied_at,
         "sent_body": strip_tracking(m.body_html), "sent_at": m.sent_at}
        for m, fn, ln, co, mb, cname in rows
    ]}


class ReplyIn(BaseModel):
    body_html: str


@router.post("/inbox/{message_id}/reply")
async def reply(message_id: uuid.UUID, body: ReplyIn, user: CurrentUser, db: DB):
    msg = await get_owned(db, Message, message_id, user)
    mb = await db.get(Mailbox, msg.mailbox_id) if msg.mailbox_id else None
    if not mb:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The original mailbox no longer exists")
    from app.services.renderer import html_to_text
    subject = msg.subject if msg.subject.lower().startswith("re:") else f"Re: {msg.subject}"
    email = transport.build_message(mb, to=msg.to_email, subject=subject, html=body.body_html, text=html_to_text(body.body_html),
                                    message_id=transport.new_message_id(mb), in_reply_to=msg.message_id_header,
                                    references=msg.message_id_header)
    try:
        await transport.send(mb, email)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Send failed — {type(e).__name__}: {e}")
    db.add(Event(user_id=user.id, message_id=msg.id, campaign_id=msg.campaign_id, contact_id=msg.contact_id,
                 kind="manual_reply", meta={"body": body.body_html[:2000]}))
    await db.commit()
    return {"ok": True}
