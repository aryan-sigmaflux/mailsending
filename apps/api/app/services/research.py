"""Lead research jobs: audit each lead's website, find 5 product/service keywords, look up their search volume and
bids, then enrich the leads.

* One ``site_research`` row per (user, domain) — 10 leads at the same company cost one audit.
* Queued rows are picked up by the worker (``tick``) with SKIP LOCKED, so several workers are safe and a restart
  just resumes: rows stuck in "running" for longer than STALE_MINUTES are queued again.
* When a domain finishes, every lead pointing at it (``contacts.research_domain``) gets template variables in its
  custom fields (ENRICH_FIELDS), and sequence conditions can branch on the row's ``issues`` and ``metrics``.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update

from app.core.crypto import decrypt_str
from app.database import async_session
from app.models import Contact, Integration, SiteResearch
from app.services import keywords as kw
from app.services import site_audit

log = logging.getLogger("research")

CONCURRENCY = 4
STALE_MINUTES = 15
KEYWORD_COUNT = 5

# Numbers a sequence condition can compare ("metric" check). key → (label, unit)
METRICS: dict[str, tuple[str, str]] = {
    "site_score": ("Website score (0–100)", ""),
    "issue_count": ("Number of website issues", ""),
    "high_issue_count": ("Number of high-severity issues", ""),
    "performance_score": ("Mobile PageSpeed score (0–100)", ""),
    "keyword_volume_max": ("Top keyword monthly searches (smart + basic)", "searches/mo"),
    "keyword_volume_total": ("All keywords: total monthly searches", "searches/mo"),
    "smart_volume_max": ("Top smart (AI) keyword monthly searches", "searches/mo"),
    "smart_volume_total": ("Smart (AI) keywords: total monthly searches", "searches/mo"),
    "bid_high_max": ("Highest top-of-page bid (high range)", "currency"),
    "bid_low_max": ("Highest top-of-page bid (low range)", "currency"),
    "cpc_max": ("Highest average CPC", "currency"),
    "competition_index": ("Top keyword competition (0–100)", ""),
}

# Template variables written onto each researched lead (custom fields → {{SiteScore}}, {{TopKeyword}}, …).
ENRICH_FIELDS = [
    ("site_score", "Website score (0–100)"), ("site_issue_count", "Number of website issues"),
    ("top_issue", "Most serious website issue"), ("site_issues", "All website issues (comma separated)"),
    ("site_summary", "What the business sells (AI)"), ("top_keyword", "Highest-volume keyword"),
    ("top_keyword_volume", "Top keyword monthly searches"), ("top_keyword_cpc", "Top keyword top-of-page bid"),
    ("keywords_total_volume", "Total monthly searches of all keywords"),
    *[(f"smart_keyword_{i}", f"Smart keyword {i} (AI)") for i in range(1, KEYWORD_COUNT + 1)],
    *[(f"keyword_{i}", f"Keyword {i} (from page headings)") for i in range(1, KEYWORD_COUNT + 1)],
    ("pagespeed_score", "Mobile PageSpeed score"),
]

# Every keyword row has "set": "smart" (AI reads the website) or "basic" (phrases from the page's title/headings).
# Smart keywords are skipped when the user has no AI provider; basic ones are always there.


def kw_set(r: SiteResearch, k: dict) -> str:
    """Rows saved before keyword sets existed: the old single list was AI-made when keyword_source was "ai"."""
    return k.get("set") or ("smart" if r.keyword_source == "ai" else "basic")


def _unique(rows: list[dict]) -> list[dict]:
    """The same keyword can be in both sets; count it once."""
    seen, out = set(), []
    for k in rows:
        key = (k.get("keyword") or "").strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(k)
    return out


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── Derived data ─────────────────────────────────────────────────────────────

def compute_metrics(score: int | None, issues: list[dict], facts: dict, keywords: list[dict]) -> dict:
    keywords = _unique(keywords)
    vols = [k["volume"] for k in keywords if k.get("volume") is not None]
    smart = [k["volume"] for k in keywords if k.get("set") == "smart" and k.get("volume") is not None]
    top = max((k for k in keywords if k.get("volume") is not None), key=lambda k: k["volume"], default=None)
    mx = lambda key: max((k[key] for k in keywords if k.get(key) is not None), default=None)  # noqa: E731
    return {
        "smart_volume_max": max(smart) if smart else None,
        "smart_volume_total": sum(smart) if smart else None,
        "site_score": score,
        "issue_count": len(issues),
        "high_issue_count": sum(1 for i in issues if i["severity"] == "high"),
        "performance_score": (facts.get("pagespeed") or {}).get("score"),
        "keyword_volume_max": max(vols) if vols else None,
        "keyword_volume_total": sum(vols) if vols else None,
        "bid_high_max": mx("high_bid"),
        "bid_low_max": mx("low_bid"),
        "cpc_max": mx("cpc"),
        "competition_index": top.get("competition_index") if top else None,
    }


def _fmt(n) -> str:
    if n is None:
        return ""
    return f"{n:,.2f}".rstrip("0").rstrip(".") if isinstance(n, float) else f"{n:,}"


def enrich_values(r: SiteResearch) -> dict[str, str]:
    issues, kws = r.issues or [], r.keywords or []
    top = max((k for k in kws if k.get("volume") is not None), key=lambda k: k["volume"], default=kws[0] if kws else None)
    m = r.metrics or {}
    vals = {
        "site_score": "" if r.score is None else str(r.score),
        "site_issue_count": str(len(issues)),
        "top_issue": issues[0]["title"] if issues else "",
        "site_issues": ", ".join(i["title"] for i in issues),
        "site_summary": r.summary or "",
        "top_keyword": (top or {}).get("keyword", ""),
        "top_keyword_volume": _fmt((top or {}).get("volume")),
        "top_keyword_cpc": _fmt((top or {}).get("high_bid") or (top or {}).get("cpc")),
        "keywords_total_volume": _fmt(m.get("keyword_volume_total")),
        "pagespeed_score": _fmt(m.get("performance_score")),
    }
    smart = [k["keyword"] for k in kws if kw_set(r, k) == "smart"]
    basic = [k["keyword"] for k in kws if kw_set(r, k) == "basic"]
    for i in range(KEYWORD_COUNT):
        vals[f"smart_keyword_{i + 1}"] = smart[i] if i < len(smart) else ""
        vals[f"keyword_{i + 1}"] = basic[i] if i < len(basic) else ""
    return vals


async def enrich_contacts(db, r: SiteResearch) -> int:
    """Copy the research onto every lead that points at this domain (no commit)."""
    vals = enrich_values(r)
    contacts = (await db.execute(select(Contact).where(Contact.user_id == r.user_id, Contact.research_domain == r.domain))).scalars().all()
    for c in contacts:
        c.fields = {**(c.fields or {}), **vals}
    return len(contacts)


# ── Queueing ─────────────────────────────────────────────────────────────────

async def enqueue(db, user_id: uuid.UUID, contacts: list[Contact], *, rerun: bool, use_email_domain: bool,
                  pagespeed: bool, location_code: int | None, use_lead_country: bool, language_code: str) -> dict:
    """Point each lead at its domain and queue the domains that need researching (commits)."""
    stats = {"leads": len(contacts), "queued": 0, "already_done": 0, "in_progress": 0, "no_website": 0}
    by_domain: dict[str, tuple[str, list[Contact]]] = {}
    for c in contacts:
        got = site_audit.domain_for(c.website, c.email, use_email_domain)
        if not got:
            stats["no_website"] += 1
            continue
        domain, host = got
        c.research_domain = domain
        by_domain.setdefault(domain, (host, []))[1].append(c)

    existing = {r.domain: r for r in (await db.execute(
        select(SiteResearch).where(SiteResearch.user_id == user_id, SiteResearch.domain.in_(list(by_domain)))
    )).scalars()} if by_domain else {}

    queued_at = utcnow().isoformat()  # ISO strings sort by time; /research/status uses it for batch progress
    for domain, (host, leads) in by_domain.items():
        loc = (kw.location_for_country(next((c.country for c in leads if c.country), "")) if use_lead_country else None) or location_code
        opts = {"pagespeed": pagespeed, "location_code": loc, "language_code": language_code, "host": host, "queued_at": queued_at}
        r = existing.get(domain)
        if r and r.status in ("queued", "running"):
            stats["in_progress"] += 1
            continue
        if r and r.status == "done" and not rerun:
            stats["already_done"] += 1
            continue
        if not r:
            r = SiteResearch(user_id=user_id, domain=domain)
            db.add(r)
        r.url, r.status, r.options, r.error, r.started_at = f"https://{host}/", "queued", opts, None, None
        stats["queued"] += 1
    await db.flush()
    # Leads on a domain that was already researched get the data right away.
    for domain, r in existing.items():
        if r.status == "done":
            await enrich_contacts(db, r)
    await db.commit()
    return stats


async def cancel(db, user_id: uuid.UUID) -> int:
    res = await db.execute(update(SiteResearch).where(SiteResearch.user_id == user_id, SiteResearch.status == "queued")
                           .values(status="cancelled"))
    await db.commit()
    return res.rowcount or 0


# ── Keyword Planner round trip (manual) ──────────────────────────────────────

async def done_research_for(db, user_id: uuid.UUID, list_id: uuid.UUID | None) -> list[SiteResearch]:
    """Finished research rows — of the leads in a list, or all of the user's when list_id is None."""
    from app.models import list_contacts

    stmt = select(SiteResearch).where(SiteResearch.user_id == user_id, SiteResearch.status == "done")
    if list_id:
        domains = (select(Contact.research_domain).join(list_contacts, list_contacts.c.contact_id == Contact.id)
                   .where(list_contacts.c.list_id == list_id, Contact.user_id == user_id, Contact.research_domain.is_not(None)))
        stmt = stmt.where(SiteResearch.domain.in_(domains))
    return list((await db.execute(stmt.order_by(SiteResearch.domain))).scalars())


