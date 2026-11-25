"""Website audit for lead research: fetches a lead's homepage (plus robots.txt, sitemap, a few links) and lists what's
broken or missing. Every issue has a stable ``code`` so sequences can branch on it (see ISSUES).

Only public addresses are fetched: every request (including each redirect hop) is checked against private, loopback,
link-local and reserved ranges, so a lead's "website" can't be used to reach the server's own network.
"""

import asyncio
import ipaddress
import re
import socket
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)
MAX_HTML_BYTES = 3 * 1024 * 1024
MAX_LINKS_CHECKED = 30
SLOW_MS = 3000
SEVERITY_POINTS = {"high": 15, "medium": 7, "low": 3}

# code → (severity, category, title). Titles are written to read well inside an email ({{TopIssue}}).
ISSUES: dict[str, tuple[str, str, str]] = {
    "site_unreachable": ("high", "technical", "Website doesn't load"),
    "http_error": ("high", "technical", "Homepage returns an error"),
    "no_https": ("high", "security", "No HTTPS (site isn't secure)"),
    "ssl_invalid": ("high", "security", "SSL certificate is invalid"),
    "no_https_redirect": ("medium", "security", "HTTP doesn't redirect to HTTPS"),
    "mixed_content": ("medium", "security", "Insecure (HTTP) resources on an HTTPS page"),
    "missing_title": ("high", "seo", "Missing page title"),
    "title_too_short": ("low", "seo", "Page title is too short"),
    "title_too_long": ("low", "seo", "Page title is too long"),
    "missing_meta_description": ("medium", "seo", "Missing meta description"),
    "meta_description_too_short": ("low", "seo", "Meta description is too short"),
    "meta_description_too_long": ("low", "seo", "Meta description is too long"),
    "missing_h1": ("high", "seo", "No H1 heading"),
    "multiple_h1": ("medium", "seo", "Multiple H1 headings"),
    "heading_order": ("low", "seo", "Heading levels are skipped"),
    "noindex": ("high", "seo", "Homepage is blocked from Google (noindex)"),
    "missing_canonical": ("low", "seo", "No canonical URL"),
    "missing_sitemap": ("medium", "seo", "No XML sitemap"),
    "missing_robots_txt": ("low", "seo", "No robots.txt"),
    "no_structured_data": ("low", "seo", "No structured data (schema.org)"),
    "missing_open_graph": ("low", "seo", "No social sharing tags (Open Graph)"),
    "images_missing_alt": ("medium", "seo", "Images without alt text"),
    "thin_content": ("medium", "content", "Very little text on the homepage"),
    "broken_links": ("high", "technical", "Broken links"),
    "soft_404": ("low", "technical", "Missing pages don't return a 404"),
    "not_mobile_friendly": ("high", "mobile", "Not mobile-friendly (no viewport tag)"),
    "slow_response": ("medium", "performance", "Slow server response"),
    "large_page": ("low", "performance", "Homepage HTML is very large"),
    "no_compression": ("low", "performance", "No gzip/brotli compression"),
    "poor_performance": ("high", "performance", "Poor mobile PageSpeed score"),
    "average_performance": ("medium", "performance", "Mobile PageSpeed could be better"),
    "missing_favicon": ("low", "branding", "No favicon"),
    "missing_lang": ("low", "accessibility", "Page language isn't declared"),
    "no_analytics": ("low", "marketing", "No analytics tracking detected"),
    "outdated_copyright": ("low", "content", "Outdated copyright year in footer"),
}

ANALYTICS_RE = re.compile(
    r"googletagmanager\.com|google-analytics\.com|gtag\(|analytics\.js|fbq\(|connect\.facebook\.net|plausible\.io|"
    r"matomo|clarity\.ms|hotjar|segment\.(?:com|io)|mixpanel|posthog|static\.hsappstatic|js\.hs-scripts",
    re.I,
)
COPYRIGHT_RE = re.compile(r"(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?((?:19|20)\d{2})", re.I)
SERVICE_PATH_RE = re.compile(r"service|product|solution|what-we-do|offer|shop|collection|pricing|about|capabilit|industr", re.I)


