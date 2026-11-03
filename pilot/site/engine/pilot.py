"""Pilot entry point: envelopes from the Gmail API (in the participant's browser) -> rental profile + feedback data.

Runs inside Pyodide. Nothing here touches the network; the browser hands in the envelopes and takes the result.
Same engine as the demo (engine.py); the parameters are the rental set, worded for any owner (slash forms).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import UTC, date, datetime
from pathlib import Path

import engine

HERE = Path(__file__).parent
ROUTINE = {"bill_issued", "receipt"}
ISSUE = {"payment_reminder", "payment_failed", "collection_notice", "legal_notice"}
BANKS = {"fibi.co.il": "הבינלאומי", "bankhapoalim.co.il": "הפועלים", "leumi.co.il": "לאומי",
         "mizrahi-tefahot.co.il": "מזרחי טפחות", "discountbank.co.il": "דיסקונט", "mercantile.co.il": "מרכנתיל",
         "bankjerusalem.co.il": "ירושלים", "bankotsar.co.il": "אוצר החייל", "bank-yahav.co.il": "יהב",
         "pagi.co.il": "פאגי", "bankmassad.co.il": "מסד", "onezerobank.com": "וואן זירו"}
PLATFORMS = [("LinkedIn", ("linkedin.com",)), ("Facebook", ("facebookmail.com", "facebook.com")),
             ("Instagram", ("instagram.com", "mail.instagram.com")), ("GitHub", ("github.com",))]
PAYSLIP = re.compile(r"תלוש (שכר|משכורת)|תלוש לחודש|payslip", re.I)
# kept out of the feedback file altogether, even before the participant reviews it: health, donations, religion,
# community, children. The engine does not read these either (excluded sectors); this covers senders it doesn't know yet
SENSITIVE = re.compile(r"תרומ|ישיב|קהיל|בית כנסת|בית הכנסת|צדק|חסד|תורה|רפוא|מרפא|קופת חולים|בדיק|תור ל|"
                       r"רופא|טיפול|פסיכו|גן ילדים|מעון|צהרון|בית ספר|תלמוד|ילד|kids|אמהות|לידה|הריון|מכבי|כללית|מאוחדת|לאומית|donat|health|clinic|church|synagog", re.I)
PENSION = re.compile(r'דו"?ח ה?(רבעוני|תקופתי|שנתי).*(פנסיה|גמל|השתלמות)')


# Stable key of each report row, for the feedback and for merging across participants
ROW_KEYS = {
    "עיר מגורים לפי חשבונות": "city", "גר/ה שם": "residence_since",
    "חשבונות שוטפים: חשמל, גז, מים, תקשורת": "utility_accounts", "עדכון כתובת ברשות האוכלוסין": "address_update",
    "ספקים בתשלום קבוע (6 חודשים ומעלה)": "regular_suppliers", "ספקים לאורך שנתיים ומעלה": "long_suppliers",
    "הקשר הארוך ביותר עם ספק": "longest_supplier", "בעיות תשלום מהותיות ב-12 החודשים האחרונים": "payment_issues_12m",
    "בעיות תשלום מהותיות בכל התקופה": "payment_issues_all", "אירועי תשלום זניחים": "minor_payment_events",
    "התראות גבייה": "collection_notices", "הליך משפטי, הוצאה לפועל או עיקול": "legal",
    "התראות בנק: חשבון מוגבל, שיק חזר, חריגה": "bank_alerts", "הלוואות": "loans", "בנק לפי מיילים": "bank",
    "מעסיק לפי מיילים": "employer", "תלושי שכר שהגיעו במייל": "payslips", "חיסכון פנסיוני פעיל": "pension",
    "משכנתא": "mortgage", "חשבון ה-Gmail שחובר": "gmail_account", "גיל תיבת המייל": "mailbox_age",
    "חשבונות על שמך": "own_accounts",
}
# Allow-list: rows where saying what kind of mistake it was reveals nothing personal. Any other row, including
# one added later, sends a bare answer when the report isn't shared ("missing" on a legal row would say there is a case)
DETAIL_OK = {"city", "residence_since", "utility_accounts", "address_update", "regular_suppliers", "long_suppliers",
             "longest_supplier", "bank", "gmail_account", "mailbox_age", "own_accounts"}
NOTHING_FOUND = (0, "לא נמצא", "לא זוהה")


def row_meta(label: str, r: dict) -> dict:
    """Rows that exist only for some people (household, platforms) reveal something by appearing, so they are not
    asked when the report isn't shared. An unknown label raises: a new row has to be classified."""
    outcome = "na" if r["v"] is None else "none" if r["v"] in NOTHING_FOUND else "found"
    if label.startswith("חשבונות על שם "):
        return {"key": "household_accounts", "fb_label": "חשבונות על שם בן/בת הבית", "detail": False,
                "private": False, "outcome": outcome}
    if label in {name for name, _ in PLATFORMS}:
        return {"key": "platform_" + label.lower(), "fb_label": label, "detail": False, "private": False, "outcome": outcome}
    key = ROW_KEYS[label]
    return {"key": key, "fb_label": label, "detail": key in DETAIL_OK, "private": True, "outcome": outcome}


