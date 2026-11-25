"""Keywords for lead research: what a business sells (5 search terms) and what those terms are worth.

Extraction  — the user's default AI integration reads the website text; without one, a heuristic picks phrases from
              the title and headings.
Metrics     — avg. monthly searches, competition and top-of-page bids from a "keywords" integration:
              * google_ads  — Google Ads API KeywordPlanIdeaService.GenerateKeywordHistoricalMetrics (Keyword Planner data).
                              Needs a Google Cloud project with Basic (or Standard) Google Ads API access and either a
                              service-account key (its email added as a user in Google Ads) or an OAuth client + refresh
                              token with the adwords scope, plus the Google Ads customer ID.
              * dataforseo  — DataForSEO's Google Ads search-volume endpoint (same Keyword Planner numbers, pay per call).
"""

import json
import re
import time
from collections import Counter

import httpx

from app.services import ai

GOOGLE_ADS_API_VERSION = "v26"

# Google's country criterion IDs are 2000 + the ISO 3166-1 numeric code (US 840 → 2840). DataForSEO uses the same IDs.
COUNTRY_ISO_NUMERIC = {
    "us": 840, "united states": 840, "usa": 840, "united states of america": 840, "in": 356, "india": 356,
    "gb": 826, "uk": 826, "united kingdom": 826, "england": 826, "ca": 124, "canada": 124, "au": 36, "australia": 36,
    "de": 276, "germany": 276, "fr": 250, "france": 250, "ae": 784, "uae": 784, "united arab emirates": 784,
    "sg": 702, "singapore": 702, "nz": 554, "new zealand": 554, "ie": 372, "ireland": 372, "nl": 528, "netherlands": 528,
    "es": 724, "spain": 724, "it": 380, "italy": 380, "br": 76, "brazil": 76, "mx": 484, "mexico": 484,
    "za": 710, "south africa": 710, "sa": 682, "saudi arabia": 682, "jp": 392, "japan": 392, "se": 752, "sweden": 752,
    "ch": 756, "switzerland": 756, "be": 56, "belgium": 56, "pl": 616, "poland": 616, "pt": 620, "portugal": 620,
    "my": 458, "malaysia": 458, "ph": 608, "philippines": 608, "id": 360, "indonesia": 360, "pk": 586, "pakistan": 586,
    "bd": 50, "bangladesh": 50, "ng": 566, "nigeria": 566, "ke": 404, "kenya": 404, "at": 40, "austria": 40,
    "dk": 208, "denmark": 208, "no": 578, "norway": 578, "fi": 246, "finland": 246, "il": 376, "israel": 376,
    "qa": 634, "qatar": 634, "hk": 344, "hong kong": 344, "lk": 144, "sri lanka": 144, "np": 524, "nepal": 524,
}
# Google Ads language constants for the languages offered in settings (others: set language_constant in the config).
LANGUAGE_CONSTANTS = {"en": 1000, "de": 1001, "fr": 1002, "es": 1003, "it": 1004, "ja": 1005, "nl": 1010, "pt": 1014,
                      "ar": 1019, "hi": 1023}
DEFAULT_LOCATION = 2840
DEFAULT_LANGUAGE = "en"


def location_for_country(country: str) -> int | None:
    n = COUNTRY_ISO_NUMERIC.get((country or "").strip().lower())
    return 2000 + n if n else None


# ── Extraction ───────────────────────────────────────────────────────────────

STOP = set("""a about above after again all also am an and any are as at be because been before being below best between
both but by can could did do does doing down during each few for from further get had has have having he her here hers how
i if in into is it its just like more most my no nor not now of off on once only or other our out over own same she should
so some such than that the their them then there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your yours home welcome page site website official us contact read
learn view click call today now new news blog menu login sign search cart shop all rights reserved copyright privacy policy
terms cookies inc ltd llc pvt limited co company services products solutions back close main skip content every
most popular top free trial features pricing demo started start get try more see explore discover find out let lets
one two three world worldwide leading trusted award winning online""".split())


