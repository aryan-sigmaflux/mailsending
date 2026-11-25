import json
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app.core.crypto import decrypt_str, encrypt_str, mask
from app.core.deps import DB, CurrentUser, get_owned
from app.models import Integration
from app.services import ai, keywords, site_audit

router = APIRouter(prefix="/integrations", tags=["integrations"])

AI_PROVIDERS = {"openai", "anthropic", "gemini", "openrouter", "custom"}
KEYWORD_PROVIDERS = {"google_ads", "dataforseo"}
# Google Ads needs several secrets; they're stored together (encrypted JSON) and never returned.
# Auth is either a service-account key ("service_account") or an OAuth client secret + refresh token.
GOOGLE_ADS_SECRETS = ("service_account", "client_secret", "refresh_token", "developer_token")
LABELS = {"google_ads": "Google Ads Keyword Planner", "dataforseo": "DataForSEO", "google": "Google PageSpeed"}


class IntegrationIn(BaseModel):
    kind: str = Field(pattern="^(ai|apollo|keywords|pagespeed)$")
    provider: str
    mode: str = Field("api", pattern="^(api|mcp)$")
    label: str = ""
    api_key: str | None = None
    secrets: dict | None = None  # google_ads: service_account (JSON key) or client_secret + refresh_token; developer_token
    config: dict = {}
    is_default: bool = False


class IntegrationOut(BaseModel):
    id: uuid.UUID
    kind: str
    provider: str
    mode: str
    label: str
    key_hint: str
    config: dict
    is_default: bool
    last_test_ok: bool | None
    last_test_message: str | None
    created_at: datetime


def _hint(i: Integration) -> str:
    secret = decrypt_str(i.secret_enc)
    if i.provider == "google_ads":
        try:
            s = json.loads(secret or "{}")
            if s.get("service_account"):
                return "service account " + keywords.parse_service_account(s["service_account"])["client_email"]
            return "refresh token " + mask(s.get("refresh_token") or "")
        except ValueError:
            return ""
    return mask(secret)


def _out(i: Integration) -> IntegrationOut:
    return IntegrationOut(id=i.id, kind=i.kind, provider=i.provider, mode=i.mode, label=i.label,
                          key_hint=_hint(i), config=i.config or {}, is_default=i.is_default,
                          last_test_ok=i.last_test_ok, last_test_message=i.last_test_message, created_at=i.created_at)


