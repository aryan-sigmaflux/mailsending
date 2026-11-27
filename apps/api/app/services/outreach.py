"""Who we've emailed before, and who we must never email (the do-not-contact list).

Every email that leaves the platform is a ``Message`` row keyed by recipient address, so "have we contacted X, when,
from which campaign" is answered from messages. That covers campaign emails and one-off emails alike, including
addresses that were never saved as contacts.

Do-not-contact entries live in ``suppressions``: an exact address, or a whole domain stored as "@domain.com".
Unsubscribes, bounces and complaints are added automatically; the user adds the rest by hand.
"""

import re
import uuid

from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Campaign, Message, Suppression

# "failed" never left our server, so it doesn't count as contact.
SENT_STATUSES = ("sent", "bounced")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
CHUNK = 5000

REASON_LABELS = {"manual": "Do not contact", "unsubscribed": "Unsubscribed", "bounced": "Bounced", "complained": "Complained"}


def domain_key(email: str) -> str:
    return "@" + email.rsplit("@", 1)[-1].lower()


def normalize_entry(raw: str) -> str | None:
    """A typed / pasted do-not-contact entry → "name@x.com" or "@x.com" (whole domain). None when unusable.

    Accepts "name@x.com", "@x.com", "*@x.com", "x.com", "https://www.x.com/about".
    """
    s = raw.strip().lower().strip("<>,;\"' \t")
    if not s:
        return None
    if "@" in s:
        local, _, dom = s.rpartition("@")
        if not DOMAIN_RE.match(dom):
            return None
        if local in ("", "*"):
            return f"@{dom}"
        return s if EMAIL_RE.match(s) else None
    s = re.sub(r"^https?://", "", s).removeprefix("www.").split("/")[0].split("?")[0]
    return f"@{s}" if DOMAIN_RE.match(s) else None


def dnc_clause(user_id: uuid.UUID, email_col):
    """SQL condition: the address in ``email_col`` is on the do-not-contact list, exactly or by its domain."""
    return exists().where(
        Suppression.user_id == user_id,
        or_(Suppression.email == email_col, Suppression.email == func.concat("@", func.split_part(email_col, "@", 2))),
    )


def contacted_clause(user_id: uuid.UUID, email_col, exclude_campaign: uuid.UUID | None = None):
    """SQL condition: at least one email has gone to the address in ``email_col`` (optionally ignoring one campaign)."""
    cond = [Message.user_id == user_id, Message.to_email == email_col, Message.status.in_(SENT_STATUSES)]
    if exclude_campaign:
        cond.append(or_(Message.campaign_id.is_(None), Message.campaign_id != exclude_campaign))
    return exists().where(*cond)


def _chunks(items: list[str]):
    for i in range(0, len(items), CHUNK):
        yield items[i:i + CHUNK]


async def dnc_entries(db: AsyncSession, user_id: uuid.UUID, emails) -> dict[str, dict]:
    """email → {"entry", "reason", "label", "note"} for every address that is blocked (by address or domain)."""
    emails = {e.lower() for e in emails if e}
    keys = sorted(emails | {domain_key(e) for e in emails})
    found: dict[str, Suppression] = {}
    for part in _chunks(keys):
        for s in (await db.execute(select(Suppression).where(Suppression.user_id == user_id, Suppression.email.in_(part)))).scalars():
            found[s.email] = s
    out = {}
    for e in emails:
        s = found.get(e) or found.get(domain_key(e))
        if s:
            out[e] = {"entry": s.email, "reason": s.reason, "label": REASON_LABELS.get(s.reason, s.reason), "note": s.note or ""}
    return out


async def blocked(db: AsyncSession, user_id: uuid.UUID, email: str) -> dict | None:
    """The do-not-contact entry that blocks ``email``, if any."""
    return (await dnc_entries(db, user_id, [email])).get(email.lower())


async def history(db: AsyncSession, user_id: uuid.UUID, emails) -> dict[str, dict]:
    """email → outreach summary, only for addresses that have been emailed at least once."""
    emails = sorted({e.lower() for e in emails if e})
    rows = []
    for part in _chunks(emails):
        rows += (await db.execute(
            select(Message.to_email, func.count(), func.max(Message.sent_at), func.count(Message.opened_at),
                   func.count(Message.clicked_at), func.count(Message.replied_at),
                   func.count().filter(Message.status == "bounced"),
                   func.array_agg(func.distinct(Message.campaign_id)))
            .where(Message.user_id == user_id, Message.to_email.in_(part), Message.status.in_(SENT_STATUSES))
            .group_by(Message.to_email)
        )).all()
    camp_ids = {c for r in rows for c in (r[7] or []) if c}
    names = dict((await db.execute(select(Campaign.id, Campaign.name).where(Campaign.id.in_(camp_ids)))).all()) if camp_ids else {}
    out = {}
    for email, sent, last, opened, clicked, replied, bounced, cids in rows:
        cids = cids or []
        out[email] = {
            "sent": sent, "last_sent_at": last, "opened": opened, "clicked": clicked, "replied": replied, "bounced": bounced,
            "campaigns": [{"id": c, "name": names.get(c, "Deleted campaign")} for c in cids if c],
            "direct": any(c is None for c in cids),  # one-off emails composed outside a campaign
        }
    return out
