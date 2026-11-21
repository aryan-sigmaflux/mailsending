"""Encryption at rest for mailbox credentials, OAuth tokens and API keys (Fernet / AES-128-CBC + HMAC)."""

import base64
import hashlib
import json
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


@lru_cache
def _fernet() -> Fernet:
    key = settings.ENCRYPTION_KEY.strip()
    if not key:
        if settings.APP_ENV != "development":
            raise RuntimeError("ENCRYPTION_KEY must be set outside development")
        # Dev fallback: derive a stable key from JWT_SECRET so local data stays readable.
        key = base64.urlsafe_b64encode(hashlib.sha256(settings.JWT_SECRET.encode()).digest()).decode()
    return Fernet(key.encode())


def encrypt_str(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_str(token: str | None) -> str:
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return ""


def encrypt_json(data: dict[str, Any]) -> str:
    return encrypt_str(json.dumps(data))


def decrypt_json(token: str | None) -> dict[str, Any]:
    raw = decrypt_str(token)
    return json.loads(raw) if raw else {}


def mask(secret: str) -> str:
    if not secret:
        return ""
    return f"{secret[:4]}…{secret[-4:]}" if len(secret) > 10 else "••••"