class BlockedAddress(Exception):
    """The URL resolves to a non-public address."""


# ── Domains ──────────────────────────────────────────────────────────────────

FREE_MAIL = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "ymail.com", "outlook.com", "hotmail.com",
    "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me", "gmx.com",
    "gmx.de", "web.de", "yandex.com", "yandex.ru", "mail.com", "mail.ru", "rediffmail.com", "zoho.com", "qq.com",
    "163.com", "126.com", "hey.com", "fastmail.com", "tutanota.com",
}


def split_site(website: str) -> tuple[str, str] | None:
    """A lead's website value → (domain key without www, host to fetch). None when it isn't a usable website."""
    w = (website or "").strip()
    if not w or " " in w:
        return None
    if not re.match(r"^https?://", w, re.I):
        w = "https://" + w.lstrip("/")
    try:
        host = (urlparse(w).hostname or "").lower().rstrip(".")
    except ValueError:
        return None
    if "." not in host or not re.match(r"^[a-z0-9.-]+$", host) or host.replace(".", "").isdigit():
        return None
    domain = host[4:] if host.startswith("www.") else host
    if domain in FREE_MAIL or domain in {"linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com"}:
        return None
    return domain, host


def domain_for(website: str, email: str = "", use_email: bool = True) -> tuple[str, str] | None:
    got = split_site(website)
    if got or not use_email or "@" not in (email or ""):
        return got
    return split_site(email.rsplit("@", 1)[1])


# ── Safe fetching ────────────────────────────────────────────────────────────

def _public(ip: str) -> bool:
    a = ipaddress.ip_address(ip.split("%", 1)[0])
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.is_global and not a.is_multicast


def safe_client(timeout: float = 15.0, verify: bool = True) -> httpx.AsyncClient:
    """httpx client that refuses non-public destinations — checked before every request, including redirects."""
    cache: dict[str, bool] = {}

    async def guard(request: httpx.Request) -> None:
        url = request.url
        if url.scheme not in ("http", "https") or (url.port not in (None, 80, 443)):
            raise BlockedAddress(f"{url.scheme}://{url.host}:{url.port} isn't allowed")
        host = url.host
        if host not in cache:
            try:
                infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
            except socket.gaierror as e:
                raise httpx.ConnectError(f"DNS lookup failed for {host}: {e}", request=request) from e
            cache[host] = bool(infos) and all(_public(i[4][0]) for i in infos)
        if not cache[host]:
            raise BlockedAddress(f"{host} resolves to a private address")

    return httpx.AsyncClient(
        timeout=timeout, follow_redirects=True, max_redirects=6, verify=verify,
        headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en"},
        event_hooks={"request": [guard]},
    )


