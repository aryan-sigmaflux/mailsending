import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Campaign, CampaignContact, Contact, ContactList, Mailbox, Message, Sequence, Suppression, Template, list_contacts
from app.models.campaign import DEFAULT_SCHEDULE, DEFAULT_SETTINGS, LIVE_STATES
from app.schemas import ORM
from app.services import graph as g
from app.services import limits, renderer

router = APIRouter(prefix="/campaigns", tags=["campaigns"])


class CampaignIn(BaseModel):
    name: str
    kind: str = Field("single", pattern="^(single|sequence)$")
    sequence_id: uuid.UUID | None = None
    template_ids: list[uuid.UUID] = []
    list_ids: list[uuid.UUID] = []
    mailbox_ids: list[uuid.UUID] = []
    schedule: dict = {}
    settings: dict = {}


class CampaignOut(ORM):
    id: uuid.UUID
    name: str
    kind: str
    status: str
    sequence_id: uuid.UUID | None
    template_ids: list
    list_ids: list
    mailbox_ids: list
    schedule: dict
    settings: dict
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    stats: dict = {}


class LaunchIn(BaseModel):
    missing_policy: str = Field("fallback", pattern="^(fallback|skip|block)$")


async def _stats(db, ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    if not ids:
        return {}
    out: dict[uuid.UUID, dict] = {i: {"contacts": 0, "live": 0, "sent": 0, "opened": 0, "clicked": 0, "replied": 0, "bounced": 0} for i in ids}
    for cid, state, n in (await db.execute(
        select(CampaignContact.campaign_id, CampaignContact.state, func.count())
        .where(CampaignContact.campaign_id.in_(ids)).group_by(CampaignContact.campaign_id, CampaignContact.state)
    )).all():
        out[cid]["contacts"] += n
        if state in LIVE_STATES:
            out[cid]["live"] += n
    for cid, sent, opened, clicked, replied, bounced in (await db.execute(
        select(
            Message.campaign_id,
            func.count().filter(Message.status != "failed"),
            func.count(Message.opened_at), func.count(Message.clicked_at), func.count(Message.replied_at),
            func.count().filter(Message.status == "bounced"),
        ).where(Message.campaign_id.in_(ids)).group_by(Message.campaign_id)
    )).all():
        out[cid].update(sent=sent, opened=opened, clicked=clicked, replied=replied, bounced=bounced)
    return out


async def _out(db, items: list[Campaign]) -> list[CampaignOut]:
    stats = await _stats(db, [c.id for c in items])
    return [CampaignOut.model_validate(c).model_copy(update={"stats": stats.get(c.id, {})}) for c in items]


async def _check_refs(db, user, body: CampaignIn):
    for lid in body.list_ids:
        await get_owned(db, ContactList, lid, user)
    for mid in body.mailbox_ids:
        await get_owned(db, Mailbox, mid, user)
    for tid in body.template_ids:
        await get_owned(db, Template, tid, user)
    if body.sequence_id:
        await get_owned(db, Sequence, body.sequence_id, user)


def _apply(c: Campaign, body: CampaignIn):
    c.name = body.name.strip() or "Untitled campaign"
    c.kind = body.kind
    c.sequence_id = body.sequence_id if body.kind == "sequence" else None
    c.template_ids = [str(t) for t in body.template_ids]
    c.list_ids = [str(i) for i in body.list_ids]
    c.mailbox_ids = [str(i) for i in body.mailbox_ids]
    c.schedule = {**DEFAULT_SCHEDULE, **(c.schedule or {}), **body.schedule}
    c.settings = {**DEFAULT_SETTINGS, **(c.settings or {}), **body.settings}


@router.get("", response_model=list[CampaignOut])
async def list_campaigns(user: CurrentUser, db: DB, status_filter: str = Query("", alias="status")):
    stmt = select(Campaign).where(Campaign.user_id == user.id).order_by(Campaign.created_at.desc())
    if status_filter:
        stmt = stmt.where(Campaign.status == status_filter)
    return await _out(db, list((await db.execute(stmt)).scalars().all()))


@router.post("", response_model=CampaignOut, status_code=201)
async def create_campaign(body: CampaignIn, user: CurrentUser, db: DB):
    await _check_refs(db, user, body)
    c = Campaign(user_id=user.id)
    _apply(c, body)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return (await _out(db, [c]))[0]


@router.get("/{campaign_id}", response_model=CampaignOut)
async def get_campaign(campaign_id: uuid.UUID, user: CurrentUser, db: DB):
    return (await _out(db, [await get_owned(db, Campaign, campaign_id, user)]))[0]


@router.put("/{campaign_id}", response_model=CampaignOut)
async def update_campaign(campaign_id: uuid.UUID, body: CampaignIn, user: CurrentUser, db: DB):
    c = await get_owned(db, Campaign, campaign_id, user)
    await _check_refs(db, user, body)
    if c.status in ("running", "completed"):
        # Only safe fields may change on a live campaign.
        c.name = body.name.strip() or c.name
        c.mailbox_ids = [str(i) for i in body.mailbox_ids] or c.mailbox_ids
        c.schedule = {**c.schedule, **body.schedule}
        c.settings = {**c.settings, **body.settings}
    else:
        _apply(c, body)
    await db.commit()
    await db.refresh(c)
    return (await _out(db, [c]))[0]


async def _resolve_graph(db, user, c: Campaign) -> tuple[dict, list[str]]:
    if c.kind == "sequence":
        if not c.sequence_id:
            return {}, ["Choose a sequence"]
        seq = await get_owned(db, Sequence, c.sequence_id, user)
        tids = {str(i) for i in (await db.execute(select(Template.id).where(Template.user_id == user.id))).scalars()}
        return seq.graph, g.validate(seq.graph, tids)
    if not c.template_ids:
        return {}, ["Choose at least one template"]
    return g.single_template_graph(c.template_ids), []


async def _audience(db, user, c: Campaign) -> list[Contact]:
    if not c.list_ids:
        return []
    ids = [uuid.UUID(i) for i in c.list_ids]
    suppressed = select(Suppression.email).where(Suppression.user_id == user.id)
    stmt = (
        select(Contact).join(list_contacts, list_contacts.c.contact_id == Contact.id)
        .where(list_contacts.c.list_id.in_(ids), Contact.user_id == user.id, Contact.unsubscribed.is_(False),
               Contact.verify_status != "invalid", Contact.email.not_in(suppressed))
        .distinct()
    )
    return list((await db.execute(stmt)).scalars().all())


@router.post("/{campaign_id}/preflight")
async def preflight(campaign_id: uuid.UUID, user: CurrentUser, db: DB):
    """Everything that would block or degrade a launch, plus the missing-variable report."""
    c = await get_owned(db, Campaign, campaign_id, user)
    graph, errors = await _resolve_graph(db, user, c)
    if not c.mailbox_ids:
        errors.append("Choose at least one sending mailbox")
    if not c.list_ids:
        errors.append("Choose at least one lead list")
    mbs = (await db.execute(select(Mailbox).where(Mailbox.id.in_([uuid.UUID(m) for m in c.mailbox_ids or []])))).scalars().all()
    if mbs and all(m.status != "active" for m in mbs):
        errors.append("None of the selected mailboxes are healthy")
    contacts = await _audience(db, user, c)
    if c.list_ids and not contacts:
        errors.append("The selected lists have no sendable contacts")

    templates = (await db.execute(select(Template).where(Template.id.in_([uuid.UUID(t) for t in g.template_ids_in(graph)])))).scalars().all() if graph else []
    by_id = {str(t.id): t for t in templates}
    for node in g.first_send_nodes(graph) if graph else []:
        for tid in (node.get("data") or {}).get("template_ids") or []:
            t = by_id.get(tid)
            if t and not t.subject.strip():
                errors.append(f"Template '{t.name}' has no subject but can be sent as a first email")
    variables = sorted({v for t in templates for v in (t.variables or [])})
    missing: dict[str, int] = {}
    leads_missing = 0
    for ct in contacts:
        miss = renderer.missing_variables(variables, renderer.contact_context(ct))
        if miss:
            leads_missing += 1
            for v in miss:
                missing[v] = missing.get(v, 0) + 1
    return {
        "errors": errors,
        "audience": len(contacts),
        "variables": variables,
        "missing": [{"variable": k, "leads": n} for k, n in sorted(missing.items(), key=lambda x: -x[1])],
        "leads_missing": leads_missing,
        "capacity_today": await limits.sending_capacity(db, user),
        "mailbox_capacity_per_day": sum(m.daily_limit for m in mbs if m.status == "active"),
    }


@router.post("/{campaign_id}/launch", response_model=CampaignOut)
async def launch(campaign_id: uuid.UUID, body: LaunchIn, user: CurrentUser, db: DB):
    c = await get_owned(db, Campaign, campaign_id, user)
    if c.status not in ("draft", "paused"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Campaign is {c.status}")
    report = await preflight(campaign_id, user, db)
    if report["errors"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "; ".join(report["errors"]))
    if body.missing_policy == "block" and report["leads_missing"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{report['leads_missing']} leads are missing template variables")
    if c.status == "draft":
        await limits.ensure_can_launch_campaign(db, user)
        graph, _ = await _resolve_graph(db, user, c)
        c.graph_snapshot = graph
        templates = (await db.execute(select(Template).where(Template.id.in_([uuid.UUID(t) for t in g.template_ids_in(graph)])))).scalars().all()
        variables = sorted({v for t in templates for v in (t.variables or [])})
        for ct in await _audience(db, user, c):
            if body.missing_policy == "skip" and renderer.missing_variables(variables, renderer.contact_context(ct)):
                continue
            await db.execute(insert(CampaignContact).values(
                id=uuid.uuid4(), campaign_id=c.id, contact_id=ct.id, user_id=user.id, state="pending",
            ).on_conflict_do_nothing())
        c.started_at = datetime.now(timezone.utc)
    c.status = "running"
    await db.commit()
    await db.refresh(c)
    return (await _out(db, [c]))[0]


@router.post("/{campaign_id}/pause", response_model=CampaignOut)
async def pause(campaign_id: uuid.UUID, user: CurrentUser, db: DB):
    c = await get_owned(db, Campaign, campaign_id, user)
    if c.status != "running":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Campaign isn't running")
    c.status = "paused"
    await db.commit()
    return (await _out(db, [c]))[0]


@router.post("/{campaign_id}/duplicate", response_model=CampaignOut, status_code=201)
async def duplicate(campaign_id: uuid.UUID, user: CurrentUser, db: DB):
    src = await get_owned(db, Campaign, campaign_id, user)
    c = Campaign(user_id=user.id, name=f"{src.name} (copy)", kind=src.kind, sequence_id=src.sequence_id,
                 template_ids=src.template_ids, list_ids=src.list_ids, mailbox_ids=src.mailbox_ids,
                 schedule=src.schedule, settings=src.settings)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return (await _out(db, [c]))[0]


@router.delete("/{campaign_id}", status_code=204)
async def delete_campaign(campaign_id: uuid.UUID, user: CurrentUser, db: DB):
    c = await get_owned(db, Campaign, campaign_id, user)
    await db.delete(c)
    await db.commit()


@router.get("/{campaign_id}/contacts")
async def campaign_contacts(campaign_id: uuid.UUID, user: CurrentUser, db: DB,
                            state: str = "", page: int = Query(1, ge=1), size: int = Query(50, le=200)):
    await get_owned(db, Campaign, campaign_id, user)
    stmt = (select(CampaignContact, Contact.email, Contact.first_name, Contact.company)
            .join(Contact, Contact.id == CampaignContact.contact_id).where(CampaignContact.campaign_id == campaign_id))
    if state:
        stmt = stmt.where(CampaignContact.state == state)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(CampaignContact.updated_at.desc()).offset((page - 1) * size).limit(size))).all()
    return {"total": total, "items": [
        {"id": cc.id, "email": email, "first_name": fn, "company": co, "state": cc.state, "current_node": cc.current_node,
         "next_run_at": cc.next_run_at, "steps_sent": cc.steps_sent, "last_sent_at": cc.last_sent_at, "error": cc.error}
        for cc, email, fn, co in rows
    ]}


@router.get("/{campaign_id}/messages")
async def campaign_messages(campaign_id: uuid.UUID, user: CurrentUser, db: DB, page: int = Query(1, ge=1), size: int = Query(50, le=200)):
    await get_owned(db, Campaign, campaign_id, user)
    stmt = select(Message).where(Message.campaign_id == campaign_id)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(Message.sent_at.desc()).offset((page - 1) * size).limit(size))).scalars().all()
    return {"total": total, "items": [
        {"id": m.id, "to": m.to_email, "subject": m.subject, "status": m.status, "sent_at": m.sent_at,
         "opened_at": m.opened_at, "clicked_at": m.clicked_at, "replied_at": m.replied_at, "node_id": m.node_id,
         "template_id": m.template_id, "open_count": m.open_count, "click_count": m.click_count}
        for m in rows
    ]}


@router.get("/{campaign_id}/steps")
async def step_stats(campaign_id: uuid.UUID, user: CurrentUser, db: DB):
    """Per-node and per-template performance (shows how each random template variant performs)."""
    await get_owned(db, Campaign, campaign_id, user)
    rows = (await db.execute(
        select(Message.node_id, Message.template_id, Template.name, func.count(),
               func.count(Message.opened_at), func.count(Message.clicked_at), func.count(Message.replied_at))
        .outerjoin(Template, Template.id == Message.template_id)
        .where(Message.campaign_id == campaign_id).group_by(Message.node_id, Message.template_id, Template.name)
    )).all()
    return [{"node_id": n, "template_id": t, "template": name, "sent": s, "opened": o, "clicked": c, "replied": r}
            for n, t, name, s, o, c, r in rows]
