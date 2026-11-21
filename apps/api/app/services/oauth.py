"""Google & Microsoft OAuth2 for mailbox connections (XOAUTH2 over SMTP/IMAP)."""

import time
from urllib.parse import urlencode

import httpx

from app.config import settings

PROVIDERS = {
    "google": {
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://openidconnect.googleapis.com/v1/userinfo",
        # Full mail scope is required for SMTP/IMAP XOAUTH2.
        "scope": "openid email profile https://mail.google.com/",
        "smtp": ("smtp.gmail.com", 465, "ssl"),
        "imap": ("imap.gmail.com", 993, "ssl"),
    },
    "microsoft": {
        "auth_url": f"https://login.microsoftonline.com/{settings.MICROSOFT_TENANT}/oauth2/v2.0/authorize",
        "token_url": f"https://login.microsoftonline.com/{settings.MICROSOFT_TENANT}/oauth2/v2.0/token",
        "userinfo_url": "https://graph.microsoft.com/oidc/userinfo",
        "scope": "openid email profile offline_access https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All",
        "smtp": ("smtp.office365.com", 587, "starttls"),
        "imap": ("outlook.office365.com", 993, "ssl"),
    },
}


def client_creds(provider: str) -> tuple[str, str]:
    if provider == "google":
        return settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET
    return settings.MICROSOFT_CLIENT_ID, settings.MICROSOFT_CLIENT_SECRET


def is_configured(provider: str) -> bool:
    cid, secret = client_creds(provider)
    return bool(cid and secret)


def redirect_uri(provider: str) -> str:
    return f"{settings.oauth_redirect_base}/{provider}/callback"


def authorize_url(provider: str, state: str) -> str:
    cid, _ = client_creds(provider)
    p = PROVIDERS[provider]
    params = {
        "client_id": cid,
        "redirect_uri": redirect_uri(provider),
        "response_type": "code",
        "scope": p["scope"],
        "state": state,
        "prompt": "consent",
    }
    if provider == "google":
        params["access_type"] = "offline"
    return f"{p['auth_url']}?{urlencode(params)}"


async def exchange_code(provider: str, code: str) -> dict:
    cid, secret = client_creds(provider)
    p = PROVIDERS[provider]
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(p["token_url"], data={
            "client_id": cid, "client_secret": secret, "code": code,
            "grant_type": "authorization_code", "redirect_uri": redirect_uri(provider),
        })
        r.raise_for_status()
        tokens = r.json()
        info = await client.get(p["userinfo_url"], headers={"Authorization": f"Bearer {tokens['access_token']}"})
        info.raise_for_status()
    return {
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", ""),
        "expires_at": int(time.time()) + int(tokens.get("expires_in", 3600)) - 60,
        "email": (info.json().get("email") or "").lower(),
        "name": info.json().get("name", ""),
    }


async def refresh(provider: str, refresh_token: str) -> dict:
    cid, secret = client_creds(provider)
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(PROVIDERS[provider]["token_url"], data={
            "client_id": cid, "client_secret": secret, "refresh_token": refresh_token, "grant_type": "refresh_token",
        })
        r.raise_for_status()
        data = r.json()
    return {
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token") or refresh_token,
        "expires_at": int(time.time()) + int(data.get("expires_in", 3600)) - 60,
    }
