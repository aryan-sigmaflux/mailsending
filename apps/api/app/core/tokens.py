"""Compact signed tokens embedded in tracking pixels, click links and unsubscribe URLs."""

import base64
import hashlib
import hmac
import uuid

from app.config import settings


def _sig(data: bytes) -> str:
    mac = hmac.new(settings.JWT_SECRET.encode(), data, hashlib.sha256).digest()[:10]
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_message(message_id: uuid.UUID, extra: str = "") -> str:
    raw = message_id.bytes
    return f"{_b64(raw)}.{_sig(raw + extra.encode())}"


def verify_message(token: str, extra: str = "") -> uuid.UUID | None:
    try:
        body, sig = token.split(".", 1)
        raw = _unb64(body)
        if len(raw) != 16 or not hmac.compare_digest(sig, _sig(raw + extra.encode())):
            return None
        return uuid.UUID(bytes=raw)
    except (ValueError, TypeError):
        return None
