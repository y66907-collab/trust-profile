"""Fetches the public sources for build_orgs.py. Nothing here reads a mailbox.

Usage: python fetch_orgs.py <out_dir>   writes wikidata.json and companies.csv into it. Keep them out of the repo.
"""
import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

AGENT = {"User-Agent": "imtrustme-orgs/1.0"}
WIKIDATA_QUERY = """SELECT ?c ?w ?he ?en ?tl ?il ?hq WHERE {
 ?c wdt:P17 wd:Q801; wdt:P856 ?w; wdt:P31 ?t.
 ?t rdfs:label ?tl. FILTER(LANG(?tl)="en")
 OPTIONAL { ?c rdfs:label ?he. FILTER(LANG(?he)="he") }
 OPTIONAL { ?c rdfs:label ?en. FILTER(LANG(?en)="en") }
 OPTIONAL { ?c wdt:P452 ?i. ?i rdfs:label ?il. FILTER(LANG(?il)="en") }
 OPTIONAL { ?c wdt:P159 ?h. ?h rdfs:label ?hq. FILTER(LANG(?hq)="he") }
}"""
COMPANIES = "f004176c-b85f-4542-8901-7b3176f9a054"
FIELDS = ["מספר חברה", "שם חברה", "שם באנגלית", "סטטוס חברה", "שם עיר", "שם רחוב", "מספר בית"]
PAGE = 5000


def wikidata(path):
    for wait in (0, 75, 75, 75):  # the service allows about one query a minute
        time.sleep(wait)
        try:
            body = urllib.parse.urlencode({"query": WIKIDATA_QUERY}).encode()
            req = urllib.request.Request("https://query.wikidata.org/sparql", data=body,
                                         headers={**AGENT, "Accept": "application/sparql-results+json"})
            rows = json.load(urllib.request.urlopen(req, timeout=70))["results"]["bindings"]
            path.write_text(json.dumps([{k: v["value"] for k, v in r.items()} for r in rows], ensure_ascii=False), encoding="utf-8")
            return len(rows)
        except OSError as e:
            print("wikidata:", e, flush=True)
    raise SystemExit("wikidata did not answer")


def companies(path):
    """The site refuses the file download, so this reads the registry through its public search API, page by page."""
    count = 0
    with open(path, "w", encoding="utf-8", newline="") as f:
        out = csv.DictWriter(f, FIELDS)
        out.writeheader()
        while True:
            query = urllib.parse.urlencode({"resource_id": COMPANIES, "limit": PAGE, "offset": count, "fields": ",".join(FIELDS)})
            for attempt in range(5):
                try:
                    req = urllib.request.Request("https://data.gov.il/api/3/action/datastore_search?" + query, headers=AGENT)
                    records = json.load(urllib.request.urlopen(req, timeout=120))["result"]["records"]
                    break
                except OSError as e:
                    print("registry:", count, e, flush=True)
                    time.sleep(20 * (attempt + 1))
            else:
                raise SystemExit("registry stopped answering at " + str(count))
            if not records:
                return count
            out.writerows({k: r.get(k) for k in FIELDS} for r in records)
            count += len(records)
            if count % 100000 == 0:
                print(count, flush=True)
            time.sleep(0.3)


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    print("wikidata rows", wikidata(folder / "wikidata.json"), flush=True)
    print("companies", companies(folder / "companies.csv"), flush=True)