async def _get_text(client: httpx.AsyncClient, url: str, limit: int = MAX_HTML_BYTES) -> tuple[httpx.Response, str, int]:
    """GET with a size cap. Returns (response, text, bytes read)."""
    async with client.stream("GET", url) as r:
        chunks, size = [], 0
        async for chunk in r.aiter_bytes():
            chunks.append(chunk)
            size += len(chunk)
            if size >= limit:
                break
        body = b"".join(chunks)
    enc = r.encoding or "utf-8"
    try:
        text = body.decode(enc, errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    return r, text, size


def _is_ssl_error(e: Exception) -> bool:
    s = f"{type(e).__name__} {e}".lower()
    return "ssl" in s or "certificate" in s or "tls" in s


# ── HTML checks ──────────────────────────────────────────────────────────────

def _text_of(soup: BeautifulSoup) -> str:
    body = soup.body or soup
    for t in body.find_all(["script", "style", "noscript", "template", "svg"]):
        t.decompose()
    return re.sub(r"\s+", " ", body.get_text(" ")).strip()


def parse_page(html: str, page_url: str) -> dict:
    """Everything the audit and the keyword step need from one HTML page."""
    soup = BeautifulSoup(html, "html.parser")
    meta = lambda **kw: soup.find("meta", attrs=kw)  # noqa: E731
    desc_tag = meta(name=re.compile("^description$", re.I))
    robots_tag = meta(name=re.compile("^robots$", re.I))
    title = (soup.title.get_text(" ", strip=True) if soup.title else "").strip()
    headings = [(int(h.name[1]), re.sub(r"\s+", " ", h.get_text(" ", strip=True))) for h in soup.find_all(re.compile(r"^h[1-6]$"))]
    imgs = soup.find_all("img")
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("mailto:", "tel:", "javascript:", "#", "data:")):
            continue
        absolute = urljoin(page_url, href).split("#", 1)[0]
        if absolute.startswith(("http://", "https://")):
            links.append((absolute, re.sub(r"\s+", " ", a.get_text(" ", strip=True))[:80]))
    insecure = []
    if page_url.startswith("https://"):
        for tag, attr in (("img", "src"), ("script", "src"), ("iframe", "src"), ("source", "src"), ("video", "src"), ("audio", "src")):
            insecure += [t[attr] for t in soup.find_all(tag, attrs={attr: re.compile(r"^http://", re.I)})]
        insecure += [t["href"] for t in soup.find_all("link", href=re.compile(r"^http://", re.I))
                     if "stylesheet" in " ".join(t.get("rel") or []).lower()]
    raw = html
    years = [int(y) for y in COPYRIGHT_RE.findall(raw)]
    favicon = any("icon" in " ".join(t.get("rel") or []).lower() for t in soup.find_all("link"))
    facts = {
        "title": title,
        "meta_description": (desc_tag.get("content") or "").strip() if desc_tag else None,
        "h1": [t for lvl, t in headings if lvl == 1],
        "headings": [f"h{lvl}: {t}"[:140] for lvl, t in headings[:40]],
        "heading_levels": [lvl for lvl, _ in headings],
        "lang": (soup.html.get("lang") or "").strip() if soup.html else "",
        "viewport": bool(meta(name=re.compile("^viewport$", re.I))),
        "canonical": next((t.get("href") for t in soup.find_all("link") if "canonical" in " ".join(t.get("rel") or []).lower()), None),
        "robots_meta": (robots_tag.get("content") or "").lower() if robots_tag else "",
        "open_graph": bool(meta(property=re.compile(r"^og:(title|image)$", re.I))),
        "structured_data": bool(soup.find("script", type=re.compile("ld\\+json", re.I)) or soup.find(attrs={"itemscope": True})),
        "favicon_tag": favicon,
        "images": len(imgs),
        "images_missing_alt": sum(1 for i in imgs if i.get("alt") is None),
        "analytics": bool(ANALYTICS_RE.search(raw)),
        "copyright_year": max(years) if years else None,
        "insecure_resources": insecure[:10],
        "insecure_count": len(insecure),
    }
    text = _text_of(soup)
    facts["word_count"] = len(text.split())
    return {"facts": facts, "text": text, "links": links}


# ── The audit ────────────────────────────────────────────────────────────────

def _issue(code: str, detail: str = "") -> dict:
    sev, cat, title = ISSUES[code]
    return {"code": code, "severity": sev, "category": cat, "title": title, "detail": detail}


def score_of(issues: list[dict]) -> int:
    if any(i["code"] == "site_unreachable" for i in issues):
        return 0
    return max(0, 100 - sum(SEVERITY_POINTS[i["severity"]] for i in issues))