def heuristic_keywords(title: str, headings: list[str], description: str, text: str, brand: str, n: int = 5) -> list[str]:
    """No AI available: the most repeated 2–3 word phrases from the title, headings and description (brand removed)."""
    brand_words = set(re.findall(r"[a-z0-9]+", brand.lower()))
    src = " . ".join([title, title, description or "", *[h.split(": ", 1)[-1] for h in headings], text[:3000]])
    words = re.findall(r"[a-z][a-z0-9]*(?:['-][a-z0-9]+)*", src.lower())
    counts: Counter = Counter()
    for size, weight in ((2, 2), (3, 3)):
        for i in range(len(words) - size + 1):
            gram = words[i:i + size]
            if gram[0] in STOP or gram[-1] in STOP or any(w in brand_words for w in gram) or any(len(w) < 3 for w in gram):
                continue
            counts[" ".join(gram)] += weight
    picked: list[str] = []
    for phrase, c in counts.most_common(60):
        if c < 4 or any(phrase in p or p in phrase for p in picked):
            continue
        picked.append(phrase)
        if len(picked) == n:
            break
    if len(picked) < n:  # top single words as a last resort
        single = Counter(w for w in words if w not in STOP and w not in brand_words and len(w) > 3)
        picked += [w for w, _ in single.most_common(20) if not any(w in p for p in picked)][: n - len(picked)]
    return picked[:n]


AI_MAX_TOKENS = 2000


