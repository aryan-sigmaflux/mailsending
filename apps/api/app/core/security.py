"""Password hashing and JWT helpers."""

import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

from app.config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def _encode(payload: dict, expires: timedelta) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {**payload, "iat": now, "exp": now + expires},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )


def create_access_token(user_id: uuid.UUID, role: str) -> str:
    return _encode(
        {"sub": str(user_id), "role": role, "typ": "access"},
        timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )


def create_refresh_token(user_id: uuid.UUID) -> str:
    return _encode({"sub": str(user_id), "typ": "refresh"}, timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS))


def create_state_token(data: dict, minutes: int = 15) -> str:
    """Short-lived signed token, e.g. the OAuth `state` parameter."""
    return _encode({**data, "typ": "state"}, timedelta(minutes=minutes))


def decode_token(token: str, expected_type: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
        return None
    if payload.get("typ") != expected_type:
        return None
    return payload