def issues_from(f: dict, now_year: int | None = None) -> list[dict]:
    """Facts (from parse_page + fetches) → issue list. Pure, so it's easy to test."""
    now_year = now_year or datetime.now(timezone.utc).year
    out: list[dict] = []
    add = lambda code, detail="": out.append(_issue(code, detail))  # noqa: E731

    if f.get("unreachable"):
        add("site_unreachable", f.get("unreachable"))
        return out
    status = f.get("status") or 0
    if status >= 400:
        add("http_error", f"The homepage answered HTTP {status}")
    if f.get("ssl_invalid"):
        add("ssl_invalid", f.get("ssl_invalid"))
    if not f.get("https") and not f.get("ssl_invalid"):
        add("no_https", "The site only loads over plain HTTP")
    elif f.get("http_redirects_to_https") is False:
        add("no_https_redirect", "http:// stays on the insecure version instead of redirecting to https://")
    if f.get("insecure_count"):
        add("mixed_content", f"{f['insecure_count']} resource(s) loaded over http://, e.g. {f['insecure_resources'][0]}")

    title = f.get("title") or ""
    if not title:
        add("missing_title")
    elif len(title) < 20:
        add("title_too_short", f"“{title}” ({len(title)} characters; aim for 30–60)")
    elif len(title) > 65:
        add("title_too_long", f"{len(title)} characters — Google cuts it off around 60")
    desc = f.get("meta_description")
    if not desc:
        add("missing_meta_description", "Google will pick random page text for the search snippet")
    elif len(desc) < 70:
        add("meta_description_too_short", f"{len(desc)} characters; aim for 120–160")
    elif len(desc) > 170:
        add("meta_description_too_long", f"{len(desc)} characters — it gets cut off in search results")
    h1 = f.get("h1") or []
    if not h1:
        add("missing_h1")
    elif len(h1) > 1:
        add("multiple_h1", f"{len(h1)} H1s: " + " · ".join(f"“{h[:50]}”" for h in h1[:4]))
    levels = f.get("heading_levels") or []
    skips = [(a, b) for a, b in zip(levels, levels[1:]) if b > a + 1]
    if skips:
        add("heading_order", f"e.g. H{skips[0][0]} followed by H{skips[0][1]}")
    if "noindex" in (f.get("robots_meta") or ""):
        add("noindex", f"robots meta tag: “{f['robots_meta']}”")
    if not f.get("canonical"):
        add("missing_canonical")
    if f.get("sitemap") is False:
        add("missing_sitemap", "No sitemap at /sitemap.xml or in robots.txt")
    if f.get("robots_txt") is False:
        add("missing_robots_txt")
    if not f.get("structured_data"):
        add("no_structured_data", "No schema.org markup — no rich results in Google")
    if not f.get("open_graph"):
        add("missing_open_graph", "Links shared on LinkedIn/Facebook show no preview image or title")
    if f.get("images_missing_alt"):
        add("images_missing_alt", f"{f['images_missing_alt']} of {f['images']} images have no alt text")
    wc = f.get("word_count")
    if wc is not None and wc < 250:
        add("thin_content", f"Only {wc} word{'' if wc == 1 else 's'} of text on the homepage")
    broken = f.get("broken_links") or []
    if broken:
        add("broken_links", f"{len(broken)} broken link(s), e.g. {broken[0]['url']} ({broken[0]['status']})")
    if f.get("soft_404"):
        add("soft_404", "A page that doesn't exist still returns HTTP 200")
    if not f.get("viewport"):
        add("not_mobile_friendly", "No <meta name=viewport> — the page renders zoomed-out on phones")
    load_ms = f.get("load_ms") or 0
    if load_ms > SLOW_MS:
        add("slow_response", f"The homepage took {load_ms / 1000:.1f}s to download")
    if (f.get("html_bytes") or 0) > 1_500_000:
        add("large_page", f"{f['html_bytes'] / 1_000_000:.1f} MB of HTML")
    if f.get("compressed") is False and (f.get("html_bytes") or 0) > 20_000:
        add("no_compression")
    ps = f.get("pagespeed") or {}
    if ps.get("score") is not None:
        lcp = f", LCP {ps['lcp_ms'] / 1000:.1f}s" if ps.get("lcp_ms") else ""
        if ps["score"] < 50:
            add("poor_performance", f"PageSpeed {ps['score']}/100 on mobile{lcp}")
        elif ps["score"] < 90:
            add("average_performance", f"PageSpeed {ps['score']}/100 on mobile{lcp}")
    if not f.get("favicon"):
        add("missing_favicon")
    if not f.get("lang"):
        add("missing_lang")
    if not f.get("analytics"):
        add("no_analytics", "No Google Analytics, Tag Manager, Meta Pixel or similar found")
    year = f.get("copyright_year")
    if year and year < now_year - 1:
        add("outdated_copyright", f"Footer says © {year}")
    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda i: order[i["severity"]])
    return out


