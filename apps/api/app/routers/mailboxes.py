import uuid
from datetime import date, datetime, timezone
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select

from app.config import settings
from app.core.crypto import decrypt_json, encrypt_json
from app.core.deps import DB, CurrentUser, get_owned
from app.core.security import create_state_token, decode_token
from app.models import Domain, Mailbox, Message, User
from app.models.mailing import DEFAULT_WARMUP
from app.schemas import ORM
from app.services import limits, oauth, transport

router = APIRouter(prefix="/mailboxes", tags=["mailboxes"])


class SmtpIn(BaseModel):
    email: EmailStr
    from_name: str = ""
    smtp_host: str
    smtp_port: int = 465
    smtp_security: str = "ssl"
    smtp_username: str | None = None
    smtp_password: str
    imap_host: str | None = None
    imap_port: int | None = 993
    imap_security: str = "ssl"
    imap_username: str | None = None
    imap_password: str | None = None  # defaults to the SMTP password
    daily_limit: int = Field(40, ge=1, le=2000)
    test: bool = True


class MailboxUpdate(BaseModel):
    from_name: str | None = None
    signature_html: str | None = None
    daily_limit: int | None = Field(None, ge=1, le=2000)
    min_delay_seconds: int | None = Field(None, ge=0, le=86400)
    max_delay_seconds: int | None = Field(None, ge=0, le=86400)
    warmup_enabled: bool | None = None
    warmup: dict | None = None
    status: str | None = None
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_security: str | None = None
    smtp_username: str | None = None
    smtp_password: str | None = None
    imap_host: str | None = None
    imap_port: int | None = None
    imap_security: str | None = None
    imap_username: str | None = None
    imap_password: str | None = None


class MailboxOut(ORM):
    id: uuid.UUID
    provider: str
    email: str
    from_name: str
    signature_html: str
    domain_id: uuid.UUID | None
    smtp_host: str | None
    smtp_port: int | None
    smtp_security: str
    smtp_username: str | None
    imap_host: str | None
    imap_port: int | None
    imap_security: str
    imap_username: str | None
    daily_limit: int
    min_delay_seconds: int
    max_delay_seconds: int
    warmup_enabled: bool
    warmup: dict
    status: str
    last_error: str | None
    health_score: int
    last_sent_at: datetime | None
    created_at: datetime
    warmup_started_at: datetime | None = None
    sent_today: int = 0


async def _with_counts(db, items: list[Mailbox]) -> list[MailboxOut]:
    start = datetime.combine(date.today(), datetime.min.time(), timezone.utc)
    ids = [m.id for m in items]
    counts = dict((await db.execute(
        select(Message.mailbox_id, func.count()).where(Message.mailbox_id.in_(ids), Message.sent_at >= start).group_by(Message.mailbox_id)
    )).all()) if ids else {}
    return [MailboxOut.model_validate(m).model_copy(update={"sent_today": counts.get(m.id, 0)}) for m in items]


async def _link_domain(db, user: User, mb: Mailbox):
    domain = mb.email.rsplit("@", 1)[-1]
    d = (await db.execute(select(Domain).where(Domain.user_id == user.id, Domain.name == domain))).scalar_one_or_none()
    mb.domain_id = d.id if d else None


@router.get("", response_model=list[MailboxOut])
async def list_mailboxes(user: CurrentUser, db: DB):
    items = (await db.execute(select(Mailbox).where(Mailbox.user_id == user.id).order_by(Mailbox.created_at))).scalars().all()
    return await _with_counts(db, list(items))


@router.get("/providers")
async def providers(_: CurrentUser):
    return {"google": oauth.is_configured("google"), "microsoft": oauth.is_configured("microsoft"), "smtp": True}


@router.post("/smtp", response_model=MailboxOut, status_code=201)
async def add_smtp(body: SmtpIn, user: CurrentUser, db: DB):
    email = body.email.lower()
    if (await db.execute(select(Mailbox).where(Mailbox.user_id == user.id, Mailbox.email == email))).scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, "This mailbox is already connected")
    await limits.ensure_can_add_mailbox(db, user)
    mb = Mailbox(
        user_id=user.id, provider="smtp", email=email, from_name=body.from_name,
        smtp_host=body.smtp_host.strip(), smtp_port=body.smtp_port, smtp_security=body.smtp_security,
        smtp_username=(body.smtp_username or email).strip(),
        imap_host=(body.imap_host or "").strip() or None, imap_port=body.imap_port, imap_security=body.imap_security,
        imap_username=(body.imap_username or body.smtp_username or email).strip(),
        daily_limit=body.daily_limit, warmup=dict(DEFAULT_WARMUP),
        secrets_enc=encrypt_json({"smtp_password": body.smtp_password, "imap_password": body.imap_password or body.smtp_password}),
    )
    if body.test:
        result = await transport.test_connection(mb)
        if result["smtp"] != "ok":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"SMTP connection failed — {result['smtp']}")
        if mb.imap_host and result["imap"] != "ok":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"IMAP connection failed — {result['imap']}")
    await _link_domain(db, user, mb)
    db.add(mb)
    await db.commit()
    await db.refresh(mb)
    return (await _with_counts(db, [mb]))[0]


