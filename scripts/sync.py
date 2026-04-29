#!/usr/bin/env python3
"""Pull Wahapedia 10e CSVs, normalize them, and write per-faction JSON bundles.

Wahapedia's CSV format quirks:
  - UTF-8 BOM at the start of every file.
  - Pipe (|) delimiter, not comma.
  - Each record ends with `|\\r\\n` (trailing empty column then CRLF).
  - Fields can contain raw `\\r\\n` (NOT quoted/escaped). The reliable record
    terminator is therefore the byte sequence `|\\r\\n`.
  - No quoting of any kind. `|` does not appear inside fields.

Wahapedia 403s default user agents; we send a real Safari UA.
"""

import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from bs4 import BeautifulSoup, NavigableString, Tag

BASE = "https://wahapedia.ru/wh40k10ed/"
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
    "Mobile/15E148 Safari/604.1"
)

CSV_FILES = [
    "Last_update",
    "Factions",
    "Datasheets",
    "Datasheets_models",
    "Datasheets_wargear",
    "Datasheets_abilities",
    "Datasheets_keywords",
    "Datasheets_unit_composition",
    "Datasheets_models_cost",
    "Datasheets_stratagems",
    "Datasheets_detachment_abilities",
    "Datasheets_enhancements",
    "Stratagems",
    "Detachment_abilities",
    "Enhancements",
]