async def _check_link(client: httpx.AsyncClient, url: str, internal: bool) -> dict | None:
    """A broken link → {url, status}; None when it works (or the result is ambiguous, e.g. bot protection)."""
    try:
        r = await client.head(url, timeout=8)
        if r.status_code in (403, 405, 501) or r.status_code >= 500:
            r = await client.get(url, timeout=10)
        code = r.status_code
    except BlockedAddress:
        return None
    except httpx.ConnectError:
        return {"url": url, "status": "can't connect"}
    except Exception:  # noqa: BLE001 — timeouts and odd servers aren't proof of a broken link
        return None
    if code in (404, 410) or (internal and code >= 500 and code not in (503, 520, 521, 522, 523, 524, 525, 526)):
        return {"url": url, "status": code}
    return None


async def _exists(client: httpx.AsyncClient, url: str, must: re.Pattern | None = None) -> bool:
    try:
        r, text, _ = await _get_text(client, url, limit=256 * 1024)
    except Exception:  # noqa: BLE001
        return False
    if r.status_code != 200:
        return False
    return bool(must.search(text)) if must else "html" not in (r.headers.get("content-type") or "")


async def pagespeed(url: str, api_key: str | None = None) -> dict:
    params = {"url": url, "strategy": "mobile", "category": "performance"}
    if api_key:
        params["key"] = api_key
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", params=params)
    r.raise_for_status()
    lh = r.json().get("lighthouseResult", {})
    audits = lh.get("audits", {})
    num = lambda k: audits.get(k, {}).get("numericValue")  # noqa: E731
    score = lh.get("categories", {}).get("performance", {}).get("score")
    return {
        "score": round(score * 100) if score is not None else None,
        "lcp_ms": round(num("largest-contentful-paint")) if num("largest-contentful-paint") is not None else None,
        "fcp_ms": round(num("first-contentful-paint")) if num("first-contentful-paint") is not None else None,
        "tbt_ms": round(num("total-blocking-time")) if num("total-blocking-time") is not None else None,
        "cls": round(num("cumulative-layout-shift"), 3) if num("cumulative-layout-shift") is not None else None,
    }


