"""Template rendering: variables with fallbacks, spintax, link/open tracking and unsubscribe links.

Syntax
  {{FirstName}}            → contact value (case/underscore-insensitive: first_name, FirstName, firstname)
  {{Name|there}}           → fallback when the value is empty
  {Hi|Hello|Hey}           → spintax, one option picked at random
  {{unsubscribe_url}}      → one-click unsubscribe link
"""

import random
import re
import uuid
from urllib.parse import parse_qs, quote, urlparse

from bs4 import BeautifulSoup

from app.config import settings
from app.core.tokens import sign_message
from app.models.contact import STANDARD_FIELDS

VAR_RE = re.compile(r"\{\{\s*([A-Za-z0-9_ .\-]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}")
SPIN_RE = re.compile(r"(?<!\{)\{([^{}]*\|[^{}]*)\}(?!\})")
SYSTEM_VARS = {"unsubscribe_url", "sender_name", "sender_email"}

# Friendly aliases → canonical contact keys.
ALIASES = {
    "name": "first_name", "firstname": "first_name", "first": "first_name",
    "lastname": "last_name", "last": "last_name", "surname": "last_name",
    "fullname": "full_name", "companyname": "company", "organization": "company", "organisation": "company",
    "jobtitle": "title", "position": "title", "designation": "title",
    "linkedin": "linkedin_url", "site": "website", "url": "website", "location": "city",
}


def norm_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def extract_variables(*texts: str) -> list[str]:
    seen: dict[str, None] = {}
    for text in texts:
        for m in VAR_RE.finditer(text or ""):
            if norm_key(m.group(1)) not in {norm_key(s) for s in SYSTEM_VARS}:
                seen.setdefault(m.group(1).strip(), None)
    return list(seen)


def contact_context(contact) -> dict[str, str]:
    """Flatten a Contact (standard + custom CSV/Apollo fields) into a normalized-key lookup."""
    ctx: dict[str, str] = {}
    for f in STANDARD_FIELDS:
        ctx[norm_key(f)] = str(getattr(contact, f, "") or "")
    first, last = ctx.get("firstname", ""), ctx.get("lastname", "")
    ctx["fullname"] = f"{first} {last}".strip()
    for k, v in (getattr(contact, "fields", None) or {}).items():
        if v not in (None, ""):
            ctx[norm_key(k)] = str(v)
    return ctx


def lookup(ctx: dict[str, str], key: str) -> str:
    k = norm_key(key)
    if ctx.get(k):
        return ctx[k]
    alias = ALIASES.get(k)
    return ctx.get(norm_key(alias), "") if alias else ""


def missing_variables(variables: list[str], ctx: dict[str, str]) -> list[str]:
    return [v for v in variables if not lookup(ctx, v)]


def _sub_vars(text: str, ctx: dict[str, str], system: dict[str, str]) -> str:
    def repl(m: re.Match) -> str:
        key, fallback = m.group(1), m.group(2)
        nk = norm_key(key)
        for sk, sv in system.items():
            if norm_key(sk) == nk:
                return sv
        return lookup(ctx, key) or (fallback or "")

    return VAR_RE.sub(repl, text or "")


def _spin(text: str, rng: random.Random) -> str:
    for _ in range(10):  # supports a little nesting
        new = SPIN_RE.sub(lambda m: rng.choice(m.group(1).split("|")), text)
        if new == text:
            break
        text = new
    return text


def tracking_base() -> str:
    return settings.PUBLIC_API_URL.rstrip("/") + settings.API_PREFIX + "/t"


def unsubscribe_url(message_id: uuid.UUID) -> str:
    return f"{tracking_base()}/u/{sign_message(message_id, 'u')}"


def _track_links(html: str, message_id: uuid.UUID) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href.lower().startswith(("http://", "https://")) or a.get("data-notrack") is not None:
            continue
        if "/t/u/" in href:  # never wrap the unsubscribe link
            continue
        token = sign_message(message_id, href)
        a["href"] = f"{tracking_base()}/c/{token}?u={quote(href, safe='')}"
    return str(soup)


def render(
    subject: str,
    body_html: str,
    contact,
    *,
    message_id: uuid.UUID | None = None,
    track_opens: bool = False,
    track_clicks: bool = False,
    sender_name: str = "",
    sender_email: str = "",
    signature_html: str = "",
    seed: int | None = None,
) -> tuple[str, str]:
    rng = random.Random(seed)
    ctx = contact_context(contact) if contact is not None else {}
    system = {
        "unsubscribe_url": unsubscribe_url(message_id) if message_id else "#unsubscribe",
        "sender_name": sender_name,
        "sender_email": sender_email,
    }
    subj = _spin(_sub_vars(subject, ctx, system), rng)
    body = _spin(_sub_vars(body_html, ctx, system), rng)
    if signature_html:
        body += f'<div class="signature">{_sub_vars(signature_html, ctx, system)}</div>'
    if message_id and track_clicks:
        body = _track_links(body, message_id)
    if message_id and track_opens:
        pixel = f"{tracking_base()}/o/{sign_message(message_id, 'o')}.gif"
        body += f'<img src="{pixel}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />'
    return subj.strip(), body


def strip_tracking(html: str) -> str:
    """Remove the open pixel and unwrap tracked links, for showing a sent email inside the app.

    Rendering the stored HTML as-is would load the pixel / follow tracked links from the sender's own browser and
    register fake opens and clicks.
    """
    if "/t/o/" not in (html or "") and "/t/c/" not in (html or ""):
        return html or ""
    soup = BeautifulSoup(html, "html.parser")
    for img in soup.find_all("img", src=True):
        if "/t/o/" in img["src"]:
            img.decompose()
    for a in soup.find_all("a", href=True):
        if "/t/c/" in a["href"]:
            original = parse_qs(urlparse(a["href"]).query).get("u")
            if original:
                a["href"] = original[0]
    return str(soup)


def html_to_text(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    for img in soup.find_all("img"):
        img.decompose()
    for a in soup.find_all("a", href=True):
        a.replace_with(f"{a.get_text()} ({a['href']})")
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for p in soup.find_all(["p", "div", "li"]):
        p.append("\n")
    return re.sub(r"\n{3,}", "\n\n", soup.get_text()).strip()
