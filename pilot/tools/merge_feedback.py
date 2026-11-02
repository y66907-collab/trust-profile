"""Merge the pilot feedback files into one Excel workbook.

    python merge_feedback.py <folder with imtrustme-feedback-*.json> [out.xlsx]

Sheets
  participants  one row per file: coverage numbers, rows hidden / commented / flagged wrong, the answers
  wrong         every row a participant flagged as wrong, with the value the engine gave and their note
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
files = sorted(folder.glob("imtrustme-feedback-*.json")) + sorted(folder.glob("download*"))
fbs = []
for f in files:
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError):
        continue
    if d.get("kind") == "imtrustme-pilot-feedback":
        fbs.append(d)
if not fbs:
    sys.exit(f"no feedback files in {folder}")

Q = [("q-feel", "מה הרגיש/ה"), ("q-shown", "הראה/תה למישהו"), ("q-send", "ישלח/תשלח למשכיר"),
     ("q-send-why", "מה היה מסתיר/ה"), ("q-fear", "מה הלחיץ"), ("q-pay", "ישלם/תשלם"), ("q-ux", "מה לא נוח")]


def pct(a, b):
    return round(a / b, 3) if b else None


wb = Workbook()
ws = wb.active
ws.title = "participants"
ws.sheet_view.rightToLeft = True
ws.append(["ממי", "תאריך", "מיילים", "מגופים", "גופים מזוהים %", "עם סוג אירוע %", "תבניות", "שורות עם ממצא",
           "שורות בדוח", "הוסתרו", "תגובות", "סומנו לא נכון", "שולחים לא מוכרים"] + [h for _, h in Q])
for d in fbs:
    st = d.get("stats") or {}
    marks = d.get("marks", [])
    ws.append([d["from"], d["created"][:10], st.get("messages"), st.get("business_in"),
               pct(st.get("business_in_registered", 0), st.get("business_in")),
               pct(st.get("business_in_labelled", 0), st.get("business_in")), st.get("templates"), st.get("findings_rows"),
               st.get("report_rows"), sum(m["hidden"] for m in marks), sum(bool(m["comment"]) for m in marks),
               sum(m["wrong"] for m in marks), len(d.get("unknown_senders", []))]
              + [d.get("answers", {}).get(k, "") for k, _ in Q])
for c in ("E", "F"):
    for cell in ws[c][1:]:
        cell.number_format = "0%"

w = wb.create_sheet("wrong")
w.sheet_view.rightToLeft = True
w.append(["ממי", "שורה", "מה המנוע כתב", "מה לא נכון"])
for d in fbs:
    for m in d.get("marks", []):
        if m["wrong"]:
            w.append([d["from"], m["label"], m["value"], m["wrong_note"]])

agg: dict[str, dict] = defaultdict(lambda: {"who": set(), "mails": 0, "skeletons": defaultdict(int), "registered": False})
for d in fbs:
    for u in d.get("unknown_senders", []):
        a = agg[u["domain"]]
        a["who"].add(d["from"])
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
