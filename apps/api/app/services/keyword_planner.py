"""Manual Keyword Planner round trip (no Google Ads API needed).

1. ``planner_line`` — every researched keyword of a lead list as ONE comma-separated line, cleaned the way Keyword
   Planner accepts it, to paste into Keyword Planner → "Get search volume and forecasts".
2. ``parse_export`` — reads the file Keyword Planner downloads ("Keyword Stats <date>.csv": UTF-16, tab separated,
   two title lines, location summary rows) or the same data saved as a UTF-8 comma CSV / Google Sheet.
   Returns one row per keyword in the shape research stores (volume, competition, bids, monthly…).

Keywords are matched with ``norm`` on both sides, so case, spacing and symbols Planner strips don't matter.
"""

import csv
import io
import re

# Keyword Planner rejects these characters in keywords (and limits keywords to 80 characters / 10 words).
PLANNER_BAD = re.compile(r"[!@%^*()={};~`<>?\\|,\"]")
MAX_PER_PASTE = 10_000


def clean(keyword: str) -> str:
    k = PLANNER_BAD.sub(" ", (keyword or "").lower())
    k = re.sub(r"\s+", " ", k).strip()
    return " ".join(k.split(" ")[:10])[:80].strip()


def norm(keyword: str) -> str:
    return re.sub(r"[^\w]+", " ", clean(keyword)).strip()


def planner_line(keywords: list[str]) -> list[str]:
    """Deduplicated, Planner-safe keywords (first spelling wins)."""
    seen: dict[str, str] = {}
    for k in keywords:
        c = clean(k)
        if c and norm(c) not in seen:
            seen[norm(c)] = c
    return list(seen.values())


# ── Export parsing ───────────────────────────────────────────────────────────

def _decode(raw: bytes) -> str:
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    if b"\x00" in raw[:400]:
        return raw.decode("utf-16-le", errors="replace")
    return raw.decode("utf-8-sig", errors="replace")


_SUFFIX = {"": 1, "k": 1_000, "m": 1_000_000, "b": 1_000_000_000}


def _num(v: str) -> float | None:
    """'2400.0' / '1,300' / '74K' / '30.08' → number; '', '--', '∞', '50%' → None."""
    v = (v or "").strip().strip('"').replace(" ", "")
    m = re.fullmatch(r"([\d.,]+)\s*([kmbKMB]?)", v)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "")) * _SUFFIX[m.group(2).lower()]
    except ValueError:
        return None


def _volume(v: str) -> tuple[int | None, str | None]:
    """Exact volume, or for accounts without ad spend a range like '1K – 10K' → (low end, '1K – 10K')."""
    v = (v or "").strip().strip('"')
    rng = re.fullmatch(r"([\d.,]+\s*[kmbKMB]?)\s*[–—-]\s*([\d.,]+\s*[kmbKMB]?)", v)
    if rng:
        low = _num(rng.group(1))
        return (int(low) if low is not None else None), v
    n = _num(v)
    return (int(round(n)) if n is not None else None), None


def parse_export(raw: bytes) -> dict:
    """→ {rows: {norm_keyword: row}, currency, period, skipped}. Raises ValueError when it isn't a Planner export."""
    text = _decode(raw)
    lines = text.splitlines()
    hi = next((i for i, l in enumerate(lines[:30]) if re.match(r'^﻿?"?keyword"?\s*[\t,]', l, re.I)
               and "monthly searches" in l.lower()), None)
    if hi is None:
        raise ValueError("This doesn't look like a Keyword Planner export — no 'Keyword … Avg. monthly searches' header row")
    period = next((l.strip().strip('"') for l in lines[:hi] if re.search(r"\d{4}", l) and " - " in l), "")
    delim = "\t" if "\t" in lines[hi] else ","
    reader = csv.reader(io.StringIO("\n".join(lines[hi:])), delimiter=delim,
                        quoting=csv.QUOTE_NONE if delim == "\t" else csv.QUOTE_MINIMAL)
    header = [h.strip().strip('"').lower() for h in next(reader)]

    def col(*names: str) -> int | None:
        for n in names:
            if n in header:
                return header.index(n)
        return None

    ix = {
        "keyword": col("keyword"), "currency": col("currency"), "segmentation": col("segmentation"),
        "volume": col("avg. monthly searches", "avg monthly searches"), "competition": col("competition"),
        "competition_index": col("competition (indexed value)"),
        "low_bid": col("top of page bid (low range)"), "high_bid": col("top of page bid (high range)"),
        "three_month": col("three month change"), "yoy": col("yoy change"),
    }
    if ix["keyword"] is None or ix["volume"] is None:
        raise ValueError("The export is missing the Keyword or Avg. monthly searches column")
    month_cols = [i for i, h in enumerate(header) if h.startswith("searches:")]

    rows: dict[str, dict] = {}
    currencies: set[str] = set()
    skipped = 0
    for cells in reader:
        get = lambda k: cells[ix[k]].strip().strip('"') if ix[k] is not None and ix[k] < len(cells) else ""  # noqa: E731
        kw = get("keyword")
        if not kw:  # location / "All" summary rows
            continue
        if get("segmentation"):
            skipped += 1
            continue
        vol, vol_range = _volume(get("volume"))
        no_data = vol is None and not vol_range  # Planner leaves it blank when there are too few searches to report
        if no_data:
            vol = 0
        comp = get("competition").upper() or None
        ci = _num(get("competition_index"))
        cur = get("currency")
        if cur:
            currencies.add(cur)
        row = {
            "volume": vol, "competition": comp if comp in ("LOW", "MEDIUM", "HIGH") else None,
            "competition_index": int(ci) if ci is not None else None,
            "low_bid": _num(get("low_bid")), "high_bid": _num(get("high_bid")), "cpc": None,
            "currency": cur, "monthly": [int(n) if (n := _num(cells[i] if i < len(cells) else "")) is not None else None
                                         for i in month_cols][-12:],
        }
        if vol_range:
            row["volume_range"] = vol_range
        if no_data:
            row["no_data"] = True
        for k, c in (("three_month_change", "three_month"), ("yoy_change", "yoy")):
            v = get(c)
            if re.fullmatch(r"-?[\d.]+%", v):
                row[k] = v
        rows[norm(kw)] = row
    if not rows:
        raise ValueError("No keyword rows found in the export")
    return {"rows": rows, "currency": ", ".join(sorted(currencies)), "period": period, "skipped": skipped}
