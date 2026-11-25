"""Lead research: queue website audits + keyword studies for selected leads and read the results."""

import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Contact, ContactList, SiteResearch, list_contacts
from app.services import keyword_planner, research, site_audit
from app.services import keywords as kw

router = APIRouter(prefix="/research", tags=["research"])

MAX_PER_REQUEST = 5000


class ResearchIn(BaseModel):
    contact_ids: list[uuid.UUID] = []
    list_id: uuid.UUID | None = None  # with all_in_list: every lead in the list
    all_in_list: bool = False
    rerun: bool = False  # research domains again even if they already have results
    use_email_domain: bool = True  # no website → use the email's domain (never gmail.com & co.)
    pagespeed: bool = False
    location_code: int | None = None
    use_lead_country: bool = True
    language_code: str = Field("en", max_length=8)


def out(r: SiteResearch, full: bool = True) -> dict:
    base = {
        "id": r.id, "domain": r.domain, "url": r.url, "status": r.status, "error": r.error, "score": r.score,
        "issue_count": len(r.issues or []), "metrics": r.metrics or {}, "researched_at": r.researched_at,
        "keywords": r.keywords or [], "summary": r.summary,
    }
    if full:
        base.update(final_url=r.final_url, issues=r.issues or [], facts=r.facts or {}, keyword_source=r.keyword_source,
                    metrics_source=r.metrics_source, metrics_error=r.metrics_error, options=r.options or {},
                    started_at=r.started_at)
    return base


@router.get("/catalog")
async def catalog():
    """Issue codes and metrics that research produces — used by the sequence builder's conditions."""
    return {
        "issues": [{"code": c, "severity": s, "category": cat, "title": t} for c, (s, cat, t) in site_audit.ISSUES.items()],
        "metrics": [{"key": k, "label": label, "unit": unit} for k, (label, unit) in research.METRICS.items()],
        "fields": [{"key": k, "label": label} for k, label in research.ENRICH_FIELDS],
        "default_location": kw.DEFAULT_LOCATION,
        "languages": list(kw.LANGUAGE_CONSTANTS),
    }


@router.post("")
async def start_research(body: ResearchIn, user: CurrentUser, db: DB):
    stmt = select(Contact).where(Contact.user_id == user.id)
    if body.all_in_list:
        if not body.list_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick a list")
        await get_owned(db, ContactList, body.list_id, user)
        stmt = stmt.join(list_contacts, list_contacts.c.contact_id == Contact.id).where(list_contacts.c.list_id == body.list_id)
    elif body.contact_ids:
        stmt = stmt.where(Contact.id.in_(body.contact_ids[:MAX_PER_REQUEST]))
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Select at least one lead")
    contacts = (await db.execute(stmt.limit(MAX_PER_REQUEST))).scalars().all()
    if not contacts:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No leads found")
    stats = await research.enqueue(
        db, user.id, list(contacts), rerun=body.rerun, use_email_domain=body.use_email_domain, pagespeed=body.pagespeed,
        location_code=body.location_code, use_lead_country=body.use_lead_country, language_code=body.language_code,
    )
    return stats


@router.get("/status")
async def research_status(user: CurrentUser, db: DB):
    rows = (await db.execute(select(SiteResearch.status, func.count()).where(SiteResearch.user_id == user.id)
                             .group_by(SiteResearch.status))).all()
    out = {s: n for s, n in rows}
    # Progress of the current batch: sites finished that were queued no earlier than the oldest one still waiting.
    queued_at = SiteResearch.options["queued_at"].astext
    since = (await db.execute(select(func.min(queued_at)).where(
        SiteResearch.user_id == user.id, SiteResearch.status.in_(("queued", "running"))))).scalar_one()
    if since:
        out["batch_finished"] = (await db.execute(select(func.count()).select_from(SiteResearch).where(
            SiteResearch.user_id == user.id, SiteResearch.status.in_(("done", "failed")), queued_at >= since,
        ))).scalar_one()
    return out


@router.post("/cancel")
async def cancel_research(user: CurrentUser, db: DB):
    return {"cancelled": await research.cancel(db, user.id)}


@router.get("/by-domain")
async def by_domains(domains: str, user: CurrentUser, db: DB):
    """Summaries for a comma-separated list of domains (the leads table asks for the domains on its page)."""
    names = [d.strip().lower() for d in domains.split(",") if d.strip()][:500]
    if not names:
        return {}
    rows = (await db.execute(select(SiteResearch).where(SiteResearch.user_id == user.id, SiteResearch.domain.in_(names)))).scalars()
    return {r.domain: out(r, full=False) for r in rows}


@router.get("/planner-keywords")
async def planner_keywords(user: CurrentUser, db: DB, list_id: uuid.UUID | None = None, missing_only: bool = False):
    """Every researched keyword (of a list) as one comma-separated line for Keyword Planner → Get search volume."""
    if list_id:
        await get_owned(db, ContactList, list_id, user)
    rows = await research.done_research_for(db, user.id, list_id)
    kws = keyword_planner.planner_line(research.keywords_of(rows, missing_only))
    chunks = [kws[i:i + keyword_planner.MAX_PER_PASTE] for i in range(0, len(kws), keyword_planner.MAX_PER_PASTE)]
    return {"sites": len(rows), "count": len(kws), "lines": [", ".join(c) for c in chunks]}


@router.post("/planner-import")
async def planner_import(user: CurrentUser, db: DB, file: UploadFile = File(...), list_id: str = Form("")):
    """Import the CSV Keyword Planner downloads; numbers go onto the matching keywords and leads are re-enriched."""
    lid = uuid.UUID(list_id) if list_id else None
    if lid:
        await get_owned(db, ContactList, lid, user)
    raw = await file.read()
    if len(raw) > 30 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "The file is larger than 30 MB")
    try:
        parsed = keyword_planner.parse_export(raw)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    return await research.apply_planner_export(db, user.id, parsed, lid)


@router.get("/{research_id}")
async def get_research(research_id: uuid.UUID, user: CurrentUser, db: DB):
    return out(await get_owned(db, SiteResearch, research_id, user))


@router.delete("/{research_id}", status_code=204)
async def delete_research(research_id: uuid.UUID, user: CurrentUser, db: DB):
    r = await get_owned(db, SiteResearch, research_id, user)
    await db.delete(r)
    await db.commit()
