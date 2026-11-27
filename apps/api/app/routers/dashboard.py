import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, or_, select

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Campaign, Contact, Domain, Event, Mailbox, Message, Template, UsageDaily
from app.routers.auth import build_usage
from app.services import graph, outreach, transport
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


# ── Unified inbox ───────────────────────────────────────────────
# Both views (replies and sent) take the same filters: campaign (+ step), mailbox and sending domain.

def _sender_domain_cond(domain: str):
    """Messages sent from any mailbox on ``domain`` (the part after @ of the sending address)."""
    d = domain.strip().lower().lstrip("@")
    return Message.mailbox_id.in_(select(Mailbox.id).where(func.lower(Mailbox.email).like(f"%@{d}")))


def _filtered(stmt, mailbox_id=None, campaign_id=None, node_id=None, domain=None, direct: bool = False):
    if mailbox_id:
        stmt = stmt.where(Message.mailbox_id == mailbox_id)
    if direct:
        stmt = stmt.where(Message.campaign_id.is_(None))
    elif campaign_id:
        stmt = stmt.where(Message.campaign_id == campaign_id)
    if node_id:
        stmt = stmt.where(Message.node_id == node_id)
    if domain:
        stmt = stmt.where(_sender_domain_cond(domain))
    return stmt


def _base(user_id):
    return (select(Message, Contact.first_name, Contact.last_name, Contact.company, Mailbox.email, Campaign, Template.name)
            .outerjoin(Contact, Contact.id == Message.contact_id)
            .outerjoin(Mailbox, Mailbox.id == Message.mailbox_id)
            .outerjoin(Campaign, Campaign.id == Message.campaign_id)
            .outerjoin(Template, Template.id == Message.template_id)
            .where(Message.user_id == user_id))


@router.get("/inbox")
async def inbox(user: CurrentUser, db: DB, mailbox_id: uuid.UUID | None = None, campaign_id: uuid.UUID | None = None,
                node_id: str | None = None, domain: str | None = None, direct: bool = False,
                page: int = Query(1, ge=1), size: int = Query(30, le=100)):
    """Replies, newest first. Each one says which campaign it came from and which stage (sent email) was replied to."""
    stmt = _filtered(_base(user.id).where(Message.replied_at.is_not(None)), mailbox_id, campaign_id, node_id, domain, direct)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(Message.replied_at.desc()).offset((page - 1) * size).limit(size))).all()
    graphs: dict[uuid.UUID, dict] = {}
    items = []
    for m, fn, ln, co, mb, camp, tname in rows:
        stage = None
        if camp:
            g = graphs.setdefault(camp.id, graph.campaign_graph(camp))
            stage = {**graph.stage_of(g, m.node_id), "template": tname}
        items.append({
            "id": m.id, "to": m.to_email, "name": f"{fn or ''} {ln or ''}".strip(), "company": co, "mailbox": mb,
            "campaign": camp.name if camp else None, "campaign_id": camp.id if camp else None,
            "campaign_kind": camp.kind if camp else None, "stage": stage, "template": tname,
            "subject": m.subject, "reply": m.reply_snippet, "replied_at": m.replied_at,
            "sent_body": strip_tracking(m.body_html), "sent_at": m.sent_at,
        })
    return {"total": total, "items": items}