def ym(d: str) -> str:
    return f"{d[5:7]}.{d[:4]}"


def months_between(a: str, b: str) -> int:
    return (int(b[:4]) - int(a[:4])) * 12 + int(b[5:7]) - int(a[5:7]) + 1


def span(ms) -> str:
    ds = sorted(m.sent_at for m in ms)
    if not ds:
        return ""
    return ym(ds[0]) if ds[0][:7] == ds[-1][:7] else f"{ym(ds[0])}–{ym(ds[-1])}"


def P(v, ms=(), n=None, note=None):
    ms = list(ms)
    return {"v": v, "n": len(ms) if n is None else n, "span": span(ms), "why": None, "note": note}


def NA(why):
    return {"v": None, "n": None, "span": "", "why": why, "note": None}


def name_variants(full: str) -> list[str]:
    parts = full.split()
    out = [full.strip()]
    if len(parts) >= 2:
        out.append(" ".join(parts[1:] + parts[:1]))  # "כהן דנה": surname first, as many bills print it
    return [x for x in dict.fromkeys(out) if x]


def same_name(a: str, b: str) -> bool:
    ta = set(re.sub(r"[^\w\s]", " ", a.lower()).split())
    tb = set(re.sub(r"[^\w\s]", " ", b.lower()).split())
    return bool(ta) and len(ta & tb) >= min(2, len(ta), len(tb))


def to_messages(rows: list[dict], own: set[str]) -> list[engine.Message]:
    out, seen = [], set()
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        outgoing = r["sent"] or r["from"].lower() in own
        other = (r["to"] if outgoing else r["from"]).lower()
        d = datetime.fromtimestamp(int(r["ts"]) / 1000, UTC).date().isoformat()
        out.append(engine.Message(r["thread"], r["id"], d, "out" if outgoing else "in", other,
                                  engine.domain_of(other), r["subject"] or ""))
    out.sort(key=lambda m: m.sent_at)
    return out