@router.patch("/{mailbox_id}", response_model=MailboxOut)
async def update_mailbox(mailbox_id: uuid.UUID, body: MailboxUpdate, user: CurrentUser, db: DB):
    mb = await get_owned(db, Mailbox, mailbox_id, user)
    data = body.model_dump(exclude_unset=True)
    secrets = decrypt_json(mb.secrets_enc)
    for key in ("smtp_password", "imap_password"):
        if data.get(key):
            secrets[key] = data.pop(key)
        data.pop(key, None)
    if "warmup" in data and data["warmup"] is not None:
        data["warmup"] = {**DEFAULT_WARMUP, **(mb.warmup or {}), **data["warmup"]}
    if "status" in data and data["status"] not in ("active", "paused"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Status must be active or paused")
    if mb.provider != "smtp":
        for k in [k for k in data if k.startswith(("smtp_", "imap_"))]:
            data.pop(k)
    if data.get("warmup_enabled") is not None and data["warmup_enabled"] != mb.warmup_enabled:
        # Switching warmup on restarts the ramp-up schedule at day 1.
        mb.warmup_started_at = datetime.now(timezone.utc) if data["warmup_enabled"] else None
    for k, v in data.items():
        setattr(mb, k, v)
    if mb.max_delay_seconds < mb.min_delay_seconds:
        mb.max_delay_seconds = mb.min_delay_seconds
    mb.secrets_enc = encrypt_json(secrets)
    await db.commit()
    await db.refresh(mb)
    return (await _with_counts(db, [mb]))[0]


@router.post("/{mailbox_id}/test")
async def test_mailbox(mailbox_id: uuid.UUID, user: CurrentUser, db: DB):
    mb = await get_owned(db, Mailbox, mailbox_id, user)
    result = await transport.test_connection(mb)
    ok = result["smtp"] == "ok" and result["imap"] in ("ok", None)
    mb.status = "active" if ok else "error"
    mb.last_error = None if ok else (result["smtp"] if result["smtp"] != "ok" else result["imap"])
    await db.commit()
    return {"ok": ok, **result}


class TestSendIn(BaseModel):
    to: EmailStr


@router.post("/{mailbox_id}/send-test")
async def send_test(mailbox_id: uuid.UUID, body: TestSendIn, user: CurrentUser, db: DB):
    mb = await get_owned(db, Mailbox, mailbox_id, user)
    msg = transport.build_message(
        mb, to=body.to, subject="Sigmaflux Mail — test email",
        html=f"<p>This is a test email sent from <b>{mb.email}</b> via Sigmaflux Mail.</p>",
        text=f"This is a test email sent from {mb.email} via Sigmaflux Mail.", message_id=transport.new_message_id(mb),
    )
    try:
        await transport.send(mb, msg)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Send failed — {type(e).__name__}: {e}")
    await limits.bump_usage(db, user.id, emails=1)
    await db.commit()
    return {"ok": True}


@router.delete("/{mailbox_id}", status_code=204)
async def delete_mailbox(mailbox_id: uuid.UUID, user: CurrentUser, db: DB):
    mb = await get_owned(db, Mailbox, mailbox_id, user)
    await db.delete(mb)
    await db.commit()


# ── OAuth (Google / Microsoft) ──────────────────────────────────

@router.get("/oauth/{provider}/start")
async def oauth_start(provider: str, user: CurrentUser, db: DB):
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown provider")
    if not oauth.is_configured(provider):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{provider.title()} OAuth isn't configured on this server yet")
    await limits.ensure_can_add_mailbox(db, user)
    return {"url": oauth.authorize_url(provider, create_state_token({"sub": str(user.id), "p": provider}))}


def _back(**params) -> RedirectResponse:
    return RedirectResponse(f"{settings.WEB_URL}/mailboxes?{urlencode(params)}")


@router.get("/oauth/{provider}/callback")
async def oauth_callback(provider: str, db: DB, code: str = "", state: str = "", error: str = ""):
    if error:
        return _back(error=error)
    payload = decode_token(state, "state")
    if not payload or payload.get("p") != provider:
        return _back(error="invalid_state")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user:
        return _back(error="user_not_found")
    try:
        tokens = await oauth.exchange_code(provider, code)
    except Exception as e:  # noqa: BLE001
        return _back(error=f"token_exchange_failed: {type(e).__name__}")
    email = tokens["email"]
    mb = (await db.execute(select(Mailbox).where(Mailbox.user_id == user.id, Mailbox.email == email))).scalar_one_or_none()
    if not mb:
        try:
            await limits.ensure_can_add_mailbox(db, user)
        except HTTPException as e:
            return _back(error=e.detail)
        mb = Mailbox(user_id=user.id, provider=provider, email=email, from_name=tokens.get("name", ""), warmup=dict(DEFAULT_WARMUP))
        db.add(mb)
    mb.provider = provider
    mb.status = "active"
    mb.last_error = None
    mb.secrets_enc = encrypt_json({k: tokens[k] for k in ("access_token", "refresh_token", "expires_at")})
    await _link_domain(db, user, mb)
    await db.commit()
    return _back(connected=email)