def fetch(name: str) -> str:
    url = BASE + name + ".csv"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/csv,*/*;q=0.9"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8")


def fetch_html(path: str) -> str:
    url = BASE + path.lstrip("/")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*;q=0.9"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8")


def parse_pipe_csv(text: str) -> list[dict]:
    """Parse Wahapedia's pipe CSV. See module docstring for format quirks."""
    if text.startswith("﻿"):
        text = text[1:]
    # Records end with `|\r\n`. If the file is LF-only, fall back to `|\n`.
    sep = "|\r\n"
    if sep not in text:
        sep = "|\n"
    parts = text.split(sep)
    if parts and parts[-1] == "":
        parts.pop()
    if not parts:
        return []
    header = parts[0].split("|")
    out = []
    for rec in parts[1:]:
        fields = rec.split("|")
        # Embedded CRLF inside fields stays — normalize to LF.
        fields = [f.replace("\r\n", "\n") for f in fields]
        n = min(len(header), len(fields))
        row = {header[i]: fields[i] for i in range(n)}
        out.append(row)
    return out


def nz(d: dict, k: str):
    """Return d[k] if non-empty, else None."""
    v = d.get(k)
    return v if v else None


# Boarding Actions detection.
#   - Rules text ("description") uniquely uses BA terrain terms (hatchway, bulkhead).
#   - Lore text ("legend") uniquely uses voidship/shipboard/etc.
#   - Stratagem/ability/enhancement names containing "board" are universally BA
#     (verified against the full dataset — every match is shipboard-themed).
# Together these catch all known BA detachments without false positives.
_BA_RULES_KEYWORDS = ("hatchway", "bulkhead")
_BA_LEGEND_KEYWORDS = ("voidship", "shipboard", "boarding action", "voidborne")
_BA_NAME_KEYWORDS = ("board",)  # matches "Boarding", "Boarder(s)", "Shipboard"


def collect_boarding_actions_detachment_ids(
    detachment_abilities: list[dict],
    stratagems: list[dict],
    enhancements: list[dict],
) -> set[str]:
    ba_ids: set[str] = set()
    def _has(text: str, kws: tuple[str, ...]) -> bool:
        if not text:
            return False
        t = text.lower()
        return any(kw in t for kw in kws)
    def _matches(row: dict) -> bool:
        return (
            _has(row.get("description", ""), _BA_RULES_KEYWORDS)
            or _has(row.get("legend", ""), _BA_LEGEND_KEYWORDS)
            or _has(row.get("name", ""), _BA_NAME_KEYWORDS)
        )
    for r in detachment_abilities:
        if r.get("detachment_id") and _matches(r):
            ba_ids.add(r["detachment_id"])
    for r in stratagems:
        if r.get("detachment_id") and _matches(r):
            ba_ids.add(r["detachment_id"])
    for r in enhancements:
        if r.get("detachment_id") and _matches(r):
            ba_ids.add(r["detachment_id"])
    return ba_ids


def build_bundles(csvs: dict[str, list[dict]]) -> tuple[dict, dict[str, dict], list[dict]]:
    factions = csvs["Factions"]
    datasheets = csvs["Datasheets"]
    models = csvs["Datasheets_models"]
    wargear = csvs["Datasheets_wargear"]
    abilities = csvs["Datasheets_abilities"]
    keywords = csvs["Datasheets_keywords"]
    composition = csvs["Datasheets_unit_composition"]
    costs = csvs["Datasheets_models_cost"]
    detachment_abilities = csvs["Detachment_abilities"]
    stratagems = csvs["Stratagems"]
    enhancements = csvs["Enhancements"]

    ba_detachment_ids = collect_boarding_actions_detachment_ids(
        detachment_abilities, stratagems, enhancements
    )
    print(f"  Boarding Actions filter: dropping {len(ba_detachment_ids)} detachments", flush=True)

    # Drop datasheets sourced from the Boarding Actions Companion (source_id=000000285).
    # Currently zero rows match — Wahapedia hosts BA detachments separately but
    # not BA-specific datasheet variants — but we filter defensively.
    datasheets = [d for d in datasheets if d.get("source_id") != "000000285"]

    # Drop BA detachments from the rule tables before any further processing.
    detachment_abilities = [r for r in detachment_abilities if r.get("detachment_id") not in ba_detachment_ids]
    stratagems = [r for r in stratagems if r.get("detachment_id") not in ba_detachment_ids]
    enhancements = [r for r in enhancements if r.get("detachment_id") not in ba_detachment_ids]

    # Group child rows by datasheet_id for fast lookup.
    def group(rows, key="datasheet_id"):
        g = {}
        for r in rows:
            g.setdefault(r[key], []).append(r)
        return g

    models_by_ds = group(models)
    wargear_by_ds = group(wargear)
    abilities_by_ds = group(abilities)
    keywords_by_ds = group(keywords)
    comp_by_ds = group(composition)
    costs_by_ds = group(costs)

    # Detachments: synthesize from Detachment_abilities (faction_id, detachment_id, detachment).
    detachments_seen: dict[tuple[str, str], dict] = {}
    for r in detachment_abilities:
        key = (r["faction_id"], r["detachment_id"])
        if key not in detachments_seen and r.get("detachment") and r.get("detachment_id"):
            detachments_seen[key] = {
                "factionId": r["faction_id"],
                "detachmentId": r["detachment_id"],
                "name": r["detachment"],
            }
    detachment_abilities_by_det: dict[tuple[str, str], list[dict]] = {}
    for r in detachment_abilities:
        key = (r["faction_id"], r["detachment_id"])
        if not r.get("name"):
            continue
        detachment_abilities_by_det.setdefault(key, []).append({
            "id": r["id"],
            "name": r["name"],
            "description": nz(r, "description"),
        })

    stratagems_by_det: dict[tuple[str, str], list[dict]] = {}
    for r in stratagems:
        key = (r["faction_id"], r["detachment_id"])
        stratagems_by_det.setdefault(key, []).append({
            "id": r["id"],
            "name": r["name"],
            "type": nz(r, "type"),
            "cpCost": nz(r, "cp_cost"),
            "turn": nz(r, "turn"),
            "phase": nz(r, "phase"),
            "description": nz(r, "description"),
        })

    enhancements_by_det: dict[tuple[str, str], list[dict]] = {}
    for r in enhancements:
        key = (r["faction_id"], r["detachment_id"])
        enhancements_by_det.setdefault(key, []).append({
            "id": r["id"],
            "name": r["name"],
            "cost": nz(r, "cost"),
            "description": nz(r, "description"),
        })

    # Per-faction bundles.
    bundles: dict[str, dict] = {}
    for f in factions:
        fid = f["id"]
        bundles[fid] = {
            "faction": {"id": fid, "name": f["name"]},
            "datasheets": [],
            "detachments": [],
        }

    for d in datasheets:
        fid = d["faction_id"]
        if fid not in bundles:
            continue
        ds_id = d["id"]
        ds_models = sorted(
            models_by_ds.get(ds_id, []),
            key=lambda r: int(r.get("line") or "0"),
        )
        ds_weapons = sorted(
            wargear_by_ds.get(ds_id, []),
            key=lambda r: (int(r.get("line") or "0"), int(r.get("line_in_wargear") or "0")),
        )
        ds_abilities = sorted(
            abilities_by_ds.get(ds_id, []),
            key=lambda r: int(r.get("line") or "0"),
        )
        ds_costs = sorted(
            costs_by_ds.get(ds_id, []),
            key=lambda r: int(r.get("line") or "0"),
        )
        ds_comp = sorted(
            comp_by_ds.get(ds_id, []),
            key=lambda r: int(r.get("line") or "0"),
        )

        bundles[fid]["datasheets"].append({
            "id": ds_id,
            "name": d["name"],
            "role": nz(d, "role"),
            "loadout": nz(d, "loadout"),
            "models": [{
                "name": m["name"],
                "M": nz(m, "M"), "T": nz(m, "T"), "Sv": nz(m, "Sv"),
                "invSv": nz(m, "inv_sv"), "invSvDescr": nz(m, "inv_sv_descr"),
                "W": nz(m, "W"), "Ld": nz(m, "Ld"), "OC": nz(m, "OC"),
                "baseSize": nz(m, "base_size"),
            } for m in ds_models],
            "weapons": [{
                "name": w["name"],
                "description": nz(w, "description"),
                "range": nz(w, "range"),
                "type": nz(w, "type"),
                "A": nz(w, "A"), "BS_WS": nz(w, "BS_WS"),
                "S": nz(w, "S"), "AP": nz(w, "AP"), "D": nz(w, "D"),
                "isMelee": (w.get("range") or "").lower().startswith("melee"),
            } for w in ds_weapons],
            "abilities": [{
                "name": nz(a, "name"),
                "description": nz(a, "description"),
                "type": nz(a, "type"),
            } for a in ds_abilities],
            "keywords": [{
                "keyword": k["keyword"],
                "isFactionKeyword": (k.get("is_faction_keyword") or "").lower() == "true",
            } for k in keywords_by_ds.get(ds_id, [])],
            "composition": [c["description"] for c in ds_comp if c.get("description")],
            "costs": [{"description": c["description"], "cost": c["cost"]} for c in ds_costs],
        })

    for (fid, did), det in detachments_seen.items():
        if fid not in bundles:
            continue
        bundles[fid]["detachments"].append({
            "id": did,
            "name": det["name"],
            "abilities": detachment_abilities_by_det.get((fid, did), []),
            "stratagems": stratagems_by_det.get((fid, did), []),
            "enhancements": enhancements_by_det.get((fid, did), []),
        })

    # Sort within each bundle.
    for b in bundles.values():
        b["datasheets"].sort(key=lambda x: x["name"])
        b["detachments"].sort(key=lambda x: x["name"])

    # Index file: faction list + last update + flat search index.
    last_update = csvs["Last_update"][0]["last_update"] if csvs.get("Last_update") else ""
    index = {
        "lastUpdate": last_update,
        "factions": sorted(
            [{"id": f["id"], "name": f["name"]} for f in factions],
            key=lambda x: x["name"],
        ),
    }

    # Search index: flat list of {type, factionId, id, name}.
    search = []
    for fid, b in bundles.items():
        for ds in b["datasheets"]:
            search.append({"t": "u", "f": fid, "i": ds["id"], "n": ds["name"]})
        for det in b["detachments"]:
            search.append({"t": "d", "f": fid, "i": det["id"], "n": det["name"]})
            for s in det["stratagems"]:
                search.append({"t": "s", "f": fid, "i": s["id"], "n": s["name"], "d": det["id"]})

    return index, bundles, search


# ---------------- Core rules scraper ----------------
# Wahapedia's core rules page is structured HTML (h2 sections, h3 subsections).
# No CSV export exists, so we scrape. This pipeline is more fragile than the
# CSVs — see scrape_core_rules() for the validation that gates the result.

# Tags we keep verbatim; everything else is unwrapped (children preserved).
_KEEP_TAGS = {"p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li",
              "table", "thead", "tbody", "tr", "td", "th",
              "h3", "h4", "h5", "div", "span", "img"}
# Strip these and their contents entirely.
_DROP_SUBTREE = {"script", "style", "noscript", "iframe", "ins", "form"}
# Class fragments that signal "ad/nav/widget" — drop subtree if seen on a div/span.
_DROP_CLASS_FRAGMENTS = ("redDiamond", "ezoic", "ez-", "adsbygoogle", "ad-", "anchor_top")


def _slugify(s: str) -> str:
    s = re.sub(r"[^\w\s-]", "", s.lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s or "section"


def _attached(el: Tag) -> bool:
    """True if `el` is still part of a parsed tree (not decomposed/unwrapped)."""
    return el.parent is not None and el.attrs is not None


def _sanitize_node(node: Tag) -> None:
    """In-place sanitization: drop ads/nav, unwrap unknown tags, normalize attrs.

    Done in three passes (decompose → unwrap → attr scrub) because mutating
    the tree mid-walk leaves `descendants` yielding detached nodes whose
    `attrs` is None.
    """
    # Pass 1: drop junk subtrees.
    for el in list(node.descendants):
        if not isinstance(el, Tag) or not _attached(el):
            continue
        if el.name in _DROP_SUBTREE:
            el.decompose()
            continue
        cls = " ".join(el.get("class") or [])
        if any(frag in cls for frag in _DROP_CLASS_FRAGMENTS):
            el.decompose()

    # Pass 2: unwrap unknown tags and anchors (preserve children).
    for el in list(node.descendants):
        if not isinstance(el, Tag) or not _attached(el):
            continue
        if el.name == "a" or el.name not in _KEEP_TAGS:
            el.unwrap()

    # Pass 3: normalize attributes on the survivors.
    for el in list(node.descendants):
        if not isinstance(el, Tag) or not _attached(el):
            continue
        if el.name == "img":
            src = el.get("src", "")
            if src.startswith("/"):
                src = "https://wahapedia.ru" + src
            el.attrs = {"src": src, "alt": el.get("alt", "")}
        elif el.name == "span":
            cls = " ".join(c for c in (el.get("class") or [])
                           if c in {"kwb", "kwbu", "impact18", "impact20", "tt"})
            el.attrs = {"class": cls} if cls else {}
        elif el.name == "div":
            cls = " ".join(c for c in (el.get("class") or [])
                           if c in {"BreakInsideAvoid", "Columns2"})
            el.attrs = {"class": cls} if cls else {}
        else:
            el.attrs = {}


_H2_RE = re.compile(r"<h2\b[^>]*>(.*?)</h2>", re.DOTALL | re.IGNORECASE)


def scrape_core_rules(html: str) -> list[dict]:
    """Parse the Core Rules HTML page into [{slug, title, html}, ...].

    Strategy: find all <h2> opening positions in source order, slice the HTML
    between consecutive h2s, and sanitize each slice. This avoids fragile DOM
    ancestor walks across the inconsistently nested page.
    """
    matches = list(_H2_RE.finditer(html))
    if not matches:
        return []

    sections: list[dict] = []
    used_slugs: set[str] = set()
    for i, m in enumerate(matches):
        title_html = m.group(1)
        # Strip nested tags for plain title text.
        title = re.sub(r"<[^>]+>", "", title_html).strip()
        if not title:
            continue

        chunk_start = m.end()
        chunk_end = matches[i + 1].start() if i + 1 < len(matches) else len(html)
        chunk_html = html[chunk_start:chunk_end]

        soup = BeautifulSoup(f"<div>{chunk_html}</div>", "html.parser")
        container = soup.div
        _sanitize_node(container)
        for p in container.find_all("p"):
            if not p.get_text(strip=True) and not p.find("img"):
                p.decompose()

        body = container.decode_contents().strip()
        if not body:
            continue

        slug = _slugify(title)
        base = slug
        n = 2
        while slug in used_slugs:
            slug = f"{base}-{n}"
            n += 1
        used_slugs.add(slug)

        sections.append({"slug": slug, "title": title, "html": body})

    return sections


def validate_rules(sections: list[dict]) -> tuple[bool, str]:
    """Sanity-check the scrape. Returns (ok, reason)."""
    if len(sections) < 20:
        return False, f"only {len(sections)} sections (expected at least 20)"
    short = [s["title"] for s in sections if len(s["html"]) < 50]
    if len(short) > len(sections) // 3:
        return False, f"too many empty/short sections: {short[:5]}…"
    # Anchor sanity: a few well-known section titles should be present.
    titles = {s["title"].lower() for s in sections}
    required = {"battlefield", "dice", "1. command", "1. hit roll"}
    missing = [t for t in required if t not in titles]
    if missing:
        return False, f"missing required sections: {missing}"
    return True, "ok"


def sync_core_rules(out_dir: Path) -> None:
    """Scrape, validate, and write rules.json. On any failure leave the
    existing file untouched so the site keeps showing the last good copy."""
    target = out_dir / "rules.json"
    try:
        html = fetch_html("the-rules/core-rules/")
        sections = scrape_core_rules(html)
        ok, reason = validate_rules(sections)
        if not ok:
            raise ValueError(f"validation failed: {reason}")
    except Exception as e:
        if target.exists():
            print(f"WARN: core rules scrape failed ({e}); keeping existing rules.json", flush=True)
        else:
            print(f"WARN: core rules scrape failed ({e}); no prior file to fall back to", flush=True)
        return

    payload = {"sections": sections}
    target.write_text(json.dumps(payload, ensure_ascii=False))
    print(f"  rules.json: {len(sections)} sections, {target.stat().st_size // 1024} KB", flush=True)


def main():
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/data")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "factions").mkdir(exist_ok=True)

    print(f"Fetching {len(CSV_FILES)} CSV files from Wahapedia...", flush=True)
    csvs: dict[str, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch, CSV_FILES))
    for name, body in zip(CSV_FILES, results):
        csvs[name] = parse_pipe_csv(body)
        print(f"  {name}: {len(csvs[name])} rows", flush=True)

    print("Building bundles...", flush=True)
    index, bundles, search = build_bundles(csvs)

    print("Scraping Core Rules HTML page...", flush=True)
    sync_core_rules(out_dir)

    # Add rule sections to the search index if rules.json exists.
    rules_path = out_dir / "rules.json"
    if rules_path.exists():
        rules = json.loads(rules_path.read_text())
        for sec in rules.get("sections", []):
            search.append({"t": "r", "i": sec["slug"], "n": sec["title"]})

    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False))
    (out_dir / "search.json").write_text(json.dumps(search, ensure_ascii=False))
    for fid, bundle in bundles.items():
        (out_dir / "factions" / f"{fid}.json").write_text(json.dumps(bundle, ensure_ascii=False))

    total_size = sum(p.stat().st_size for p in out_dir.rglob("*.json"))
    print(f"Wrote {len(bundles)} faction bundles + index + search to {out_dir} "
          f"({total_size / 1024:.0f} KB total)", flush=True)


if __name__ == "__main__":
    main()