def run(payload_json: str) -> str:
    p = json.loads(payload_json)
    today, owner = p["today"], p["owner"]
    registry = json.loads((HERE / "senders.json").read_text(encoding="utf-8"))
    labels = json.loads((HERE / "labels.json").read_text(encoding="utf-8"))
    rules = json.loads((HERE / "rules.json").read_text(encoding="utf-8"))

    own_names = name_variants(owner["name_he"]) + ([owner["name_en"]] if owner.get("name_en") else [])
    hh = owner.get("household") or None
    engine.OWN.clear()
    engine.OWN.update(a.lower() for a in p["own_addresses"])
    engine.OWNER.clear()
    engine.OWNER.update({"own_names": own_names, "household": [
        {"names": name_variants(hh["name"]), "label_he": hh["name"], "declared_he": "חשבון משותף"}] if hh else []})
    engine.NAMES.clear()
    engine.NAMES.extend([(n, "<OWNER>") for n in own_names]
                        + [(n, "<HOUSEHOLD>") for h in engine.OWNER["household"] for n in h["names"]])
    engine.NAMES.sort(key=lambda x: -len(x[0]))

    msgs = to_messages(p["rows"], engine.OWN)
    for m in msgs:
        m.holder = engine.holder_of(m.subject)
    engine.resolve_senders(msgs, registry, rules["excluded_sectors"], tuple(rules.get("platform_sectors", ())))
    hidden = set(json.loads((HERE / "excluded_hashes.json").read_text(encoding="utf-8"))["sha256"])
    for m in msgs:  # same policy as excluded sectors, for domains this public file must not name
        parts = m.domain.split(".")
        if any(hashlib.sha256(".".join(parts[i:]).encode()).hexdigest() in hidden for i in range(len(parts) - 1)):
            m.sender_class, m.org, m.org_he, m.sector = "excluded", None, None, "private"
    templates = engine.mine_templates(msgs)
    engine.apply_labels(msgs, templates, labels)
    eps = engine.build_episodes(msgs, rules, today)

    readable = [m for m in msgs if m.sender_class in ("registered", "unregistered")]
    by_id = {m.msg_id: m for m in msgs}
    rel = [e for e in eps if e.kind == "relationship"]
    billing = [m for m in msgs if m.direction == "in" and m.event_type in ROUTINE | ISSUE]
    city_of = {l["org"]: l["city"] for l in labels if l.get("city")}

    def grep(rx, ms=readable):
        r = re.compile(rx)
        return [m for m in ms if r.search(m.subject) and "פרסומת" not in m.subject]

    def ep_msgs(es):
        return [by_id[i] for e in es for i in e.message_ids]

    # ---- residence
    water = [m for m in msgs if m.org in city_of and m.event_type in ROUTINE]
    if water:
        city = P(city_of[water[0].org], water)
        since = P(f"לפחות מ-{ym(min(m.sent_at for m in water))}", water)
    else:
        city = since = NA("לא זוהה ספק מקומי (מים או ארנונה). המנוע מכיר עדיין מעט ספקים מקומיים")
    house = [e for e in rel if any(by_id[i].sector in ("utility", "telecom") or by_id[i].org in city_of
                                    for i in e.message_ids)]
    address = [m for m in msgs if m.domain.endswith("gov.il") and "שינוי כתובת מגורים" in m.subject]

    # ---- money
    def is_minor(e):
        r = rules["minor_issue"]
        return (e.max_level <= r["max_level"] and e.n_in <= r["max_events"] and e.status == "resolved"
                and (date.fromisoformat(e.last) - date.fromisoformat(e.first)).days <= r["max_resolve_days"])

    issues = [e for e in eps if e.kind == "issue"]
    minor = [e for e in issues if is_minor(e)]
    material = [e for e in issues if not is_minor(e)]

    def failed(window=None):
        es = [e for e in material if window is None or months_between(e.first, today) <= window]
        if not es:
            return P(0, billing)
        st = {"resolved": "נסגר", "quiet": "לא נמצא המשך", "open": "פתוח"}
        return P("; ".join(f"{e.org_he} ({ym(e.first)}) {st[e.status]}" for e in es), ep_msgs(es))

    regular = [e for e in rel if e.months_active >= 6]
    long_ = [e for e in rel if e.months_active >= 24]
    longest = max(rel, key=lambda e: e.months_active) if rel else None
    banks = [m for m in readable if any(m.domain == b or m.domain.endswith("." + b) for b in BANKS)]
    bank_names = sorted({BANKS[next(b for b in BANKS if m.domain == b or m.domain.endswith("." + b))] for m in banks})

    def sig(rx, found="{n}"):
        ms = grep(rx)
        return P(found.format(n=len(ms)) if ms else 0, ms, n=len(ms))

    # ---- work
    slips = [m for m in readable if m.direction == "in" and (m.event_type == "payslip" or PAYSLIP.search(m.subject))]
    slip_from = Counter(m.org_he or m.domain for m in slips)
    employer = [m for m in msgs if m.sector == "employer"]
    pension = [m for m in readable if PENSION.search(m.subject)]

    # ---- identity
    gate_he = {"own": "על שמך", "household": "על שם בן/בת הבית שהצהרת עליו/ה", "other": "על שם אחר",
               "unknown": "לא נמצאו מיילים יוצאים לבדיקה"}
    acc = p.get("account_name") or ""
    if not acc:
        gate = "unknown"
    elif any(same_name(acc, n) for n in own_names):
        gate = "own"
    elif hh and same_name(acc, hh["name"]):
        gate = "household"
    else:
        gate = "other"
    plat_rows = []
    for name, doms in PLATFORMS:
        ms = [m for m in msgs if m.direction == "in" and any(m.domain == d or m.domain.endswith("." + d) for d in doms)]
        if len(ms) >= 5:
            plat_rows.append((name, P("חשבון קיים על הכתובת המחוברת", ms)))
    own_bills = [m for m in billing if m.holder == "owner"]
    hh_rels = [e for e in rel if e.holder == "household"]

    groups = [
        ("מגורים", [
            ("עיר מגורים לפי חשבונות", city),
            ("גר/ה שם", since),
            ("חשבונות שוטפים: חשמל, גז, מים, תקשורת",
             P(", ".join(f"{e.org_he} ({e.months_active} ח׳)" for e in sorted(house, key=lambda e: -e.months_active)) or 0,
               ep_msgs(house))),
            ("עדכון כתובת ברשות האוכלוסין", P(f"שינוי כתובת, {ym(address[-1].sent_at)}" if address else "לא נמצא", address)),
        ]),
        ("התנהלות כספית", [
            ("ספקים בתשלום קבוע (6 חודשים ומעלה)", P(len(regular), ep_msgs(regular))),
            ("ספקים לאורך שנתיים ומעלה", P(len(long_), ep_msgs(long_))),
            ("הקשר הארוך ביותר עם ספק",
             P(f"{longest.months_active} חודשים ({longest.org_he})", ep_msgs([longest])) if longest else NA("לא זוהו ספקים")),
            ("בעיות תשלום מהותיות ב-12 החודשים האחרונים", failed(12)),
            ("בעיות תשלום מהותיות בכל התקופה", failed()),
            ("אירועי תשלום זניחים", P(f"{len(minor)} (פירוט בסוף הדוח)" if minor else 0, ep_msgs(minor))),
            ("התראות גבייה", P(sum(1 for m in msgs if m.event_type == "collection_notice"), billing, n=len(billing))),
            ("הליך משפטי, הוצאה לפועל או עיקול", sig(rules["signals"]["legal"]["subject"])),
            ("התראות בנק: חשבון מוגבל, שיק חזר, חריגה", sig(rules["signals"]["bank_alerts"]["subject"])),
            ("הלוואות", sig(rules["signals"]["loan"]["subject"])),
            ("בנק לפי מיילים", P(", ".join(bank_names) if banks else "לא זוהה", banks)),
        ]),
        ("עבודה והכנסה", [
            ("מעסיק לפי מיילים", P(employer[0].org_he, employer) if employer else
             (P(", ".join(k for k, _ in slip_from.most_common(2)), slips, note="לפי שולח התלושים") if slips
              else NA("המעסיק לא מוכר עדיין למנוע"))),
            ("תלושי שכר שהגיעו במייל", P(len(slips), slips)),
            ("חיסכון פנסיוני פעיל",
             P(f"כן ({', '.join(sorted({m.org_he or m.domain for m in pension}))})" if pension else 0, pension)),
        ]),
        ("נכס", [
            ("משכנתא", sig("משכנתא", "יש התכתבות על משכנתא ({n} מיילים)")),
        ]),
        ("זהות ונוכחות ברשת", [
            ("חשבון ה-Gmail שחובר", {"v": gate_he[gate] + (f" ({acc})" if acc and gate != "own" else ""),
                                     "n": p.get("sent_checked", 0), "span": "שם השולח במיילים יוצאים",
                                     "why": None, "note": None}),
            ("גיל תיבת המייל", {"v": f"פעילה מ-{ym(p['mailbox_since'])}", "n": None, "span": "", "why": None,
                               "note": None} if p.get("mailbox_since") else NA("לא נמצא")),
            ("חשבונות על שמך", P(len(own_bills), own_bills)),
        ] + ([("חשבונות על שם " + hh["name"],
               P(", ".join(e.org_he for e in hh_rels) or 0, ep_msgs(hh_rels), note="חשבון משותף לפי הצהרתך"))]
             if hh else []) + plat_rows),
    ]

    # ---- feedback data: what the engine did not understand. Only sender domain, masked subject skeleton, count
    biz = [m for m in readable if m.direction == "in"]
    # mail known only from a search has an empty subject. It counts towards its sender, under the subject of the mail opened
    pooled: dict[str, dict] = {}
    for t in templates.values():
        if t["domain"].startswith("out:") or t["event_type"]:
            continue
        cur = pooled.setdefault(t["domain"], {**t, "count": 0, "skeleton": "<EMPTY>"})
        cur["count"] += t["count"]
        if t["skeleton"] != "<EMPTY>" and cur["skeleton"] == "<EMPTY>":
            cur["skeleton"] = t["skeleton"]
    unknown = sorted((t for t in pooled.values() if t["count"] >= 2 and t["skeleton"] != "<EMPTY>"
                      and not SENSITIVE.search(t["domain"] + " " + t["skeleton"])),
                     key=lambda t: -t["count"])[:80]
    first_names = [n.split()[0] for n in [owner["name_he"], owner.get("name_en") or "", hh["name"] if hh else ""] if n]

    def scrub(s: str) -> str:
        s = re.sub(r"[‎‏‪-‮⁦-⁩]", "", s)
        for f in first_names:
            s = re.sub(rf"(?<!\w){re.escape(f.lower())}(?!\w)", "<שם>", s)
        return s
    registered_doms = {m.domain for m in msgs if m.sender_class == "registered"}
    stats = {
        "messages": len(msgs),
        "date_range": [msgs[0].sent_at, msgs[-1].sent_at] if msgs else None,
        "by_class": dict(Counter(m.sender_class for m in msgs)),
        "business_in": len(biz),
        "business_in_registered": sum(1 for m in biz if m.sender_class == "registered"),
        "business_in_labelled": sum(1 for m in biz if m.event_type),
        "templates": sum(1 for t in templates.values() if not t["domain"].startswith("out:")),
        "orgs": len({m.org for m in msgs if m.org}),
        "findings_rows": sum(1 for _, rows in groups for _, r in rows if r["v"] not in (None, 0)),
    }
    return json.dumps({
        "rule_version": rules["version"], "today": today, "stats": stats,
        "groups": [{"title": t, "params": [{"label": l, **r, **row_meta(l, r)} for l, r in rows]} for t, rows in groups],
        "minor": [{"org_he": e.org_he, "first": e.first, "last": e.last, "n_in": e.n_in, "level": e.max_level}
                  for e in minor],
        "unknown": [{"domain": t["domain"], "skeleton": scrub(t["skeleton"]), "count": t["count"],
                     "registered": t["domain"] in registered_doms} for t in unknown],
    }, ensure_ascii=False)
