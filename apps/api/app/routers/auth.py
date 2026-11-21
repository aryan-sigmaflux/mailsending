import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import DB, CurrentUser
from app.core.security import create_access_token, create_refresh_token, decode_token, hash_password, verify_password
from app.models import Campaign, Contact, Domain, Mailbox, User
from app.schemas import MeOut, Usage, UserOut
from app.services import limits

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class TokensOut(BaseModel):
    access_token: str
    refresh_token: str
    user: UserOut


class ProfileIn(BaseModel):
    full_name: str | None = None
    timezone: str | None = None


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


@router.post("/login", response_model=TokensOut)
async def login(body: LoginIn, db: DB):
    user = (await db.execute(select(User).where(User.email == body.email.strip().lower()))).scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    if user.status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account suspended — contact your administrator")
    if user.expires_at and user.expires_at < datetime.now(timezone.utc) and not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account expired — contact your administrator")
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    return TokensOut(
        access_token=create_access_token(user.id, user.role),
        refresh_token=create_refresh_token(user.id),
        user=UserOut.model_validate(user),
    )


@router.post("/refresh", response_model=TokensOut)
async def refresh(body: RefreshIn, db: DB):
    payload = decode_token(body.refresh_token, "refresh")
    user = await db.get(User, uuid.UUID(payload["sub"])) if payload else None
    if not user or user.status != "active":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    return TokensOut(
        access_token=create_access_token(user.id, user.role),
        refresh_token=create_refresh_token(user.id),
        user=UserOut.model_validate(user),
    )


async def build_usage(db, user: User) -> Usage:
    async def count(model, *extra):
        return (await db.execute(select(func.count()).select_from(model).where(model.user_id == user.id, *extra))).scalar_one()

    today = await limits.usage_today(db, user.id)
    month_sent, month_verifs = await limits.usage_month(db, user.id)
    return Usage(
        emails_today=today.emails_sent if today else 0,
        emails_month=month_sent,
        verifications_month=month_verifs,
        domains=await count(Domain),
        mailboxes=await count(Mailbox),
        active_campaigns=await count(Campaign, Campaign.status == "running"),
        contacts=await count(Contact),
    )


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser, db: DB):
    return MeOut(user=UserOut.model_validate(user), usage=await build_usage(db, user))


@router.patch("/me", response_model=UserOut)
async def update_me(body: ProfileIn, user: CurrentUser, db: DB):
    if body.full_name is not None:
        user.full_name = body.full_name.strip()
    if body.timezone is not None:
        user.timezone = body.timezone
    await db.commit()
    return user


@router.post("/password", status_code=204)
async def change_password(body: PasswordIn, user: CurrentUser, db: DB):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    await db.commit()
