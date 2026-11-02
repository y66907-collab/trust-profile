"""Test helper: demo TSV envelopes -> the rows shape the browser builds from the Gmail API.

    python tsv_to_rows.py <own address> a.tsv b.tsv ... > ../test/rows.json   (rows.json is git-ignored)
"""
import csv, json, re, sys
from pathlib import Path
rows, seen = [], set()
ME = sys.argv[1].lower()
for p in sys.argv[2:]:
    for r in csv.reader(open(p, encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(r) < 4 or not re.fullmatch(r"[0-9a-f]{10,20}", r[1].strip()) or r[1] in seen:
            continue
        seen.add(r[1]); r += [""] * (6 - len(r))
        rows.append({"thread": r[0].strip(), "id": r[1].strip(), "ts": int(r[1].strip(), 16) >> 20,
                     "from": r[3].strip(), "to": r[4].strip(), "subject": r[5].strip(),
                     "sent": r[3].strip().lower() == ME})
print(json.dumps(rows, ensure_ascii=False))
