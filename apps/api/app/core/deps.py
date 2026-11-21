"""FastAPI dependencies: current user, admin guard, feature flags."""

import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_token
from app.database import get_db
from app.models import User

bearer = HTTPBearer(auto_error=False)

DB = Annotated[AsyncSession, Depends(get_db)]


async def get_current_user(
    db: DB,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> User:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    payload = decode_token(creds.credentials, "access")
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    if user.status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account suspended")
    if user.expires_at and user.expires_at < datetime.now(timezone.utc) and not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account expired")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def require_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin only")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


def require_feature(name: str):
    async def _check(user: CurrentUser) -> User:
        if not user.is_admin and not (user.features or {}).get(name, False):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"The '{name}' feature is not enabled on your account")
        return user

    return _check


async def get_owned(db: AsyncSession, model, obj_id: uuid.UUID, user: User):
    """Load a tenant-owned row or 404 (never leak other tenants' rows)."""
    obj = await db.get(model, obj_id)
    if not obj or obj.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{model.__name__} not found")
    return obj