def keywords_of(rows: list[SiteResearch], missing_only: bool = False) -> list[str]:
    out: list[str] = []
    for r in rows:
        for k in r.keywords or []:
            if k.get("keyword") and not (missing_only and k.get("volume") is not None):
                out.append(k["keyword"])
    return out


async def apply_planner_export(db, user_id: uuid.UUID, parsed: dict, list_id: uuid.UUID | None) -> dict:
    """Write Keyword Planner numbers onto every matching researched keyword, recompute metrics, enrich leads (commits)."""
    from app.services import keyword_planner as kp

    planner = parsed["rows"]
    stats = {"export_keywords": len(planner), "matched_keywords": 0, "unmatched_keywords": 0, "sites_updated": 0,
             "leads_enriched": 0, "currency": parsed.get("currency"), "period": parsed.get("period")}
    matched_norms: set[str] = set()
    for r in await done_research_for(db, user_id, list_id):
        changed = False
        rows = []
        for k in r.keywords or []:
            hit = planner.get(kp.norm(k.get("keyword", "")))
            if hit:
                k = {"keyword": k["keyword"], "set": kw_set(r, k), **hit, "source": "keyword_planner_csv"}
                matched_norms.add(kp.norm(k["keyword"]))
                changed = True
            elif k.get("keyword"):
                stats["unmatched_keywords"] += 1
            rows.append(k)
        if not changed:
            continue
        r.keywords = rows
        r.metrics = compute_metrics(r.score, r.issues or [], r.facts or {}, rows)
        r.metrics_source = "keyword_planner_csv"
        r.metrics_error = None
        stats["sites_updated"] += 1
        stats["leads_enriched"] += await enrich_contacts(db, r)
    stats["matched_keywords"] = len(matched_norms)
    await db.commit()
    return stats


