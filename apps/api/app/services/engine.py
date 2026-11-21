"""Campaign engine — advances every live campaign contact through its sequence graph.

Runs inside the worker every ENGINE_TICK_SECONDS. Each tick, per running campaign:
  * loads due contacts (next_run_at <= now) with SKIP LOCKED so multiple workers are safe
  * walks start / wait / condition nodes instantly, and performs at most ONE send per contact
  * respects: campaign send window + working days, campaign daily cap, user daily/monthly
    limits, per-mailbox daily limit and randomized per-mailbox delays
"""

import logging
import random
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import aiosmtplib
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.models import Campaign, CampaignContact, Contact, Mailbox, Message, Suppression, Template, User
from app.models.campaign import LIVE_STATES
from app.services import graph as g
from app.services import limits, renderer, transport
from app.services.schedule import add_wait, in_window, next_window_start

log = logging.getLogger("engine")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def today_start() -> datetime:
    n = utcnow()
    return n.replace(hour=0, minute=0, second=0, microsecond=0)


@dataclass
class Ctx:
    db: AsyncSession
    camp: Campaign
    user: User
    graph: dict
    templates: dict[str, Template]
    mailboxes: dict[uuid.UUID, Mailbox]
    mb_sent_today: dict[uuid.UUID, int]
    capacity: int
    campaign_sent_today: int
    now: datetime = field(default_factory=utcnow)
    mb_ready: dict[uuid.UUID, datetime] = field(default_factory=dict)


async def tick() -> None:
    async with async_session() as db:
        ids = (await db.execute(select(Campaign.id).where(Campaign.status == "running"))).scalars().all()
    for cid in ids:
        try:
            await process_campaign(cid)
        except Exception:  # noqa: BLE001 — one broken campaign must not stall the others
            log.exception("campaign %s failed", cid)


async def process_campaign(cid: uuid.UUID) -> None:
    async with async_session() as db:
        camp = await db.get(Campaign, cid)
        if not camp or camp.status != "running" or not camp.graph_snapshot:
            return
        start_at = (camp.schedule or {}).get("start_at")
        if start_at and datetime.fromisoformat(start_at) > utcnow():
            return
        user = await db.get(User, camp.user_id)
        if not user or user.status != "active":
            return

        now = utcnow()
        due = (
            await db.execute(
                select(CampaignContact)
                .where(
                    CampaignContact.campaign_id == cid,
                    CampaignContact.state.in_(LIVE_STATES),
                    (CampaignContact.next_run_at.is_(None)) | (CampaignContact.next_run_at <= now),
                )
                .order_by(CampaignContact.next_run_at.asc().nulls_first())
                .limit(settings.ENGINE_BATCH_SIZE)
                .with_for_update(skip_locked=True)
            )
        ).scalars().all()

        if due:
            ctx = await _build_ctx(db, camp, user)
            for cc in due:
                await advance(ctx, cc)
            await db.commit()

        live = (
            await db.execute(
                select(func.count()).select_from(CampaignContact).where(
                    CampaignContact.campaign_id == cid, CampaignContact.state.in_(LIVE_STATES)
                )
            )
        ).scalar_one()
        if live == 0:
            camp.status = "completed"
            camp.completed_at = utcnow()
            await db.commit()


async def _build_ctx(db: AsyncSession, camp: Campaign, user: User) -> Ctx:
    graph = camp.graph_snapshot or {}
    tids = [uuid.UUID(t) for t in g.template_ids_in(graph)]
    templates = {str(t.id): t for t in (await db.execute(select(Template).where(Template.id.in_(tids)))).scalars()}
    mb_ids = [uuid.UUID(str(m)) for m in camp.mailbox_ids or []]
    mailboxes = {
        m.id: m for m in (await db.execute(select(Mailbox).where(Mailbox.id.in_(mb_ids), Mailbox.user_id == user.id))).scalars()
    }
    start = today_start()
    rows = await db.execute(
        select(Message.mailbox_id, func.count()).where(Message.mailbox_id.in_(mb_ids), Message.sent_at >= start)
        .group_by(Message.mailbox_id)
    )
    mb_sent = {mid: n for mid, n in rows.all()}
    camp_sent = (
        await db.execute(select(func.count()).select_from(Message).where(Message.campaign_id == camp.id, Message.sent_at >= start))
    ).scalar_one()
    return Ctx(
        db=db, camp=camp, user=user, graph=graph, templates=templates, mailboxes=mailboxes,
        mb_sent_today=mb_sent, capacity=await limits.sending_capacity(db, user), campaign_sent_today=camp_sent,
    )


