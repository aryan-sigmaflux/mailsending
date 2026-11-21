import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app.core.crypto import decrypt_str, encrypt_str, mask
from app.core.deps import DB, CurrentUser, get_owned
from app.models import Integration
from app.services import ai

router = APIRouter(prefix="/integrations", tags=["integrations"])

AI_PROVIDERS = {"openai", "anthropic", "gemini", "openrouter", "custom"}


class IntegrationIn(BaseModel):
    kind: str = Field(pattern="^(ai|apollo)$")
    provider: str
    mode: str = Field("api", pattern="^(api|mcp)$")
    label: str = ""
    api_key: str | None = None
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


def _out(i: Integration) -> IntegrationOut:
    return IntegrationOut(id=i.id, kind=i.kind, provider=i.provider, mode=i.mode, label=i.label,
                          key_hint=mask(decrypt_str(i.secret_enc)), config=i.config or {}, is_default=i.is_default,
                          last_test_ok=i.last_test_ok, last_test_message=i.last_test_message, created_at=i.created_at)


def _validate(body: IntegrationIn):
    if body.kind == "ai" and body.provider not in AI_PROVIDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown AI provider '{body.provider}'")
    if body.kind == "apollo" and body.provider != "apollo":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Apollo integrations use provider 'apollo'")
    if body.provider == "custom" and not body.config.get("base_url"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Custom providers need a base URL")
    if body.mode == "mcp" and not body.config.get("mcp_url"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "MCP mode needs the MCP server URL")


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
    feature = "ai" if body.kind == "ai" else "apollo"
    if not user.is_admin and not (user.features or {}).get(feature, False):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"The {feature} feature isn't enabled on your account")
    if body.mode == "api" and not body.api_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "API key is required")
    i = Integration(user_id=user.id, kind=body.kind, provider=body.provider, mode=body.mode,
                    label=body.label or body.provider.title(), config=body.config,
                    secret_enc=encrypt_str(body.api_key) if body.api_key else None)
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
    if body.api_key:
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
