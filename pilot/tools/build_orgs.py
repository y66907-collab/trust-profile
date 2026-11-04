"""Builds site/engine/orgs.json: domain -> organisation, from public sources only. No mailbox goes into this table.

Sources:
  Wikidata (CC0): organisations in Israel with an official website, their type, industry and head office.
  data.gov.il, company registry: company number, city and street of the companies found, by Hebrew name.

Usage: python build_orgs.py <wikidata.json> <companies.csv> <out.json>
Fetching is separate from building, so that later only the storage has to change when these tables move to a database.
The address belongs to a company, never to a person. A registered company can sit at someone's home, so only
organisations notable enough for Wikidata get one.
"""
import csv
import json
import re
import sys
from collections import defaultdict
from urllib.parse import urlparse

# Mail from these reveals affiliation or health, so the engine must not read it. Sector names are from rules.json
EXCLUDED_TYPES = {
    "health": {"hospital", "university hospital", "medical organization", "clinic", "health maintenance organization",
               "health insurance company", "medical center"},
    "community": {"synagogue", "yeshiva", "Hesder", "Mechina", "Yeshiva high school", "political party",
                  "parliamentary group", "school", "secondary school", "high school", "youth village",
                  "youth movement", "kindergarten", "religious organization", "kibbutz", "moshav"},
    # A plain nonprofit stays out of this table altogether: some lend money or give services, and being one reveals nothing
    "donations": {"charitable organization", "charity"},
}
EXCLUDED_INDUSTRIES = {"religious congregations and associations": "community", "health care": "health"}

KEPT_TYPES = {
    "business": "business", "public company": "business", "company": "business", "enterprise": "business",
    "privately held company": "business", "software company": "software", "bank": "finance", "central bank": "finance",
    "cooperative bank": "finance", "insurance company": "insurance", "mobile network operator": "telecom",
    "airline": "travel", "hotel": "travel", "college": "education", "academic institution": "education",
    "university": "education", "public university": "education", "private university": "education",
    "open university": "education", "public research university": "education", "university of technology": "education",
    "educational institution": "education", "research institute": "education", "government agency": "government",
    "Israeli government ministry": "government", "statutory corporation": "government", "city": "government",
    "municipality": "government", "municipality of Israel": "government", "municipal company": "government",
    "city council": "government", "local council": "government", "local council in Israel": "government",
    "regional council of Israel": "government",
}
INDUSTRY_SECTORS = [
    ("insurance", "insurance"), ("financ", "finance"), ("fintech", "finance"), ("bank", "finance"),
    ("telecom", "telecom"), ("software", "software"), ("information technology", "software"),
    ("computer security", "software"), ("artificial intelligence", "software"), ("retail", "retail"),
    ("e-commerce", "retail"), ("tourism", "travel"), ("hotel", "travel"), ("energy", "utility"),
]
# A domain here is shared by many, so it says nothing about who wrote
SHARED_HOSTS = {"gov.il", "ac.il", "co.il", "org.il", "net.il", "muni.il", "k12.il", "idf.il", "web.archive.org",
                "facebook.com", "instagram.com", "linkedin.com", "youtube.com", "twitter.com", "x.com", "tiktok.com",
                "google.com", "sites.google.com", "wixsite.com", "wordpress.com", "blogspot.com", "github.io",
                "linktr.ee", "wikipedia.org", "t.me", "medium.com"}
LEGAL_SUFFIX = re.compile(r"""\s*(?:בע["'״׳]?מ|בעמ|\(ישראל\)|ישראל|חל["'״׳]?צ)\s*""")


def host_of(url):
    return re.sub(r"^www\d*\.", "", (urlparse(url).hostname or "").lower())


def plain_name(name):
    return re.sub(r"\s+", " ", re.sub(r"[\"'״׳.,\-–־()]", " ", LEGAL_SUFFIX.sub(" ", name or ""))).strip()


