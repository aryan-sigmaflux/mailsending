"""Domain health checker: MX, SPF, DKIM, DMARC, ownership TXT and DNS blacklists."""

import asyncio
from datetime import datetime, timezone

import dns.asyncresolver
import dns.exception
import dns.resolver

COMMON_DKIM_SELECTORS = [
    "google", "selector1", "selector2", "default", "dkim", "mail", "k1", "k2", "s1", "s2",
    "smtp", "zoho", "mxvault", "mandrill", "sendgrid", "everlytickey1",
]

# IP-based DNSBLs (queried with the MX hosts' A records) and domain-based DBLs.
IP_BLACKLISTS = ["zen.spamhaus.org", "b.barracudacentral.org", "bl.spamcop.net", "dnsbl.sorbs.net", "psbl.surriel.com"]
DOMAIN_BLACKLISTS = ["dbl.spamhaus.org", "multi.surbl.org", "black.uribl.com"]


def _resolver() -> dns.asyncresolver.Resolver:
    r = dns.asyncresolver.Resolver()
    r.timeout = 3
    r.lifetime = 5
    return r


async def _txt(name: str) -> list[str]:
    try:
        answers = await _resolver().resolve(name, "TXT")
        return [b"".join(rr.strings).decode(errors="replace") for rr in answers]
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers, dns.exception.Timeout):
        return []


async def _a(name: str) -> list[str]:
    try:
        return [rr.to_text() for rr in await _resolver().resolve(name, "A")]
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers, dns.exception.Timeout):
        return []


async def get_mx(domain: str) -> list[tuple[int, str]]:
    try:
        answers = await _resolver().resolve(domain, "MX")
        return sorted((rr.preference, rr.exchange.to_text().rstrip(".")) for rr in answers)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers, dns.exception.Timeout):
        return []


async def _listed(query: str) -> bool:
    # A listed entry resolves to 127.0.0.x; Spamhaus returns 127.255.255.x for blocked/public resolvers.
    ips = await _a(query)
    return any(ip.startswith("127.0.0.") or ip.startswith("127.0.1.") for ip in ips)


async def check_blacklists(domain: str, mx_hosts: list[str]) -> list[dict]:
    ips: set[str] = set()
    for host in mx_hosts[:3]:
        ips.update(await _a(host))

    tasks: list[tuple[str, str, asyncio.Task]] = []
    for ip in list(ips)[:4]:
        rev = ".".join(reversed(ip.split(".")))
        for bl in IP_BLACKLISTS:
            tasks.append((bl, ip, asyncio.create_task(_listed(f"{rev}.{bl}"))))
    for bl in DOMAIN_BLACKLISTS:
        tasks.append((bl, domain, asyncio.create_task(_listed(f"{domain}.{bl}"))))

    results = []
    for bl, target, task in tasks:
        listed = await task
        results.append({"list": bl, "target": target, "listed": listed})
    return results


def _status(ok: bool, warn: bool = False) -> str:
    return "pass" if ok else ("warn" if warn else "fail")


async def check_domain(domain: str, verify_token: str | None = None, dkim_selectors: list[str] | None = None) -> dict:
    domain = domain.strip().lower().rstrip(".")
    mx, root_txt, dmarc_txt = await asyncio.gather(get_mx(domain), _txt(domain), _txt(f"_dmarc.{domain}"))

    # SPF
    spf_records = [t for t in root_txt if t.lower().startswith("v=spf1")]
    spf = {"status": "fail", "record": None, "message": "No SPF record found"}
    if len(spf_records) > 1:
        spf = {"status": "fail", "record": spf_records, "message": "Multiple SPF records — only one is allowed"}
    elif spf_records:
        rec = spf_records[0]
        strict = rec.rstrip().endswith(("-all", "~all"))
        spf = {
            "status": _status(strict, warn=True),
            "record": rec,
            "message": "SPF record found" if strict else "SPF should end with ~all or -all",
        }

    # DMARC
    dmarc_records = [t for t in dmarc_txt if t.lower().startswith("v=dmarc1")]
    dmarc = {"status": "fail", "record": None, "policy": None, "message": "No DMARC record found"}
    if dmarc_records:
        rec = dmarc_records[0]
        tags = {k.strip().lower(): v.strip() for k, _, v in (p.partition("=") for p in rec.split(";")) if k.strip()}
        policy = tags.get("p", "none").lower()
        dmarc = {
            "status": _status(policy in ("quarantine", "reject"), warn=True),
            "record": rec,
            "policy": policy,
            "message": f"DMARC policy is p={policy}" + ("" if policy != "none" else " — consider quarantine once aligned"),
        }

    # DKIM — probe selectors concurrently
    selectors = dkim_selectors or COMMON_DKIM_SELECTORS
    dkim_txts = await asyncio.gather(*(_txt(f"{s}._domainkey.{domain}") for s in selectors))
    found = [
        {"selector": s, "record": t[0][:120] + ("…" if len(t[0]) > 120 else "")}
        for s, t in zip(selectors, dkim_txts)
        if t and ("v=dkim1" in t[0].lower() or "p=" in t[0].lower())
    ]
    dkim = {
        "status": "pass" if found else "warn",
        "selectors": found,
        "message": f"DKIM found ({', '.join(f['selector'] for f in found)})" if found
        else "No DKIM found on common selectors — add your provider's selector to check it",
    }

    mx_check = {
        "status": "pass" if mx else "fail",
        "records": [{"priority": p, "host": h} for p, h in mx],
        "message": f"{len(mx)} MX record(s)" if mx else "No MX records — this domain cannot receive mail",
    }

    ownership = None
    if verify_token:
        ok = any(verify_token in t for t in root_txt)
        ownership = {"status": _status(ok), "expected": f"sigmaflux-verify={verify_token}",
                     "message": "Ownership verified" if ok else "Add the TXT record to verify ownership"}

    blacklists = await check_blacklists(domain, [h for _, h in mx])
    listed = [b for b in blacklists if b["listed"]]
    bl = {
        "status": "pass" if not listed else "fail",
        "checked": len(blacklists),
        "listed": listed,
        "results": blacklists,
        "message": "Not listed on any checked blacklist" if not listed else f"Listed on {len(listed)} blacklist(s)",
    }

    score = 0
    score += {"pass": 25, "warn": 12, "fail": 0}[spf["status"]]
    score += {"pass": 25, "warn": 12, "fail": 0}[dkim["status"]]
    score += {"pass": 20, "warn": 12, "fail": 0}[dmarc["status"]]
    score += 15 if mx else 0
    score += 15 if not listed else max(0, 15 - 5 * len(listed))

    return {
        "domain": domain,
        "score": score,
        "mx": mx_check,
        "spf": spf,
        "dkim": dkim,
        "dmarc": dmarc,
        "blacklists": bl,
        "ownership": ownership,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