def _json_from(reply: str) -> dict:
    """The JSON object in the reply (code fences and chatter around it are fine). A reply that was cut off still
    gives its keywords when the list itself is complete."""
    text = reply or ""
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except ValueError:
            pass
    lst = re.search(r'"keywords"\s*:\s*(\[[^\]]*\])', text)
    if lst:
        try:
            summary = re.search(r'"summary"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
            return {"keywords": json.loads(lst.group(1)), "summary": json.loads(f'"{summary.group(1)}"') if summary else ""}
        except ValueError:
            pass
    if not text.strip():
        raise ValueError("The AI returned an empty reply — the model may have used all its tokens thinking; try a non-reasoning model")
    if "{" in text and "}" not in text[text.index("{"):]:
        raise ValueError(f"The AI reply was cut off before the JSON finished: {text[:120]!r}")
    raise ValueError(f"The AI reply had no JSON: {text[:120]!r}")


async def ai_keywords(integ: dict, domain: str, facts: dict, text: str, extra_texts: list[str], n: int = 5) -> tuple[str, list[str]]:
    """(summary, keywords) from the user's AI provider. integ = {provider, api_key, model, base_url}."""
    content = "\n\n".join([
        f"Website: {domain}",
        f"Title: {facts.get('title') or ''}",
        f"Meta description: {facts.get('meta_description') or ''}",
        "Headings:\n" + "\n".join((facts.get("headings") or [])[:25]),
        "Homepage text:\n" + text[:6000],
        *[f"Another page:\n{t[:3000]}" for t in extra_texts],
    ])
    prompt = (
        f"{content}\n\n---\nFrom the website content above, work out what this business sells and who it sells to.\n"
        f"Then list exactly {n} Google search keywords a potential customer would type to find these products or "
        "services (not the business's own name). Each keyword: 2–4 words, lowercase, specific to what they offer, "
        "the way people actually search (e.g. \"industrial air compressor\", \"payroll software for small business\"). "
        "Only add a city or region if the business clearly serves one local area.\n"
        'Reply with JSON only, keywords first: {"keywords": ["...", ...], "summary": "<what they sell and to whom, max 25 words>"}'
    )
    # Thinking models (e.g. via OpenRouter) spend part of max_tokens on reasoning before they answer, so leave room.
    reply = await ai.complete(integ["provider"], integ["api_key"], prompt, model=integ.get("model"),
                              base_url=integ.get("base_url"), system="You are a precise B2B SEO strategist. Reply with JSON only.",
                              max_tokens=AI_MAX_TOKENS)
    data = _json_from(reply)
    kws = [re.sub(r"\s+", " ", str(k)).strip().lower() for k in data.get("keywords") or [] if str(k).strip()]
    return str(data.get("summary") or "").strip()[:500], list(dict.fromkeys(kws))[:n]


# ── Metrics providers ────────────────────────────────────────────────────────

def _int(v) -> int | None:
    try:
        return int(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _micros(v) -> float | None:
    n = _int(v)
    return round(n / 1_000_000, 2) if n is not None else None


GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords"


def parse_service_account(raw) -> dict:
    """A Google Cloud service-account JSON key (string or dict) → its fields; ValueError when it isn't one."""
    try:
        info = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
    except (TypeError, ValueError) as e:
        raise ValueError("The service account key isn't valid JSON — paste the whole downloaded .json file") from e
    if info.get("type") != "service_account" or not info.get("client_email") or not info.get("private_key"):
        raise ValueError("That JSON isn't a service account key (needs type, client_email and private_key)")
    return info


async def _google_token(client: httpx.AsyncClient, secrets: dict, cfg: dict) -> str:
    """Access token from a service-account key (signed JWT) or an OAuth refresh token."""
    if secrets.get("service_account"):
        from jose import jwt

        info = parse_service_account(secrets["service_account"])
        now = int(time.time())
        assertion = jwt.encode(
            {"iss": info["client_email"], "scope": ADWORDS_SCOPE, "aud": GOOGLE_TOKEN_URL, "iat": now, "exp": now + 3600},
            info["private_key"], algorithm="RS256", headers={"kid": info.get("private_key_id")} if info.get("private_key_id") else None,
        )
        r = await client.post(GOOGLE_TOKEN_URL, data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
        if r.status_code != 200:
            raise RuntimeError(f"Google refused the service account key: {r.text[:200]}")
        return r.json()["access_token"]
    r = await client.post(GOOGLE_TOKEN_URL, data={
        "client_id": cfg.get("client_id"), "client_secret": secrets.get("client_secret"),
        "refresh_token": secrets.get("refresh_token"), "grant_type": "refresh_token",
    })
    if r.status_code != 200:
        raise RuntimeError(f"Google OAuth refused the refresh token: {r.text[:200]}")
    return r.json()["access_token"]


def _ads_headers(token: str, secrets: dict, cfg: dict) -> dict:
    h = {"Authorization": f"Bearer {token}"}
    if secrets.get("developer_token"):  # optional since Sept 2026 (access comes from the Cloud project)
        h["developer-token"] = secrets["developer_token"]
    if cfg.get("login_customer_id"):
        h["login-customer-id"] = re.sub(r"\D", "", cfg["login_customer_id"])
    return h


def _ads_base(cfg: dict) -> str:
    cid = re.sub(r"\D", "", cfg.get("customer_id") or "")
    if not cid:
        raise ValueError("Google Ads customer ID is missing")
    return f"https://googleads.googleapis.com/{cfg.get('api_version') or GOOGLE_ADS_API_VERSION}/customers/{cid}"


def _ads_error(r: httpx.Response) -> str:
    try:
        err = r.json()
        if isinstance(err, list):
            err = err[0]
        e = err.get("error", {})
        details = e.get("details") or []
        codes = [str(x.get("errorCode")) for d in details for x in d.get("errors", []) if x.get("errorCode")]
        return f"Google Ads API {r.status_code}: {e.get('message', '')} {' '.join(codes)}".strip()[:400]
    except Exception:  # noqa: BLE001
        return f"Google Ads API {r.status_code}: {r.text[:300]}"


async def google_ads_currency(cfg: dict, secrets: dict) -> str:
    async with httpx.AsyncClient(timeout=30) as c:
        token = await _google_token(c, secrets, cfg)
        r = await c.post(f"{_ads_base(cfg)}/googleAds:search", headers=_ads_headers(token, secrets, cfg),
                         json={"query": "SELECT customer.currency_code, customer.descriptive_name FROM customer LIMIT 1"})
    if r.status_code != 200:
        raise RuntimeError(_ads_error(r))
    rows = r.json().get("results") or [{}]
    return rows[0].get("customer", {}).get("currencyCode", "")


async def google_ads_metrics(cfg: dict, secrets: dict, keywords: list[str], location: int | None, language: str) -> list[dict]:
    lang = cfg.get("language_constant") or LANGUAGE_CONSTANTS.get(language, 1000)
    body = {
        "keywords": keywords,
        "language": f"languageConstants/{lang}",
        "keywordPlanNetwork": "GOOGLE_SEARCH",
        "historicalMetricsOptions": {"includeAverageCpc": True},
    }
    if location:
        body["geoTargetConstants"] = [f"geoTargetConstants/{location}"]
    async with httpx.AsyncClient(timeout=60) as c:
        token = await _google_token(c, secrets, cfg)
        r = await c.post(f"{_ads_base(cfg)}:generateKeywordHistoricalMetrics", headers=_ads_headers(token, secrets, cfg), json=body)
    if r.status_code != 200:
        raise RuntimeError(_ads_error(r))
    currency = cfg.get("currency") or ""
    by_text: dict[str, dict] = {}
    for res in r.json().get("results", []):
        m = res.get("keywordMetrics") or {}
        row = {
            "volume": _int(m.get("avgMonthlySearches")),
            "competition": m.get("competition") if m.get("competition") not in (None, "UNSPECIFIED", "UNKNOWN") else None,
            "competition_index": _int(m.get("competitionIndex")),
            "low_bid": _micros(m.get("lowTopOfPageBidMicros")),
            "high_bid": _micros(m.get("highTopOfPageBidMicros")),
            "cpc": _micros(m.get("averageCpcMicros")),
            "currency": currency,
            "monthly": [_int(x.get("monthlySearches")) for x in (m.get("monthlySearchVolumes") or [])][-12:],
        }
        for t in [res.get("text", ""), *(res.get("closeVariants") or [])]:
            by_text.setdefault(t.lower(), row)
    return [{"keyword": k, **by_text.get(k.lower(), {})} for k in keywords]


async def dataforseo_metrics(cfg: dict, password: str, keywords: list[str], location: int | None, language: str) -> list[dict]:
    task = {"keywords": keywords, "language_code": language or DEFAULT_LANGUAGE}
    if location:
        task["location_code"] = location
    async with httpx.AsyncClient(timeout=90) as c:
        r = await c.post("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
                         auth=(cfg.get("login") or "", password), json=[task])
    if r.status_code != 200:
        raise RuntimeError(f"DataForSEO {r.status_code}: {r.text[:300]}")
    data = r.json()
    t = (data.get("tasks") or [{}])[0]
    if t.get("status_code") != 20000:
        raise RuntimeError(f"DataForSEO: {t.get('status_message') or data.get('status_message')}")
    by_text = {}
    for res in t.get("result") or []:
        comp = res.get("competition")
        by_text[(res.get("keyword") or "").lower()] = {
            "volume": _int(res.get("search_volume")),
            "competition": comp.upper() if isinstance(comp, str) else None,
            "competition_index": _int(res.get("competition_index")),
            "low_bid": res.get("low_top_of_page_bid"),
            "high_bid": res.get("high_top_of_page_bid"),
            "cpc": res.get("cpc"),
            "currency": "USD",
            "monthly": [_int(x.get("search_volume")) for x in reversed(res.get("monthly_searches") or [])][-12:],
        }
    return [{"keyword": k, **by_text.get(k.lower(), {})} for k in keywords]


async def metrics(provider: str, cfg: dict, secret: str, keywords: list[str], location: int | None, language: str) -> list[dict]:
    if provider == "google_ads":
        return await google_ads_metrics(cfg, json.loads(secret or "{}"), keywords, location, language)
    if provider == "dataforseo":
        return await dataforseo_metrics(cfg, secret, keywords, location, language)
    raise ValueError(f"Unknown keyword data provider '{provider}'")
