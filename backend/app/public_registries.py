"""Israeli public registries on data.gov.il (CKAN datastore, no API key).

Playground for the future `reg.professional` / `reg.company` connectors.
None of these registries holds ID numbers, so matching is by name, narrowed by city.
"""

import json
import re
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

API = "https://data.gov.il/api/3/action/datastore_search"

Row = dict[str, str]


@dataclass(frozen=True)
class Registry:
    key: str
    title_he: str
    resource_id: str
    name: Callable[[Row], str]
    detail: Callable[[Row], str]
    city: Callable[[Row], str] | None = None


PEOPLE = (
    Registry(
        "cpa", "רואי חשבון", "7e86def9-0899-45f4-8942-d6fe38482b1a",
        lambda r: f"{r['שם פרטי']} {r['שם משפחה']}",
        lambda r: f"רישיון {r['מספר רישיון']} · מאז {r['תאריך קבלת רישיון']} · {r['סטטוס']}",
        lambda r: r["ישוב"],
    ),
    Registry(
        "doctor", "רופאים", "9c64c522-bbc2-48fe-96fb-3b2a8626f59e",
        lambda r: f"{r['שם פרטי']} {r['שם משפחה']}",
        lambda r: f"רישיון {r['מספר רישיון רופא']} · מאז {r['תאריך רישום רישיון']} · {r.get('שם התמחות') or ''}",
    ),
    Registry(
        "broker", "מתווכים פעילים", "a0f56034-88db-4132-8803-854bcdb01ca1",
        lambda r: r["שם המתווך"],
        lambda r: f"רישיון {r['מס רשיון']}",
        lambda r: r["עיר מגורים"],
    ),
    Registry(
        "appraiser", "שמאי מקרקעין", "8540534a-eccd-4568-a677-652d589ed172",
        lambda r: r["שם שמאי"],
        lambda r: f"רישיון {r['מספר רשיון']}",
        lambda r: r["עיר"],
    ),
    Registry(
        "social_worker", "עובדים סוציאליים", "0f25d8f5-eecc-4d63-8914-38d59f19925b",
        lambda r: f"{r['שם-פרטי']} {r['שם-משפחה']}",
        lambda r: f"רישום {r['מספר רישום']} · מאז {r['תאריך רישום']}",
        lambda r: r["ישוב מגורים"],
    ),
    Registry(
        "contractor", "קבלנים רשומים", "4eb61bd6-18cf-4e7c-9f9c-e166dfa0a2d8",
        lambda r: r["SHEM_YESHUT"],
        lambda r: f"קבלן {r['MISPAR_KABLAN']} · {r['TEUR_ANAF']} · סיווג {r['KVUTZA']}{r['SIVUG']}",
        lambda r: r["SHEM_YISHUV"],
    ),
)

COMPANIES = Registry(
    "company", "רשם החברות", "f004176c-b85f-4542-8901-7b3176f9a054",
    lambda r: r["שם חברה"],
    lambda r: f"ח.פ. {r['מספר חברה']} · {r['סטטוס חברה']} · התאגדה {r['תאריך התאגדות']}",
    lambda r: r["שם עיר"],
)


def _words(s: str) -> list[str]:
    return re.sub(r"[\"'`~\-–־.,()]", " ", s or "").lower().split()


def _squash(s: str) -> str:
    return "".join(_words(s))


def name_matches(name: str, query: str) -> bool:
    """Every word of the query is a word of the registry name (full-text search is loose)."""
    words = set(_words(name))
    return bool(query.strip()) and all(q in words for q in _words(query))


def city_matches(registry_city: str, city: str) -> bool:
    a, b = _squash(registry_city), _squash(city)
    return bool(a and b) and (a in b or b in a)


def valid_israeli_id(id_number: str) -> bool:
    """Structure + check digit only. Says nothing about who the number belongs to."""
    digits = re.sub(r"\D", "", id_number or "")
    if not 5 <= len(digits) <= 9:
        return False
    total = 0
    for i, ch in enumerate(digits.zfill(9)):
        d = int(ch) * (1 if i % 2 == 0 else 2)
        total += d - 9 if d > 9 else d
    return total % 10 == 0


def search(reg: Registry, query: str, limit: int = 200) -> list[Row]:
    params = urllib.parse.urlencode({"resource_id": reg.resource_id, "q": query, "limit": limit})
    req = urllib.request.Request(f"{API}?{params}", headers={"User-Agent": "trust-profile/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)["result"]["records"]


def _hits(reg: Registry, query: str, city: str, name_of: Callable[[Row], str]) -> list[dict]:
    rows = search(reg, query)
    words = _words(query)
    exact_only = False
    if not rows and len(words) > 1:
        # data.gov.il full-text stems Latin words oddly and finds nothing for multi-word Latin queries.
        # Search each word on its own and keep only rows that contain all of them.
        by_id = {r["_id"]: r for w in words for r in search(reg, w)}
        rows, exact_only = list(by_id.values()), True
    hits = []
    for r in rows:
        exact = name_matches(name_of(r), query)
        if exact_only and not exact:
            continue
        reg_city = (reg.city(r) if reg.city else "") or ""
        hits.append({
            "registry": reg.title_he,
            "name": reg.name(r).strip(),
            "detail": reg.detail(r),
            "city": reg_city.strip(),
            "exact": exact,
            "city_match": city_matches(reg_city, city) if city and reg.city else None,
        })
    return hits


def lookup(name_he: str, name_en: str = "", city: str = "") -> dict:
    jobs = [(reg, name_he, reg.name) for reg in PEOPLE if name_he]
    if name_he:
        jobs.append((COMPANIES, name_he, COMPANIES.name))
    if name_en:
        jobs.append((COMPANIES, name_en, lambda r: r["שם באנגלית"]))

    people, companies, errors = [], [], []
    with ThreadPoolExecutor(max_workers=len(jobs) or 1) as pool:
        futures = [(reg, pool.submit(_hits, reg, q, city, name_of)) for reg, q, name_of in jobs]
        for reg, f in futures:
            try:
                (companies if reg is COMPANIES else people).extend(f.result())
            except (OSError, KeyError, ValueError) as e:  # one registry failing must not hide the others
                errors.append(f"{reg.title_he}: {e}")

    seen, unique_companies = set(), []
    for c in companies:
        if c["detail"] not in seen:
            seen.add(c["detail"])
            unique_companies.append(c)
    # exact name matches first, then city matches; otherwise keep registry order (sort is stable)
    rank = lambda h: (not h["exact"], h["city_match"] is not True)
    return {"people": sorted(people, key=rank), "companies": sorted(unique_companies, key=rank), "errors": errors}