def _finish(cc: CampaignContact, state: str = "done") -> None:
    cc.state = state
    cc.next_run_at = None


async def advance(ctx: Ctx, cc: CampaignContact) -> None:
    graph, nodes = ctx.graph, g.nodes_by_id(ctx.graph)
    if cc.state == "pending":
        cc.state = "active"
        cc.current_node = g.start_node(graph)

    for _ in range(25):  # bounded walk; validated graphs have no loops
        node = nodes.get(cc.current_node or "")
        if not node:
            return _finish(cc)
        kind, data = node.get("type"), node.get("data") or {}

        if kind == "start":
            nxt = g.next_node(graph, node["id"])
            if not nxt:
                return _finish(cc)
            cc.current_node = nxt
            continue

        if kind == "wait":
            if cc.state == "waiting":  # woke up after the delay
                cc.state = "active"
                nxt = g.next_node(graph, node["id"])
                if not nxt:
                    return _finish(cc)
                cc.current_node = nxt
                continue
            cc.state = "waiting"
            cc.next_run_at = add_wait(
                ctx.now, days=int(data.get("days") or 0), hours=int(data.get("hours") or 0),
                minutes=int(data.get("minutes") or 0), working_days_only=bool(data.get("working_days_only")),
                schedule=ctx.camp.schedule,
            )
            return

        if kind == "condition":
            hit = await _condition_met(ctx, cc, data)
            nxt = g.next_node(graph, node["id"], "yes" if hit else "no")
            if not nxt:
                return _finish(cc)
            cc.current_node = nxt
            continue

        if kind == "send":
            outcome = await _send(ctx, cc, node)
            if outcome != "sent":
                return
            nxt = g.next_node(graph, node["id"])
            if not nxt:
                return _finish(cc)
            cc.current_node = nxt
            cc.next_run_at = ctx.now  # continue on the next tick
            return

        return _finish(cc, "failed")
    _finish(cc, "failed")


async def _condition_met(ctx: Ctx, cc: CampaignContact, data: dict) -> bool:
    col = {"opened": Message.opened_at, "clicked": Message.clicked_at, "replied": Message.replied_at}[data.get("check", "opened")]
    q = select(func.count()).select_from(Message).where(Message.campaign_contact_id == cc.id, col.is_not(None))
    return (await ctx.db.execute(q)).scalar_one() > 0


def _defer(cc: CampaignContact, until: datetime) -> str:
    cc.next_run_at = until
    return "deferred"


def _pick_mailbox(ctx: Ctx, cc: CampaignContact) -> tuple[Mailbox | None, datetime | None]:
    def usable(mb: Mailbox) -> bool:
        return mb.status == "active" and ctx.mb_sent_today.get(mb.id, 0) < mb.daily_limit

    def ready_at(mb: Mailbox) -> datetime:
        if mb.id in ctx.mb_ready:
            return ctx.mb_ready[mb.id]
        if not mb.last_sent_at:
            return ctx.now
        return mb.last_sent_at + timedelta(seconds=mb.min_delay_seconds)

    # Keep a thread on the same mailbox.
    sticky = ctx.mailboxes.get(cc.mailbox_id) if cc.mailbox_id else None
    if sticky:
        return (sticky, ready_at(sticky)) if usable(sticky) else (None, None)
    pool = [m for m in ctx.mailboxes.values() if usable(m)]
    if not pool:
        return None, None
    pool.sort(key=lambda m: (ready_at(m), ctx.mb_sent_today.get(m.id, 0)))
    return pool[0], ready_at(pool[0])


