"""Merge the pilot feedback files into one Excel workbook.

    python merge_feedback.py <folder with feedback-*.json> [out.xlsx]

Sheets
  accuracy      one row per report row, across everyone: correct / wrong / unsure, accuracy, kinds of mistake.
                Sorted worst first, so the top rows are what to fix in the engine.
  verdicts      every answer: who, which row, the answer, and (only if they chose to share) the value and note
  participants  one row per file: mode, coverage numbers, answers
  unknown       unknown senders across all files: how many participants have each domain, total mails, skeletons.
                Sorted so the top rows are the next entries for senders.json / labels.json.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

folder = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
out = Path(sys.argv[2] if len(sys.argv) > 2 else folder / "pilot_feedback.xlsx")
files = sorted(folder.glob("feedback-*.json")) + sorted(folder.glob("download*"))
fbs = []
for f in files:
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError):
        continue
    if d.get("kind") == "imtrustme-pilot-feedback" and d.get("version") == 2:
        fbs.append(d)
if not fbs:
    sys.exit(f"no feedback files in {folder}")

MODE = {"private": "בלי הדוח", "full": "עם הטעויות"}
VERDICT = {"correct": "נכון", "wrong": "לא נכון", "unsure": "לא יודע/ת"}
KIND = {"missed": "חסר", "invented": "לא קיים", "inaccurate": "לא מדויק"}
OUTCOME = {"found": "נמצא", "none": "לא נמצא", "na": "לא נבדק"}


def pct(a, b):
    return round(a / b, 3) if b else None


wb = Workbook()
acc = wb.active
acc.title = "accuracy"
acc.sheet_view.rightToLeft = True
acc.append(["שורה", "ענו", "נכון", "לא נכון", "לא יודע/ת", "דיוק %", "חסר", "לא קיים", "לא מדויק", "טעות בלי פירוט"])
rows: dict[str, dict] = defaultdict(lambda: {"label": "", "correct": 0, "wrong": 0, "unsure": 0, "kinds": defaultdict(int)})
for d in fbs:
    for v in d["verdicts"]:
        r = rows[v["key"]]
        r["label"] = v["label"]
        r[v["verdict"]] += 1
        if v["verdict"] == "wrong":
            r["kinds"][v.get("kind")] += 1


def accuracy(r):
    return pct(r["correct"], r["correct"] + r["wrong"])  # "unsure" says nothing about the engine


for r in sorted(rows.values(), key=lambda r: (accuracy(r) if accuracy(r) is not None else 2, -r["wrong"])):
    acc.append([r["label"], r["correct"] + r["wrong"] + r["unsure"], r["correct"], r["wrong"], r["unsure"], accuracy(r),
                r["kinds"]["missed"], r["kinds"]["invented"], r["kinds"]["inaccurate"], r["kinds"][None]])
for cell in acc["F"][1:]:
    cell.number_format = "0%"

v_sheet = wb.create_sheet("verdicts")
v_sheet.sheet_view.rightToLeft = True
v_sheet.append(["ממי", "שורה", "תשובה", "סוג הטעות", "מה המנוע מצא", "מה המנוע כתב", "הערה"])
for d in fbs:
    for v in d["verdicts"]:
        v_sheet.append([d["from"], v["label"], VERDICT[v["verdict"]], KIND.get(v.get("kind"), ""),
                        OUTCOME.get(v.get("outcome"), ""), v.get("value", ""), v.get("note", "")])

ws = wb.create_sheet("participants")
ws.sheet_view.rightToLeft = True
ws.append(["ממי", "דרך השיתוף", "תאריך", "מיילים", "מגופים", "גופים מזוהים %", "עם סוג אירוע %", "תבניות",
           "שורות שנענו", "שולחים לא מוכרים", "כמה נכון בסך הכול", "מה היה מבלבל"])
for d in fbs:
    st = d.get("stats") or {}
    ws.append([d["from"], MODE[d["mode"]], d["created"][:10], st.get("messages"), st.get("business_in"),
               pct(st.get("business_in_registered", 0), st.get("business_in")),
               pct(st.get("business_in_labelled", 0), st.get("business_in")), st.get("templates"),
               len(d["verdicts"]), len(d.get("unknown_senders", [])),
               d.get("answers", {}).get("q-overall", ""), d.get("answers", {}).get("q-ux", "")])
for c in ("F", "G"):
    for cell in ws[c][1:]:
        cell.number_format = "0%"

agg: dict[str, dict] = defaultdict(lambda: {"who": set(), "mails": 0, "skeletons": defaultdict(int), "registered": False})
for i, d in enumerate(fbs):
    for u in d.get("unknown_senders", []):
        a = agg[u["domain"]]
        a["who"].add(i)  # by file: several people may leave the name empty
        a["mails"] += u["count"]
        a["skeletons"][u["skeleton"]] += u["count"]
        a["registered"] |= u["registered"]
u = wb.create_sheet("unknown")
u.sheet_view.rightToLeft = True
u.append(["דומיין", "כמה משתתפים", "סה״כ מיילים", "כבר ב-senders.json", "תבניות נפוצות"])
for dom, a in sorted(agg.items(), key=lambda kv: (-len(kv[1]["who"]), -kv[1]["mails"])):
    top = sorted(a["skeletons"].items(), key=lambda kv: -kv[1])[:4]
    u.append([dom, len(a["who"]), a["mails"], "כן" if a["registered"] else "לא", " | ".join(s for s, _ in top)])

for sh in wb.worksheets:
    for c in sh[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="0E9AA0")
    sh.freeze_panes = "A2"
    for i, col in enumerate(sh.columns, 1):
        width = max(len(str(c.value or "")) for c in col)
        sh.column_dimensions[get_column_letter(i)].width = min(60, max(10, width + 2))
wb.save(out)
print(f"{len(fbs)} files -> {out}")