@router.get("/inbox/sent")
async def sent(user: CurrentUser, db: DB, mailbox_id: uuid.UUID | None = None, campaign_id: uuid.UUID | None = None,
               node_id: str | None = None, domain: str | None = None, direct: bool = False, q: str = "",
               status_filter: str = Query("", alias="status", pattern="^(|opened|clicked|replied|unopened|bounced|failed)$"),
               page: int = Query(1, ge=1), size: int = Query(50, le=100)):
    """Every email that went out (newest first), with campaign, step, mailbox and what the lead did with it."""
    stmt = _filtered(_base(user.id), mailbox_id, campaign_id, node_id, domain, direct)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(Message.to_email.like(like), func.lower(Message.subject).like(like),
                              func.lower(Contact.company).like(like)))
    if status_filter in ("bounced", "failed"):
        stmt = stmt.where(Message.status == status_filter)
    else:
        stmt = stmt.where(Message.status != "failed")
        col = {"opened": Message.opened_at, "clicked": Message.clicked_at, "replied": Message.replied_at}.get(status_filter)
        if col is not None:
            stmt = stmt.where(col.is_not(None))
        elif status_filter == "unopened":
            stmt = stmt.where(Message.opened_at.is_(None), Message.status == "sent")
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(Message.sent_at.desc()).offset((page - 1) * size).limit(size))).all()
    graphs: dict[uuid.UUID, dict] = {}
    items = []
    for m, fn, ln, co, mb, camp, tname in rows:
        stage = {**graph.stage_of(graphs.setdefault(camp.id, graph.campaign_graph(camp)), m.node_id), "template": tname} if camp else None
        items.append({
            "id": m.id, "to": m.to_email, "name": f"{fn or ''} {ln or ''}".strip(), "company": co, "mailbox": mb,
            "campaign": camp.name if camp else None, "campaign_id": camp.id if camp else None,
            "campaign_kind": camp.kind if camp else None, "stage": stage, "template": tname, "subject": m.subject,
            "status": m.status, "sent_at": m.sent_at, "opened_at": m.opened_at, "open_count": m.open_count,
            "clicked_at": m.clicked_at, "click_count": m.click_count, "replied_at": m.replied_at,
        })
    return {"total": total, "items": items}


@router.get("/inbox/messages/{message_id}")
async def message_detail(message_id: uuid.UUID, user: CurrentUser, db: DB):
    """One sent email in full: body (tracking stripped), which links the lead clicked, and their reply."""
    from app.routers.contacts import human_clicks

    m = await get_owned(db, Message, message_id, user)
    contact = await db.get(Contact, m.contact_id) if m.contact_id else None
    return {"id": m.id, "to": m.to_email, "contact_id": contact.id if contact else None, "subject": m.subject,
            "body": strip_tracking(m.body_html), "status": m.status, "error": m.error, "sent_at": m.sent_at,
            "opened_at": m.opened_at, "open_count": m.open_count, "clicked_at": m.clicked_at, "click_count": m.click_count,
            "clicks": (await human_clicks(db, [m.id])).get(m.id, []), "replied_at": m.replied_at, "reply": m.reply_snippet,
            "dnc": await outreach.blocked(db, user.id, m.to_email)}


@router.get("/inbox/campaigns")
async def inbox_campaigns(user: CurrentUser, db: DB, mailbox_id: uuid.UUID | None = None, domain: str | None = None,
                          view: str = Query("replies", pattern="^(replies|sent)$")):
    """Campaigns with replies (or sent emails), counted per stage — drives the Unibox filters."""
    stmt = (select(Message.campaign_id, Message.node_id, func.count())
            .where(Message.user_id == user.id,
                   Message.replied_at.is_not(None) if view == "replies" else Message.status != "failed")
            .group_by(Message.campaign_id, Message.node_id))
    stmt = _filtered(stmt, mailbox_id, domain=domain)
    counts = (await db.execute(stmt)).all()
    ids = {cid for cid, _, _ in counts if cid}
    camps = {c.id: c for c in (await db.execute(select(Campaign).where(Campaign.id.in_(ids)))).scalars()} if ids else {}
    out: dict[uuid.UUID | None, dict] = {}
    for cid, nid, n in counts:
        c = camps.get(cid)
        row = out.setdefault(cid, {"id": cid, "name": c.name if c else "Direct emails", "kind": c.kind if c else None,
                                   "count": 0, "stages": []})
        row["count"] += n
        if c:
            row["stages"].append({**graph.stage_of(graph.campaign_graph(c), nid), "count": n})
    for row in out.values():
        row["stages"].sort(key=lambda s: (s["step"] or 1 << 30, s["name"] or "", s["node_id"] or ""))
    return sorted(out.values(), key=lambda r: (r["id"] is None, -r["count"], r["name"]))


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
