"""Public tracking endpoints: open pixel, click redirect, one-click unsubscribe (RFC 8058)."""

import base64
from datetime import datetime, timezone
from urllib.parse import unquote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from sqlalchemy.dialects.postgresql import insert

from app.core.deps import DB
from app.core.tokens import verify_message
from app.models import CampaignContact, Contact, Event, Message, Suppression
from app.models.campaign import LIVE_STATES
from app.services.engagement import machine_reason

router = APIRouter(prefix="/t", tags=["tracking"])

PIXEL = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache"}

def _meta(req: Request) -> dict:
    return {"ip": req.client.host if req.client else None, "ua": (req.headers.get("user-agent") or "")[:300]}


def _classify(msg: Message, req: Request, now: datetime) -> dict:
    """Request metadata plus ``machine`` (reason) when the hit is automated rather than a person."""
    meta = _meta(req)
    reason = machine_reason(ua=meta["ua"], sent_at=msg.sent_at, at=now, referer=req.headers.get("referer"))
    if reason:
        meta["machine"] = reason
    return meta


@router.get("/o/{token}.gif")
async def open_pixel(token: str, request: Request, db: DB):
    mid = verify_message(token, "o")
    msg = await db.get(Message, mid) if mid else None
    if msg:
        now = datetime.now(timezone.utc)
        meta = _classify(msg, request, now)
        if "machine" not in meta:  # only people count as opens
            msg.open_count += 1
            msg.opened_at = msg.opened_at or now
        db.add(Event(user_id=msg.user_id, message_id=msg.id, campaign_id=msg.campaign_id, contact_id=msg.contact_id,
                     kind="open", meta=meta))
        await db.commit()
    return Response(content=PIXEL, media_type="image/gif", headers=NO_CACHE)


@router.get("/c/{token}")
async def click(token: str, u: str, request: Request, db: DB):
    url = unquote(u)
    mid = verify_message(token, url)
    if not mid or not url.lower().startswith(("http://", "https://")):
        return HTMLResponse("<h3>Invalid link</h3>", status_code=400)
    msg = await db.get(Message, mid)
    if msg:
        now = datetime.now(timezone.utc)
        meta = _classify(msg, request, now)
        if "machine" not in meta:  # link scanners click everything on delivery
            msg.click_count += 1
            msg.clicked_at = msg.clicked_at or now
            msg.opened_at = msg.opened_at or now  # a click implies an open (works even when images are blocked)
        db.add(Event(user_id=msg.user_id, message_id=msg.id, campaign_id=msg.campaign_id, contact_id=msg.contact_id,
                     kind="click", url=url, meta=meta))
        await db.commit()
    return RedirectResponse(url, status_code=302)


async def _unsubscribe(db, msg: Message, request: Request):
    await db.execute(insert(Suppression).values(user_id=msg.user_id, email=msg.to_email, reason="unsubscribed").on_conflict_do_nothing())
    if msg.contact_id:
        c = await db.get(Contact, msg.contact_id)
        if c:
            c.unsubscribed = True
    if msg.campaign_contact_id:
        cc = await db.get(CampaignContact, msg.campaign_contact_id)
        if cc and cc.state in LIVE_STATES:
            cc.state, cc.next_run_at = "unsubscribed", None
    db.add(Event(user_id=msg.user_id, message_id=msg.id, campaign_id=msg.campaign_id, contact_id=msg.contact_id,
                 kind="unsubscribe", meta=_meta(request)))
    await db.commit()


PAGE = """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>body{{font-family:system-ui,sans-serif;background:#f6f6f6;display:grid;place-items:center;
min-height:100vh;margin:0}}.c{{background:#fff;padding:32px 36px;border-radius:14px;max-width:420px;text-align:center;
box-shadow:0 10px 30px rgba(0,0,0,.08)}}button{{background:#111;color:#fff;border:0;border-radius:8px;padding:11px 22px;
font-size:15px;cursor:pointer}}p{{color:#555}}</style></head><body><div class="c">{body}</div></body></html>"""


@router.get("/u/{token}", response_class=HTMLResponse)
async def unsubscribe_page(token: str, db: DB):
    mid = verify_message(token, "u")
    msg = await db.get(Message, mid) if mid else None
    if not msg:
        return HTMLResponse(PAGE.format(title="Link expired", body="<h2>This link is no longer valid</h2>"), status_code=404)
    return PAGE.format(title="Unsubscribe", body=(
        f"<h2>Unsubscribe</h2><p>Stop receiving emails at <b>{msg.to_email}</b>?</p>"
        f'<form method="post"><button type="submit">Unsubscribe</button></form>'
    ))


@router.post("/u/{token}", response_class=HTMLResponse)
async def unsubscribe(token: str, request: Request, db: DB):
    """Handles both the confirmation form and RFC 8058 one-click POSTs from mail clients."""
    mid = verify_message(token, "u")
    msg = await db.get(Message, mid) if mid else None
    if msg:
        await _unsubscribe(db, msg, request)
    return PAGE.format(title="Unsubscribed", body="<h2>You're unsubscribed</h2><p>You won't receive further emails from this sender.</p>")