def sector_of(types, industries):
    for label in types:
        for sector, names in EXCLUDED_TYPES.items():
            if label in names:
                return sector
    for label in industries:
        if label in EXCLUDED_INDUSTRIES:
            return EXCLUDED_INDUSTRIES[label]
    kept = [KEPT_TYPES[t] for t in types if t in KEPT_TYPES]
    if not kept:
        return None
    for label in industries:
        low = label.lower()
        for word, sector in INDUSTRY_SECTORS:
            if word in low:
                return sector
    return next((k for k in kept if k != "business"), "business")


def organisations(rows):
    """One entry per organisation, then one per domain. A domain two organisations claim is dropped, unless just one has it as its front page."""
    by_org = defaultdict(lambda: {"types": set(), "industries": set(), "hosts": set(), "roots": set()})
    for r in rows:
        o = by_org[r["c"]]
        o.update(he=r.get("he") or o.get("he"), en=r.get("en") or o.get("en"), hq=r.get("hq") or o.get("hq"))
        o["types"].add(r["tl"])
        if r.get("il"):
            o["industries"].add(r["il"])
        host = host_of(r["w"])
        if host and host not in SHARED_HOSTS:
            o["hosts"].add(host)
            if urlparse(r["w"]).path.strip("/") == "":
                o["roots"].add(host)
    claims = defaultdict(list)
    for o in by_org.values():
        o["sector"] = sector_of(o["types"], o["industries"])
        if o["sector"] and (o.get("he") or o.get("en")):
            for host in o["hosts"]:
                claims[host].append(o)
    table = {}
    for host, owners in claims.items():
        if len(owners) > 1:
            front = [o for o in owners if host in o["roots"]]
            if len(front) != 1:
                # Several claim it. If all of them are off limits, the domain still is
                sectors = {o["sector"] for o in owners}
                if len(sectors) == 1 and next(iter(sectors)) in EXCLUDED_TYPES:
                    table[host] = {"org_he": "", "sector": next(iter(sectors))}
                continue
            owners = front
        o = owners[0]
        # Wikidata disambiguates labels in brackets: "מטריקס (חברה)"
        name = re.sub(r"\s*\([^)]*\)\s*$", "", o.get("he") or o.get("en"))
        entry = {"org_he": "" if o["sector"] in EXCLUDED_TYPES else name, "sector": o["sector"]}
        if o.get("hq") and o["sector"] not in EXCLUDED_TYPES:
            entry["city"] = o["hq"]
        table[host] = entry
    return table


def add_registry(table, csv_path):
    """Company number and address by exact Hebrew name, only where the name belongs to one living company."""
    wanted = defaultdict(list)
    for host, e in table.items():
        if e["org_he"] and e["sector"] not in EXCLUDED_TYPES:
            wanted[plain_name(e["org_he"])].append(host)
    found = defaultdict(list)
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("סטטוס חברה") == "פעילה":
                name = plain_name(row.get("שם חברה"))
                if name in wanted:
                    found[name].append(row)
    matched = 0
    for name, rows in found.items():
        if len(rows) != 1:
            continue
        r = rows[0]
        for host in wanted[name]:
            matched += 1
            table[host]["company_id"] = r["מספר חברה"]
            if r.get("שם עיר"):
                table[host]["city"] = r["שם עיר"].strip()
            street = " ".join(x for x in ((r.get("שם רחוב") or "").strip(), (r.get("מספר בית") or "").strip()) if x and x != "0")
            if street:
                table[host]["address"] = street
    return matched


def main():
    wikidata, companies, out = sys.argv[1:4]
    table = organisations(json.load(open(wikidata, encoding="utf-8")))
    matched = add_registry(table, companies)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(dict(sorted(table.items())), f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    sectors = defaultdict(int)
    for e in table.values():
        sectors[e["sector"]] += 1
    print(f"domains {len(table)}, with a registry match {matched}, sectors {dict(sectors)}")


if __name__ == "__main__":
    main()
