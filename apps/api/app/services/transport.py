"""Outbound SMTP and inbound IMAP for every mailbox type (password or XOAUTH2)."""

import asyncio
import base64
import imaplib
import ssl
import time
import uuid
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, formatdate

import aiosmtplib

from app.core.crypto import decrypt_json, encrypt_json
from app.models import Mailbox
from app.services import oauth


@dataclass
class Conn:
    host: str
    port: int
    security: str  # ssl | starttls | none
    username: str
    password: str = ""
    xoauth_token: str = ""


async def _fresh_token(mb: Mailbox) -> str:
    """Return a valid OAuth access token, refreshing (and persisting on the object) when expired."""
    secrets = decrypt_json(mb.secrets_enc)
    if secrets.get("access_token") and int(secrets.get("expires_at", 0)) > time.time():
        return secrets["access_token"]
    if not secrets.get("refresh_token"):
        raise RuntimeError("OAuth refresh token missing — reconnect this mailbox")
    new = await oauth.refresh(mb.provider, secrets["refresh_token"])
    secrets.update(new)
    mb.secrets_enc = encrypt_json(secrets)  # caller commits
    return new["access_token"]


async def smtp_conn(mb: Mailbox) -> Conn:
    secrets = decrypt_json(mb.secrets_enc)
    if mb.provider in ("google", "microsoft"):
        host, port, sec = oauth.PROVIDERS[mb.provider]["smtp"]
        return Conn(host, port, sec, mb.email, xoauth_token=await _fresh_token(mb))
    return Conn(mb.smtp_host or "", mb.smtp_port or 465, mb.smtp_security, mb.smtp_username or mb.email,
                password=secrets.get("smtp_password", ""))


async def imap_conn(mb: Mailbox) -> Conn | None:
    secrets = decrypt_json(mb.secrets_enc)
    if mb.provider in ("google", "microsoft"):
        host, port, sec = oauth.PROVIDERS[mb.provider]["imap"]
        return Conn(host, port, sec, mb.email, xoauth_token=await _fresh_token(mb))
    if not mb.imap_host:
        return None
    return Conn(mb.imap_host, mb.imap_port or 993, mb.imap_security, mb.imap_username or mb.email,
                password=secrets.get("imap_password", ""))


def _xoauth2(user: str, token: str) -> str:
    return base64.b64encode(f"user={user}\x01auth=Bearer {token}\x01\x01".encode()).decode()


async def _smtp_client(c: Conn) -> aiosmtplib.SMTP:
    client = aiosmtplib.SMTP(
        hostname=c.host, port=c.port, timeout=30,
        use_tls=c.security == "ssl", start_tls=c.security == "starttls" or None,
    )
    await client.connect()
    if c.xoauth_token:
        resp = await client.execute_command(b"AUTH", b"XOAUTH2", _xoauth2(c.username, c.xoauth_token).encode())
        if resp.code != 235:
            raise aiosmtplib.SMTPAuthenticationError(resp.code, resp.message)
    elif c.password:
        await client.login(c.username, c.password)
    return client


def build_message(
    mb: Mailbox, *, to: str, subject: str, html: str, text: str, message_id: str,
    in_reply_to: str | None = None, references: str | None = None, unsubscribe_url: str | None = None,
) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = formataddr((mb.from_name or "", mb.email))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = message_id
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = references or in_reply_to
    if unsubscribe_url:
        msg["List-Unsubscribe"] = f"<{unsubscribe_url}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    msg.set_content(text or " ")
    msg.add_alternative(f"<!doctype html><html><body>{html}</body></html>", subtype="html")
    return msg


def new_message_id(mb: Mailbox) -> str:
    domain = mb.email.rsplit("@", 1)[-1]
    return f"<{uuid.uuid4().hex}@{domain}>"


async def send(mb: Mailbox, msg: EmailMessage) -> None:
    client = await _smtp_client(await smtp_conn(mb))
    try:
        await client.send_message(msg)
    finally:
        try:
            await client.quit()
        except aiosmtplib.SMTPException:
            client.close()


# ── IMAP (sync imaplib run in a thread) ─────────────────────────

def _imap_login(c: Conn) -> imaplib.IMAP4:
    if c.security == "ssl":
        imap = imaplib.IMAP4_SSL(c.host, c.port, ssl_context=ssl.create_default_context(), timeout=30)
    else:
        imap = imaplib.IMAP4(c.host, c.port, timeout=30)
        if c.security == "starttls":
            imap.starttls(ssl.create_default_context())
    if c.xoauth_token:
        raw = f"user={c.username}\x01auth=Bearer {c.xoauth_token}\x01\x01".encode()
        imap.authenticate("XOAUTH2", lambda _: raw)
    else:
        imap.login(c.username, c.password)
    return imap


async def test_connection(mb: Mailbox) -> dict:
    """Try SMTP login and (if configured) IMAP login. Returns {smtp: ok/err, imap: ok/err/None}."""
    out: dict = {"smtp": None, "imap": None}
    try:
        client = await _smtp_client(await smtp_conn(mb))
        await client.quit()
        out["smtp"] = "ok"
    except Exception as e:  # noqa: BLE001 — surface any failure to the user
        out["smtp"] = f"{type(e).__name__}: {e}"[:300]
    try:
        c = await imap_conn(mb)
        if c:
            imap = await asyncio.to_thread(_imap_login, c)
            await asyncio.to_thread(imap.logout)
            out["imap"] = "ok"
    except Exception as e:  # noqa: BLE001
        out["imap"] = f"{type(e).__name__}: {e}"[:300]
    return out


def fetch_headers_since(c: Conn, last_uid: int, limit: int = 200) -> tuple[list[dict], int]:
    """Fetch new INBOX messages' key headers (+ a text snippet) with UID > last_uid."""
    import email
    from email.header import decode_header, make_header

    imap = _imap_login(c)
    try:
        imap.select("INBOX", readonly=True)
        typ, data = imap.uid("search", None, f"UID {last_uid + 1}:*")
        uids = [int(u) for u in (data[0] or b"").split() if int(u) > last_uid][-limit:]
        found = []
        for uid in uids:
            typ, msg_data = imap.uid("fetch", str(uid), "(BODY.PEEK[])")
            if typ != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
                continue
            m = email.message_from_bytes(msg_data[0][1])
            body = ""
            part = m.get_body(preferencelist=("plain", "html")) if hasattr(m, "get_body") else None
            if part is None and not m.is_multipart():
                part = m
            if part is not None:
                try:
                    body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
                except (AttributeError, LookupError):
                    body = ""
            found.append({
                "uid": uid,
                "from": str(make_header(decode_header(m.get("From", "")))),
                "subject": str(make_header(decode_header(m.get("Subject", "")))),
                "in_reply_to": (m.get("In-Reply-To") or "").strip(),
                "references": (m.get("References") or "").split(),
                "auto_submitted": (m.get("Auto-Submitted") or "").lower(),
                "content_type": m.get_content_type(),
                "body": body[:20000],
            })
        return found, max(uids) if uids else last_uid
    finally:
        try:
            imap.logout()
        except Exception:  # noqa: BLE001
            pass