async def audit(host: str, *, run_pagespeed: bool = False, pagespeed_key: str | None = None) -> dict:
    """Audit https://<host>/. Returns {url, final_url, facts, issues, score, text, extra_texts}.

    ``text`` / ``extra_texts`` (homepage + up to 2 service/product pages) feed the keyword step.
    """
    url = f"https://{host}/"
    f: dict = {}
    page = None
    verify = True
    async with safe_client() as client:
        started = time.perf_counter()
        resp = text = None
        try:
            resp, text, size = await _get_text(client, url)
            f["https"] = urlparse(str(resp.url)).scheme == "https"
        except BlockedAddress as e:
            f["unreachable"] = str(e)
        except Exception as e:  # noqa: BLE001
            if _is_ssl_error(e):
                f["ssl_invalid"] = f"{type(e).__name__}: {str(e)[:160]}"
                verify = False
            try:  # SSL problems: audit what visitors see after clicking through; no HTTPS at all: try plain HTTP
                async with safe_client(verify=verify) as c2:
                    started = time.perf_counter()
                    resp, text, size = await _get_text(c2, url if not verify else f"http://{host}/")
                f["https"] = urlparse(str(resp.url)).scheme == "https" and not f.get("ssl_invalid")
            except Exception as e2:  # noqa: BLE001
                f["unreachable"] = f"{type(e2).__name__}: {str(e2)[:200]}"
        if resp is None:
            issues = issues_from(f)
            return {"url": url, "final_url": None, "facts": f, "issues": issues, "score": score_of(issues), "text": "", "extra_texts": []}

        final = str(resp.url)
        f.update(status=resp.status_code, final_url=final, load_ms=round((time.perf_counter() - started) * 1000),
                 html_bytes=size, compressed=bool(resp.headers.get("content-encoding")),
                 server=resp.headers.get("server"))
        page = parse_page(text or "", final)
        f.update(page["facts"])

    async with safe_client(verify=verify) as client:
        origin = f"{urlparse(final).scheme}://{urlparse(final).netloc}"
        base_host = urlparse(final).hostname or host
        same_site = lambda u: (urlparse(u).hostname or "").removeprefix("www.") == base_host.removeprefix("www.")  # noqa: E731

        async def http_redirect() -> bool | None:
            if not f.get("https"):
                return None
            try:
                r = await client.get(f"http://{host}/", timeout=10)
                return urlparse(str(r.url)).scheme == "https"
            except Exception:  # noqa: BLE001 — port 80 closed: nothing insecure to land on
                return None

        async def robots() -> tuple[bool, list[str]]:
            try:
                r, body, _ = await _get_text(client, f"{origin}/robots.txt", limit=128 * 1024)
            except Exception:  # noqa: BLE001
                return False, []
            ok = r.status_code == 200 and "html" not in (r.headers.get("content-type") or "") and "<html" not in body[:500].lower()
            return ok, re.findall(r"(?im)^\s*sitemap:\s*(\S+)", body) if ok else []

        async def soft_404() -> bool:
            try:
                r = await client.get(f"{origin}/{uuid.uuid4().hex[:12]}-not-a-real-page", timeout=10)
                return r.status_code == 200
            except Exception:  # noqa: BLE001
                return False

        async def favicon() -> bool:
            return f.get("favicon_tag") or await _exists(client, f"{origin}/favicon.ico")

        seen, internal, external = set(), [], []
        for u, _ in page["links"]:
            if u in seen or u.rstrip("/") == final.rstrip("/"):
                continue
            seen.add(u)
            (internal if same_site(u) else external).append(u)
        to_check = [(u, True) for u in internal[:20]] + [(u, False) for u in external[: MAX_LINKS_CHECKED - min(20, len(internal))]]
        sem = asyncio.Semaphore(8)

        async def check(u: str, inner: bool):
            async with sem:
                return await _check_link(client, u, inner)

        redirect, (robots_ok, sitemaps), is_soft_404, has_favicon, *link_results = await asyncio.gather(
            http_redirect(), robots(), soft_404(), favicon(), *(check(u, i) for u, i in to_check),
        )
        f.update(http_redirects_to_https=redirect, robots_txt=robots_ok, soft_404=is_soft_404, favicon=has_favicon,
                 links_checked=len(to_check), broken_links=[b for b in link_results if b])
        sitemap_ok = False
        for sm in (sitemaps or []) + [f"{origin}/sitemap.xml", f"{origin}/sitemap_index.xml", f"{origin}/wp-sitemap.xml"]:
            if await _exists(client, sm, re.compile(r"<(urlset|sitemapindex)", re.I)):
                sitemap_ok = True
                break
        f["sitemap"] = sitemap_ok

        # Up to two product / service pages give the keyword step more to work with.
        extra_texts: list[str] = []
        candidates = [u for u, label in page["links"] if same_site(u) and SERVICE_PATH_RE.search(urlparse(u).path + " " + label)]
        for u in list(dict.fromkeys(candidates))[:2]:
            try:
                r, body, _ = await _get_text(client, u, limit=1024 * 1024)
                if r.status_code == 200 and "html" in (r.headers.get("content-type") or "html"):
                    p = parse_page(body, str(r.url))
                    extra_texts.append(f"{p['facts']['title']}\n" + "\n".join(p["facts"]["headings"][:15]) + "\n" + p["text"][:4000])
            except Exception:  # noqa: BLE001
                pass

    if run_pagespeed:
        try:
            f["pagespeed"] = await pagespeed(final, pagespeed_key)
        except Exception as e:  # noqa: BLE001 — PageSpeed is a bonus; the audit stands without it
            f["pagespeed"] = {"score": None, "error": f"{type(e).__name__}: {str(e)[:160]}"}

    issues = issues_from(f)
    f.pop("heading_levels", None)
    f.pop("favicon_tag", None)
    return {"url": url, "final_url": final, "facts": f, "issues": issues, "score": score_of(issues),
            "text": page["text"], "extra_texts": extra_texts}
