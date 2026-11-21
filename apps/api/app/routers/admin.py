import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select

from app.core.deps import DB, AdminUser
from app.core.security import hash_password
from app.models import AuditLog, Campaign, Domain, Mailbox, Message, UsageDaily, User
from app.models.user import DEFAULT_FEATURES, ROLE_SUPER_ADMIN, ROLE_USER
from app.routers.auth import build_usage
from app.schemas import Usage, UserOut

router = APIRouter(prefix="/admin", tags=["admin"])


class LimitsIn(BaseModel):
    max_daily_emails: int | None = Field(None, ge=0)
    max_monthly_emails: int | None = Field(None, ge=0)
    max_domains: int | None = Field(None, ge=0)
    max_mailboxes: int | None = Field(None, ge=0)
    max_campaigns: int | None = Field(None, ge=0)
    max_contacts: int | None = Field(None, ge=0)
    verify_credits_monthly: int | None = Field(None, ge=0)
    features: dict[str, bool] | None = None


class UserCreate(LimitsIn):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: str = ""
    role: str = ROLE_USER
    expires_at: datetime | None = None


class UserUpdate(LimitsIn):
    full_name: str | None = None
    status: str | None = None
    role: str | None = None
    expires_at: datetime | None = None
    clear_expiry: bool = False


class PasswordReset(BaseModel):
    password: str = Field(min_length=8)


class AdminUserRow(BaseModel):
    user: UserOut
    usage: Usage


LIMIT_FIELDS = ["max_daily_emails", "max_monthly_emails", "max_domains", "max_mailboxes",
                "max_campaigns", "max_contacts", "verify_credits_monthly"]


def _apply_limits(user: User, body: LimitsIn):
    for f in LIMIT_FIELDS:
        v = getattr(body, f)
        if v is not None:
            setattr(user, f, v)
    if body.features is not None:
        user.features = {**DEFAULT_FEATURES, **(user.features or {}), **body.features}


@router.get("/stats")
async def stats(_: AdminUser, db: DB):
    async def scalar(q):
        return (await db.execute(q)).scalar_one()

    since = date.today() - timedelta(days=13)
    series = (await db.execute(
        select(UsageDaily.day, func.sum(UsageDaily.emails_sent)).where(UsageDaily.day >= since).group_by(UsageDaily.day)
    )).all()
    by_day = {d: int(n) for d, n in series}
    return {
        "users": await scalar(select(func.count()).select_from(User).where(User.role == ROLE_USER)),
        "active_users": await scalar(select(func.count()).select_from(User).where(User.role == ROLE_USER, User.status == "active")),
        "mailboxes": await scalar(select(func.count()).select_from(Mailbox)),
        "domains": await scalar(select(func.count()).select_from(Domain)),
        "running_campaigns": await scalar(select(func.count()).select_from(Campaign).where(Campaign.status == "running")),
        "emails_today": by_day.get(date.today(), 0),
        "emails_total": await scalar(select(func.count()).select_from(Message).where(Message.status == "sent")),
        "series": [{"day": (since + timedelta(days=i)).isoformat(), "sent": by_day.get(since + timedelta(days=i), 0)} for i in range(14)],
    }


@router.get("/users", response_model=list[AdminUserRow])
async def list_users(_: AdminUser, db: DB, q: str = Query("", max_length=200)):
    stmt = select(User).order_by(User.created_at.desc())
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(User.email).like(like), func.lower(User.full_name).like(like)))
    users = (await db.execute(stmt)).scalars().all()
    return [AdminUserRow(user=UserOut.model_validate(u), usage=await build_usage(db, u)) for u in users]


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(body: UserCreate, admin: AdminUser, db: DB):
    if body.role not in (ROLE_USER, ROLE_SUPER_ADMIN):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid role")
    email = body.email.lower()
    if (await db.execute(select(User).where(User.email == email))).scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists")
    user = User(email=email, password_hash=hash_password(body.password), full_name=body.full_name.strip(),
                role=body.role, expires_at=body.expires_at, features=dict(DEFAULT_FEATURES))
    _apply_limits(user, body)
    db.add(user)
    await db.flush()
    db.add(AuditLog(actor_id=admin.id, user_id=user.id, action="user.create", payload={"email": email}))
    await db.commit()
    await db.refresh(user)
    return user


@router.get("/users/{user_id}", response_model=AdminUserRow)
async def get_user(user_id: uuid.UUID, _: AdminUser, db: DB):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return AdminUserRow(user=UserOut.model_validate(user), usage=await build_usage(db, user))


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(user_id: uuid.UUID, body: UserUpdate, admin: AdminUser, db: DB):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if body.full_name is not None:
        user.full_name = body.full_name.strip()
    if body.status is not None:
        if body.status not in ("active", "suspended"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid status")
        if user.id == admin.id and body.status != "active":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't suspend yourself")
        user.status = body.status
    if body.role is not None:
        if body.role not in (ROLE_USER, ROLE_SUPER_ADMIN):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid role")
        if user.id == admin.id and body.role != ROLE_SUPER_ADMIN:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't demote yourself")
        user.role = body.role
    if body.clear_expiry:
        user.expires_at = None
    elif body.expires_at is not None:
        user.expires_at = body.expires_at
    _apply_limits(user, body)
    db.add(AuditLog(actor_id=admin.id, user_id=user.id, action="user.update",
                    payload=body.model_dump(exclude_none=True, mode="json")))
    await db.commit()
    await db.refresh(user)
    return user


@router.post("/users/{user_id}/password", status_code=204)
async def reset_password(user_id: uuid.UUID, body: PasswordReset, admin: AdminUser, db: DB):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    user.password_hash = hash_password(body.password)
    db.add(AuditLog(actor_id=admin.id, user_id=user.id, action="user.password_reset"))
    await db.commit()


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: uuid.UUID, admin: AdminUser, db: DB):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if user.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't delete yourself")
    await db.delete(user)
    await db.commit()


@router.get("/warmup-pool")
async def warmup_pool(_: AdminUser, db: DB):
    rows = (await db.execute(
        select(Mailbox, User.email).join(User, User.id == Mailbox.user_id).where(Mailbox.warmup_enabled.is_(True))
    )).all()
    return [{"id": m.id, "email": m.email, "owner": owner, "provider": m.provider, "status": m.status,
             "health_score": m.health_score} for m, owner in rows]


@router.post("/warmup-pool/{mailbox_id}/remove", status_code=204)
async def remove_from_pool(mailbox_id: uuid.UUID, admin: AdminUser, db: DB):
    mb = await db.get(Mailbox, mailbox_id)
    if not mb:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mailbox not found")
    mb.warmup_enabled = False
    db.add(AuditLog(actor_id=admin.id, user_id=mb.user_id, action="warmup.remove", payload={"mailbox": mb.email}))
    await db.commit()