# ── Worker ───────────────────────────────────────────────────────────────────

async def _integration(db, user_id: uuid.UUID, kind: str) -> Integration | None:
    rows = (await db.execute(select(Integration).where(Integration.user_id == user_id, Integration.kind == kind)
                             .order_by(Integration.is_default.desc(), Integration.created_at))).scalars().all()
    return rows[0] if rows else None


async def process(rid: uuid.UUID) -> None:
    async with async_session() as db:
        r = await db.get(SiteResearch, rid)
        if not r or r.status != "running":
            return
        user_id, opts, domain = r.user_id, r.options or {}, r.domain
        ai_i = await _integration(db, user_id, "ai")
        kw_i = await _integration(db, user_id, "keywords")
        ps_i = await _integration(db, user_id, "pagespeed")
        ai_cfg = {"provider": ai_i.provider, "api_key": decrypt_str(ai_i.secret_enc), **(ai_i.config or {})} if ai_i and ai_i.secret_enc else None
        kw_cfg = (kw_i.provider, kw_i.config or {}, decrypt_str(kw_i.secret_enc)) if kw_i and kw_i.secret_enc else None
        ps_key = decrypt_str(ps_i.secret_enc) if ps_i and ps_i.secret_enc else None

    try:
        res = await site_audit.audit(opts.get("host") or domain, run_pagespeed=bool(opts.get("pagespeed")), pagespeed_key=ps_key)
    except Exception as e:  # noqa: BLE001
        log.exception("audit of %s failed", domain)
        async with async_session() as db:
            r = await db.get(SiteResearch, rid)
            if r:
                r.status, r.error = "failed", f"{type(e).__name__}: {e}"[:500]
                await db.commit()
        return

    facts = res["facts"]
    summary, smart, basic, metrics_source, metrics_error = "", [], [], "", None
    if res["text"] or facts.get("title"):
        # Smart keywords: the AI reads the website. Skipped when the user has no AI provider.
        if ai_cfg:
            try:
                summary, smart = await kw.ai_keywords(ai_cfg, domain, facts, res["text"], res["extra_texts"], KEYWORD_COUNT)
            except Exception as e:  # noqa: BLE001 — basic keywords still get made
                log.warning("AI keywords for %s failed: %s", domain, e)
                facts["smart_error"] = f"{type(e).__name__}: {str(e)[:200]}"
        else:
            facts["smart_error"] = "no_ai"
        # Basic keywords: phrases from the page title / headings — always.
        basic = kw.heuristic_keywords(facts.get("title") or "", facts.get("headings") or [], facts.get("meta_description") or "",
                                      res["text"], domain.split(".")[0], KEYWORD_COUNT)
    kw_source = "+".join(s for s, lst in (("ai", smart), ("heuristic", basic)) if lst)
    kw_list = list(dict.fromkeys([*smart, *basic]))  # one lookup per distinct keyword

    rows = [{"keyword": k, "set": "smart"} for k in smart] + [{"keyword": k, "set": "basic"} for k in basic]
    if kw_list and kw_cfg:
        provider, cfg, secret = kw_cfg
        try:
            found = await kw.metrics(provider, cfg, secret, kw_list, opts.get("location_code") or cfg.get("location_code") or kw.DEFAULT_LOCATION,
                                     opts.get("language_code") or cfg.get("language_code") or kw.DEFAULT_LANGUAGE)
            by_kw = {m["keyword"].lower(): m for m in found}
            rows = [{**by_kw.get(r_["keyword"].lower(), {}), **r_} for r_ in rows]
            metrics_source = provider
        except Exception as e:  # noqa: BLE001
            log.warning("keyword metrics for %s failed: %s", domain, e)
            metrics_error = f"{type(e).__name__}: {str(e)[:300]}"

    async with async_session() as db:
        r = await db.get(SiteResearch, rid)
        if not r or r.status != "running":  # cancelled / deleted meanwhile
            return
        r.final_url, r.score, r.issues, r.facts = res["final_url"], res["score"], res["issues"], json.loads(json.dumps(facts, default=str))
        r.summary, r.keywords, r.keyword_source = summary, rows, kw_source
        r.metrics_source, r.metrics_error = metrics_source, metrics_error
        r.metrics = compute_metrics(res["score"], res["issues"], facts, rows)
        r.status, r.error, r.researched_at = "done", None, utcnow()
        await enrich_contacts(db, r)
        await db.commit()
    log.info("researched %s: score %s, %d issues, keywords %s", domain, res["score"], len(res["issues"]), kw_list)