async def _send(ctx: Ctx, cc: CampaignContact, node: dict) -> str:
    db, camp, now = ctx.db, ctx.camp, ctx.now
    data = node.get("data") or {}

    contact = await db.get(Contact, cc.contact_id)
    if not contact or contact.unsubscribed:
        _finish(cc, "stopped")
        return "stopped"
    if await db.get(Suppression, (ctx.user.id, contact.email)):
        _finish(cc, "stopped")
        return "stopped"

    if not in_window(camp.schedule or {}, now):
        return _defer(cc, next_window_start(camp.schedule or {}, now))
    if ctx.capacity <= 0 or ctx.campaign_sent_today >= int((camp.settings or {}).get("daily_cap") or 10**9):
        return _defer(cc, now + timedelta(minutes=30))

    mb, ready = _pick_mailbox(ctx, cc)
    if not mb:
        return _defer(cc, now + timedelta(minutes=30))
    if ready and ready > now:
        return _defer(cc, ready)

    choices = [ctx.templates[t] for t in data.get("template_ids") or [] if t in ctx.templates]
    if not choices:
        cc.error = "No template available for this step"
        _finish(cc, "failed")
        return "failed"
    tpl = random.choice(choices)  # even random split

    msg_uuid = uuid.uuid4()
    same_thread = data.get("same_thread", True) and bool(cc.last_message_id)
    subject_src = tpl.subject
    if same_thread and not subject_src.strip():
        first = (await db.execute(
            select(Message.subject).where(Message.campaign_contact_id == cc.id).order_by(Message.sent_at.asc()).limit(1)
        )).scalar_one_or_none() or ""
        subject_src = first if first.lower().startswith("re:") else f"Re: {first}"
    if not subject_src.strip():
        subject_src = tpl.name  # never send a blank subject

    subject, html = renderer.render(
        subject_src, tpl.body_html, contact, message_id=msg_uuid,
        track_opens=tpl.track_opens, track_clicks=tpl.track_clicks,
        sender_name=mb.from_name, sender_email=mb.email, signature_html=mb.signature_html,
    )
    header_id = transport.new_message_id(mb)
    email = transport.build_message(
        mb, to=contact.email, subject=subject, html=html, text=renderer.html_to_text(html), message_id=header_id,
        in_reply_to=cc.last_message_id if same_thread else None,
        references=" ".join(filter(None, [cc.first_message_id, cc.last_message_id])) if same_thread else None,
        unsubscribe_url=renderer.unsubscribe_url(msg_uuid),
    )

    try:
        await transport.send(mb, email)
    except aiosmtplib.SMTPRecipientsRefused as e:
        db.add(Message(id=msg_uuid, user_id=ctx.user.id, campaign_id=camp.id, campaign_contact_id=cc.id,
                       contact_id=contact.id, mailbox_id=mb.id, template_id=tpl.id, node_id=node["id"],
                       to_email=contact.email, subject=subject, body_html=html, message_id_header=header_id,
                       status="bounced", error=str(e)[:500]))
        await _suppress(db, ctx.user.id, contact.email, "bounced")
        _finish(cc, "bounced")
        return "bounced"
    except (aiosmtplib.SMTPAuthenticationError, RuntimeError) as e:
        mb.status, mb.last_error = "error", f"{type(e).__name__}: {e}"[:500]
        return _defer(cc, now + timedelta(minutes=15))
    except Exception as e:  # noqa: BLE001 — transient network / server issues: retry later
        cc.error = f"{type(e).__name__}: {e}"[:500]
        log.warning("send failed for %s via %s: %s", contact.email, mb.email, e)
        return _defer(cc, now + timedelta(minutes=10))

    db.add(Message(
        id=msg_uuid, user_id=ctx.user.id, campaign_id=camp.id, campaign_contact_id=cc.id, contact_id=contact.id,
        mailbox_id=mb.id, template_id=tpl.id, node_id=node["id"], to_email=contact.email, subject=subject,
        body_html=html, message_id_header=header_id, in_reply_to=cc.last_message_id if same_thread else None,
        status="sent", sent_at=now,
    ))
    cc.mailbox_id = mb.id
    cc.first_message_id = cc.first_message_id or header_id
    cc.last_message_id = header_id
    cc.last_sent_at = now
    cc.steps_sent += 1
    cc.error = None
    mb.last_sent_at = now
    mb.last_error = None
    ctx.mb_sent_today[mb.id] = ctx.mb_sent_today.get(mb.id, 0) + 1
    ctx.mb_ready[mb.id] = now + timedelta(seconds=random.randint(mb.min_delay_seconds, max(mb.min_delay_seconds, mb.max_delay_seconds)))
    ctx.capacity -= 1
    ctx.campaign_sent_today += 1
    await limits.bump_usage(db, ctx.user.id, emails=1)
    return "sent"