def _validate(body: IntegrationIn):
    if body.kind == "ai" and body.provider not in AI_PROVIDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown AI provider '{body.provider}'")
    if body.kind == "apollo" and body.provider != "apollo":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Apollo integrations use provider 'apollo'")
    if body.kind == "keywords" and body.provider not in KEYWORD_PROVIDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Keyword data comes from 'google_ads' or 'dataforseo'")
    if body.kind == "pagespeed" and body.provider != "google":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "PageSpeed integrations use provider 'google'")
    if body.provider == "google_ads":
        needs = ("customer_id",) if body.config.get("auth") == "service_account" else ("client_id", "customer_id")
        missing = [k for k in needs if not str(body.config.get(k) or "").strip()]
        if missing:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Google Ads needs: {', '.join(missing)}")
    if body.provider == "dataforseo" and not body.config.get("login"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "DataForSEO needs your API login")
    if body.provider == "custom" and not body.config.get("base_url"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Custom providers need a base URL")
    if body.mode == "mcp" and not body.config.get("mcp_url"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "MCP mode needs the MCP server URL")


def _secret(body: IntegrationIn, current: str | None) -> str | None:
    """The secret to store: the API key, or for Google Ads the JSON of its secrets merged over the current ones."""
    if body.provider != "google_ads":
        return body.api_key or None
    merged = json.loads(current or "{}") if current else {}
    for k in GOOGLE_ADS_SECRETS:
        v = str((body.secrets or {}).get(k) or "").strip()
        if v:
            merged[k] = v
    if body.config.get("auth") == "service_account":
        if not merged.get("service_account"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Paste the service account JSON key")
        try:
            keywords.parse_service_account(merged["service_account"])
        except ValueError as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
        merged.pop("client_secret", None)
        merged.pop("refresh_token", None)
    else:
        missing = [k for k in ("client_secret", "refresh_token") if not merged.get(k)]
        if missing:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Google Ads needs: {', '.join(missing)}")
        merged.pop("service_account", None)
    return json.dumps(merged)


async def _set_default(db, user, integ: Integration):
    await db.execute(update(Integration).where(Integration.user_id == user.id, Integration.kind == integ.kind,
                                               Integration.id != integ.id).values(is_default=False))
    integ.is_default = True


@router.get("", response_model=list[IntegrationOut])
async def list_integrations(user: CurrentUser, db: DB):
    rows = (await db.execute(select(Integration).where(Integration.user_id == user.id).order_by(Integration.created_at))).scalars().all()
    return [_out(i) for i in rows]


@router.post("", response_model=IntegrationOut, status_code=201)
async def add_integration(body: IntegrationIn, user: CurrentUser, db: DB):
    _validate(body)
    if body.kind in ("ai", "apollo") and not user.is_admin and not (user.features or {}).get(body.kind, False):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"The {body.kind} feature isn't enabled on your account")
    secret = _secret(body, None)
    if body.mode == "api" and not secret and body.kind != "pagespeed":  # PageSpeed works without a key (low quota)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "API key is required")
    i = Integration(user_id=user.id, kind=body.kind, provider=body.provider, mode=body.mode,
                    label=body.label or LABELS.get(body.provider, body.provider.title()), config=body.config,
                    secret_enc=encrypt_str(secret) if secret else None)
    db.add(i)
    await db.flush()
    existing_default = (await db.execute(select(Integration.id).where(
        Integration.user_id == user.id, Integration.kind == body.kind, Integration.is_default.is_(True)))).first()
    if body.is_default or not existing_default:
        await _set_default(db, user, i)
    await db.commit()
    await db.refresh(i)
    return _out(i)


@router.patch("/{integration_id}", response_model=IntegrationOut)
async def update_integration(integration_id: uuid.UUID, body: IntegrationIn, user: CurrentUser, db: DB):
    i = await get_owned(db, Integration, integration_id, user)
    _validate(body)
    i.label, i.mode, i.config = body.label or i.label, body.mode, body.config
    if body.provider == "google_ads":
        i.secret_enc = encrypt_str(_secret(body, decrypt_str(i.secret_enc)))
    elif body.api_key:
        i.secret_enc = encrypt_str(body.api_key)
    if body.is_default:
        await _set_default(db, user, i)
    await db.commit()
    await db.refresh(i)
    return _out(i)


@router.post("/{integration_id}/test", response_model=IntegrationOut)
async def test_integration(integration_id: uuid.UUID, user: CurrentUser, db: DB):
    i = await get_owned(db, Integration, integration_id, user)
    key = decrypt_str(i.secret_enc)
    try:
        if i.kind == "apollo":
            ok, msg = await ai.test_apollo(key)
        elif i.kind == "keywords":
            cfg = dict(i.config or {})
            if i.provider == "google_ads":
                cfg["currency"] = await keywords.google_ads_currency(cfg, json.loads(key or "{}"))
                i.config = cfg
            rows = await keywords.metrics(i.provider, cfg, key, ["running shoes"], cfg.get("location_code") or keywords.DEFAULT_LOCATION,
                                          cfg.get("language_code") or keywords.DEFAULT_LANGUAGE)
            m = rows[0] if rows else {}
            ok = m.get("volume") is not None
            msg = (f"'running shoes': {m['volume']:,} searches/mo, top-of-page bid {m.get('low_bid')}-{m.get('high_bid')} "
                   f"{m.get('currency') or ''}".strip()) if ok else "Connected, but no volume came back for a test keyword"
        elif i.kind == "pagespeed":
            ps = await site_audit.pagespeed("https://www.google.com/", key or None)
            ok, msg = ps.get("score") is not None, f"PageSpeed works (google.com scored {ps.get('score')}/100 on mobile)"
        else:
            reply = await ai.complete(i.provider, key, "Reply with the single word: pong", model=(i.config or {}).get("model"),
                                      base_url=(i.config or {}).get("base_url"), max_tokens=10)
            ok, msg = bool(reply.strip()), f"Model replied: {reply.strip()[:60]}"
    except Exception as e:  # noqa: BLE001
        ok, msg = False, f"{type(e).__name__}: {e}"[:300]
    i.last_test_ok, i.last_test_message = ok, msg
    await db.commit()
    await db.refresh(i)
    return _out(i)


@router.delete("/{integration_id}", status_code=204)
async def delete_integration(integration_id: uuid.UUID, user: CurrentUser, db: DB):
    i = await get_owned(db, Integration, integration_id, user)
    await db.delete(i)
    await db.commit()