async def tick() -> None:
    async with async_session() as db:
        await db.execute(update(SiteResearch).where(
            SiteResearch.status == "running", SiteResearch.started_at < utcnow() - timedelta(minutes=STALE_MINUTES),
        ).values(status="queued"))
        claimed = (await db.execute(
            select(SiteResearch).where(SiteResearch.status == "queued").order_by(SiteResearch.updated_at)
            .limit(CONCURRENCY * 2).with_for_update(skip_locked=True)
        )).scalars().all()
        for r in claimed:
            r.status, r.started_at = "running", utcnow()
        ids = [r.id for r in claimed]
        await db.commit()
    if not ids:
        return
    sem = asyncio.Semaphore(CONCURRENCY)

    async def one(rid):
        async with sem:
            try:
                await process(rid)
            except Exception:  # noqa: BLE001
                log.exception("research %s crashed", rid)

    await asyncio.gather(*(one(i) for i in ids))


# ── Sequence conditions ──────────────────────────────────────────────────────

def _cmp(a: float, op: str, b: float) -> bool:
    return {"lt": a < b, "lte": a <= b, "gt": a > b, "gte": a >= b, "eq": a == b, "neq": a != b}.get(op, False)


def research_condition(r: SiteResearch | None, data: dict) -> bool:
    """Leads without finished research take the "No" branch of every research check."""
    check = data.get("check")
    done = r is not None and r.status == "done"
    if check == "researched":
        return done
    if not done:
        return False
    if check == "site_issue":
        want = set(data.get("issues") or [])
        have = {i["code"] for i in r.issues or []}
        if not want:
            return False
        return want <= have if data.get("match") == "all" else bool(want & have)
    if check == "metric":
        v = (r.metrics or {}).get(data.get("metric"))
        try:
            return v is not None and _cmp(float(v), data.get("op", "lt"), float(data.get("value")))
        except (TypeError, ValueError):
            return False
    return False


def field_condition(ctx: dict[str, str], data: dict) -> bool:
    """check "field": compare any lead value (standard, CSV, Apollo or research field)."""
    from app.services.renderer import lookup

    v = (lookup(ctx, data.get("field") or "") or "").strip()
    target = str(data.get("value") or "").strip()
    op = data.get("op", "equals")
    if op == "empty":
        return not v
    if op == "not_empty":
        return bool(v)
    if op == "equals":
        return v.lower() == target.lower()
    if op == "not_equals":
        return v.lower() != target.lower()
    if op == "contains":
        return bool(target) and target.lower() in v.lower()
    if op in ("lt", "lte", "gt", "gte"):
        try:
            return _cmp(float(v.replace(",", "")), op, float(target.replace(",", "")))
        except ValueError:
            return False
    return False
