"""Email address verifier: syntax → MX → disposable / role → SMTP RCPT probe → catch-all detection.

The SMTP stage needs outbound port 25. When it's blocked (most clouds / home ISPs) the result
degrades gracefully to `unknown` with reason `smtp_unreachable` rather than a false `invalid`.
"""

import asyncio
import secrets

import aiosmtplib
from email_validator import EmailNotValidError, validate_email

from app.config import settings
from app.services.dns_checker import get_mx

DISPOSABLE_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com",
    "trashmail.com", "getnada.com", "sharklasers.com", "dispostable.com", "maildrop.cc", "throwawaymail.com",
    "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com", "tempinbox.com", "mailnesia.com",
    "spamgourmet.com", "burnermail.io", "tempmailo.com", "moakt.com", "inboxkitten.com", "mailcatch.com",
}

ROLE_PREFIXES = {
    "admin", "administrator", "info", "sales", "support", "contact", "hello", "help", "office", "billing",
    "marketing", "noreply", "no-reply", "postmaster", "webmaster", "hr", "jobs", "careers", "team", "abuse",
    "accounts", "enquiries", "inquiries", "press", "media", "security", "legal", "privacy",
}

# Providers that accept every RCPT (or block probing) — SMTP result is meaningless there.
ACCEPT_ALL_PROVIDERS = ("yahoodns.net", "yahoo.com", "aol.com")


async def _smtp_probe(mx_host: str, emails: list[str]) -> dict[str, tuple[int, str]]:
    """Open one SMTP session and RCPT each address. Returns {email: (code, message)}."""
    results: dict[str, tuple[int, str]] = {}
    client = aiosmtplib.SMTP(hostname=mx_host, port=25, timeout=settings.VERIFIER_SMTP_TIMEOUT, start_tls=False)
    await client.connect()
    try:
        await client.ehlo(hostname=settings.VERIFIER_HELO_DOMAIN)
        if client.supports_extension("starttls"):
            try:
                # Probe only sends RCPT (no message data) — many MX certs don't match their hostname.
                await client.starttls(validate_certs=False)
                await client.ehlo(hostname=settings.VERIFIER_HELO_DOMAIN)
            except (aiosmtplib.SMTPException, OSError):
                pass
        await client.mail(settings.VERIFIER_MAIL_FROM)
        for email in emails:
            try:
                resp = await client.rcpt(email)
                results[email] = (resp.code, resp.message)
            except aiosmtplib.SMTPRecipientRefused as e:
                results[email] = (e.code, e.message)
            except aiosmtplib.SMTPResponseException as e:
                results[email] = (e.code, e.message)
    finally:
        try:
            await client.quit()
        except Exception:  # noqa: BLE001 — closing a probe session must never fail the check
            client.close()
    return results


async def verify_email(email: str) -> dict:
    email = email.strip()
    result = {
        "email": email.lower(),
        "status": "unknown",
        "reason": "",
        "syntax_ok": False,
        "mx": [],
        "disposable": False,
        "role": False,
        "catch_all": None,
        "smtp_code": None,
        "smtp_message": None,
    }

    try:
        info = validate_email(email, check_deliverability=False)
        normalized = info.normalized.lower()
        local, domain = normalized.rsplit("@", 1)
        result["email"] = normalized
        result["syntax_ok"] = True
    except EmailNotValidError as e:
        result.update(status="invalid", reason=f"bad_syntax: {e}")
        return result

    result["disposable"] = domain in DISPOSABLE_DOMAINS
    result["role"] = local.split("+")[0] in ROLE_PREFIXES

    mx = await get_mx(domain)
    result["mx"] = [h for _, h in mx]
    if not mx:
        result.update(status="invalid", reason="no_mx")
        return result

    if result["disposable"]:
        result.update(status="invalid", reason="disposable_domain")
        return result

    mx_host = mx[0][1]
    if any(mx_host.endswith(p) for p in ACCEPT_ALL_PROVIDERS):
        result.update(status="risky", reason="provider_blocks_verification")
        return result

    probe_addr = f"{secrets.token_hex(8)}-nonexistent@{domain}"
    try:
        codes = await asyncio.wait_for(_smtp_probe(mx_host, [normalized, probe_addr]), timeout=settings.VERIFIER_SMTP_TIMEOUT * 2)
    except (aiosmtplib.SMTPException, OSError, asyncio.TimeoutError) as e:
        result.update(status="unknown", reason=f"smtp_unreachable: {type(e).__name__}")
        return result
    except Exception as e:  # noqa: BLE001 — never 500 on an odd server; report unknown instead
        result.update(status="unknown", reason=f"smtp_error: {type(e).__name__}")
        return result

    code, msg = codes.get(normalized, (0, ""))
    probe_code, _ = codes.get(probe_addr, (0, ""))
    result["smtp_code"] = code
    result["smtp_message"] = (msg or "")[:200]
    result["catch_all"] = 200 <= probe_code < 300

    if 200 <= code < 300:
        if result["catch_all"]:
            result.update(status="catch_all", reason="domain_accepts_all")
        elif result["role"]:
            result.update(status="risky", reason="role_account")
        else:
            result.update(status="valid", reason="mailbox_exists")
    elif code in (550, 551, 552, 553, 554) or 500 <= code < 600:
        result.update(status="invalid", reason="mailbox_not_found")
    elif 400 <= code < 500:
        result.update(status="unknown", reason="greylisted_or_temp_failure")
    else:
        result.update(status="unknown", reason="no_smtp_response")
    return result