async def _suppress(db: AsyncSession, user_id: uuid.UUID, email: str, reason: str) -> None:
    await db.execute(insert(Suppression).values(user_id=user_id, email=email.lower(), reason=reason).on_conflict_do_nothing())


# ── Reply & bounce detection (IMAP) ─────────────────────────────

MSGID_RE = re.compile(r"<[0-9a-f]{32}@[^>\s]+>")


async def poll_replies() -> None:
    async with async_session() as db:
        ids = (await db.execute(select(Mailbox.id).where(Mailbox.status != "paused"))).scalars().all()
    for mid in ids:
        try:
            await poll_mailbox(mid)
        except Exception as e:  # noqa: BLE001
            log.warning("imap poll failed for %s: %s", mid, e)


async def poll_mailbox(mailbox_id: uuid.UUID) -> int:
    import asyncio

    from app.models import Event

    async with async_session() as db:
        mb = await db.get(Mailbox, mailbox_id)
        if not mb:
            return 0
        conn = await transport.imap_conn(mb)
        if not conn:
            return 0
        items, last_uid = await asyncio.to_thread(transport.fetch_headers_since, conn, mb.imap_last_uid)
        handled = 0
        for it in items:
            candidates = [c for c in [it["in_reply_to"], *it["references"]] if c]
            sender = it["from"].lower()
            is_bounce = "mailer-daemon" in sender or "postmaster" in sender or it["content_type"] == "multipart/report"
            if is_bounce:
                candidates += MSGID_RE.findall(it["body"])
            if not candidates:
                continue
            msg = (await db.execute(
                select(Message).where(Message.user_id == mb.user_id, Message.message_id_header.in_(candidates)).limit(1)
            )).scalar_one_or_none()
            if not msg:
                continue
            cc = await db.get(CampaignContact, msg.campaign_contact_id) if msg.campaign_contact_id else None
            if is_bounce:
                msg.status = "bounced"
                db.add(Event(user_id=mb.user_id, message_id=msg.id, campaign_id=msg.campaign_id,
                             contact_id=msg.contact_id, kind="bounce", meta={"subject": it["subject"]}))
                await _suppress(db, mb.user_id, msg.to_email, "bounced")
                if cc and cc.state in LIVE_STATES:
                    _finish(cc, "bounced")
            elif it["auto_submitted"].startswith("auto-"):
                continue  # out-of-office / auto replies don't count as replies
            else:
                if not msg.replied_at:
                    msg.replied_at = utcnow()
                msg.reply_snippet = it["body"][:4000]
                db.add(Event(user_id=mb.user_id, message_id=msg.id, campaign_id=msg.campaign_id,
                             contact_id=msg.contact_id, kind="reply", meta={"from": it["from"], "subject": it["subject"]}))
                camp = await db.get(Campaign, msg.campaign_id) if msg.campaign_id else None
                if cc and cc.state in LIVE_STATES and (not camp or (camp.settings or {}).get("stop_on_reply", True)):
                    _finish(cc, "replied")
            handled += 1
        mb.imap_last_uid = last_uid
        await db.commit()
        return handled
