"""Tell human opens/clicks apart from machine traffic.

Tracking pixels and links are fetched by far more than people: corporate mail scanners (Proofpoint, Mimecast,
Defender…), Apple Mail Privacy Protection (pre-loads every image on delivery), link-checkers and our own app when
it shows a sent email. Counting those makes campaigns look like 100% open rates. Each hit is classified here;
only human hits set ``opened_at`` / ``clicked_at``. Machine hits are still stored as events (with the reason) so
analytics can show how much was filtered.

Keep ``SCANNER_UA`` / ``GRACE_SECONDS`` in sync with the data migration that re-scores historic events.
"""

from datetime import datetime

from app.config import settings

# Opens/clicks this soon after sending are almost always delivery-time scanners, not people.
GRACE_SECONDS = 60

# Substrings (lower-case) of user agents that belong to security gateways, link checkers and bots.
# NB: Gmail's "GoogleImageProxy" and Yahoo's proxy only fetch when a person opens the email, so they count as human.
SCANNER_UA = (
    "barracuda", "proofpoint", "mimecast", "symantec", "messagelabs", "forcepoint", "trendmicro", "sophos",
    "fortinet", "ironport", "cisco", "zscaler", "checkpoint", "bitdefender", "kaspersky", "microsoft office existence",
    "safelinks", "bot", "crawler", "spider", "preview", "python", "curl", "wget", "go-http-client", "java/", "okhttp",
    "headless", "phantomjs", "axios", "node-fetch", "libwww", "httpclient",
)

# Apple Mail Privacy Protection fetches every remote image on delivery with this bare user agent.
APPLE_MPP_UA = "mozilla/5.0"


def machine_reason(*, ua: str | None, sent_at: datetime | None, at: datetime, referer: str | None = None) -> str | None:
    """Return why a hit looks automated, or ``None`` when it looks like a person."""
    u = (ua or "").strip().lower()
    if referer and settings.WEB_URL and referer.startswith(settings.WEB_URL.rstrip("/")):
        return "viewed inside Sigmaflux"
    if not u:
        return "no user agent"
    if u == APPLE_MPP_UA:
        return "Apple Mail Privacy Protection"
    if any(s in u for s in SCANNER_UA):
        return "security scanner / bot"
    if sent_at and (at - sent_at).total_seconds() < GRACE_SECONDS:
        return f"within {GRACE_SECONDS}s of sending"
    return None
