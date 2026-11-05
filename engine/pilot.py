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
PAYSLIP = re.compile(r"תלוש (שכר|משכורת)|תלוש לחודש|payslip|^\W*תלוש(\s+[\d/.\-]+)?\W*$", re.I)
# kept out of the feedback file altogether, even before the participant reviews it: health, donations, religion,
# community, children. The engine does not read these either (excluded sectors); this covers senders it doesn't know yet
SENSITIVE = re.compile(r"אמונה|נטפרי|netfree|תרומ|ישיב|קהיל|בית כנסת|בית הכנסת|צדק|חסד|תורה|רפוא|מרפא|קופת חולים|בדיק|תור ל|"
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
    "חשבונות על שמך": "own_accounts", "למי גופים פונים בתיבה": "addressed_to", "ותק לפי מיילים מהמעסיק": "employer_since",
    "דוח נתוני אשראי": "credit_report",
}
# Allow-list: rows where saying what kind of mistake it was reveals nothing personal. Any other row, including
# one added later, sends a bare answer when the report isn't shared ("missing" on a legal row would say there is a case)
DETAIL_OK = {"city", "residence_since", "utility_accounts", "address_update", "regular_suppliers", "long_suppliers",
             "longest_supplier", "bank", "gmail_account", "mailbox_age", "own_accounts"}
NOTHING_FOUND = (0, "לא נמצא", "לא זוהה")


INTEREST_KEYS: dict[str, str] = {}  # label -> key, for this run
FACTS_TOPIC = "עובדות"  # the fixed lines that open the summary; app.js keeps them on top by this name
# Findings for the person's own interest. Not asked row by row when the report isn't shared: nobody can confirm a median
BONUS = {"מיילים בכל התיבה": "mailbox_total", "מיילים לפי שנה": "per_year", "חברות וגופים שכתבו לך": "companies",
              "חלק הפרסומות בתיבה": "promo_share", "מיילים שלא נקראו": "unread", "זמן התגובה החציוני שלך": "reply_time",
              "השעות שבהן את/ה שולח/ת הכי הרבה": "active_hours", "מיילים ששלחת בשבוע": "sent_per_week",
         "מיילים על משרות ומועמדות": "job_search", "מיילים על טיסות": "flights", "יעדי טיסה": "destinations",
         "היקף משרה": "job_scope", "משרה נוכחית לפי קורות חיים": "cv_current", "קורות חיים ששלחת": "cv_sent", "מוסד אקדמי בתיבה": "academic", "מיילים על הוראות קבע": "standing_orders",
         "מיילים ששלחת על חוזים": "contracts_sent", "מיילים על מעבר מגורים": "moving", "מיילים על רכישת נכס": "property_docs",
         "אזכורים ברשת": "web_mentions", "רישיונות במאגרים ציבוריים": "licenses", "חברות על השם שלך": "companies_registry", "מיילים על הזמנות ומשלוחים": "orders",
                "קורסים, כנסים והרצאות": "learning", "מיילים על חוזים והסכמים": "contracts", "ערעורים ותלונות ששלחת": "disputes",
                "מיילים אישיים עם תודה בנושא": "thanks", "מנויים וחיובים חוזרים": "subscriptions",
                "התראות אבטחה בתיבה": "security", "מסמכי הכנסה שיושבים בתיבה": "documents"}


def row_meta(label: str, r: dict) -> dict:
    """Rows that exist only for some people (household, platforms) reveal something by appearing, so they are not
    asked when the report isn't shared. An unknown label raises: a new row has to be classified."""
    outcome = "na" if r["v"] is None else "none" if r["v"] in NOTHING_FOUND else "found"
    if label.startswith("חשבונות על שם "):
        return {"key": "household_accounts", "fb_label": "חשבונות על שם בן/בת הבית", "detail": False,
                "private": False, "outcome": outcome}
    if label in BONUS:
        return {"key": BONUS[label], "fb_label": label, "detail": False, "private": False, "outcome": outcome}
    if label in INTEREST_KEYS:  # having one is itself personal, so it is only asked when the report is shared
        return {"key": "interest_" + INTEREST_KEYS[label], "fb_label": label, "detail": False, "private": False, "outcome": outcome}
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


JOB_BOARDS = ("drushim.co.il", "alljobs.co.il", "jobmaster.co.il", "jobinfo.co.il", "glassdoor.com", "indeed.com", "ziprecruiter.com")
JOB_ALERT = re.compile(r"משרות חדשות|משרות ש?מתאימות|משרות עבורך|משרות בשבילך|התראת משרות|סוכן (?:חכם|משרות)|job alerts?|new jobs|jobs? for you|"
                       r"jobs you may|recommended jobs|is hiring|are hiring", re.I)


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
    # The public table (tools/build_orgs.py) only names a sender or keeps it out. It doesn't make it a supplier
    orgs = json.loads((HERE / "orgs.json").read_text(encoding="utf-8"))
    for m in msgs:
        if m.sender_class == "unregistered":
            parts = m.domain.split(".")
            e = next((orgs[".".join(parts[i:])] for i in range(len(parts) - 1) if ".".join(parts[i:]) in orgs), None)
            if e and e["sector"] in rules["excluded_sectors"]:
                m.sender_class, m.org, m.org_he, m.sector = "excluded", None, None, e["sector"]
            elif e:
                m.org_he = e["org_he"]
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
    if not employer:  # no known employer: an unlisted sender of slips in different months is one
        months = {}
        for m in slips:
            if not m.org:
                months.setdefault(m.domain, set()).add(m.sent_at[:7])
        repeat = max(months, key=lambda d: len(months[d]), default=None)
        if repeat and len(months[repeat]) >= 2:
            employer = [m for m in msgs if m.domain == repeat]
    by_address = False
    work_domain = (p.get("work_address") or {}).get("domain")
    if not employer and work_domain:  # an address in the owner's own name at an organisation: that is where they work
        at_work = [m for m in msgs if m.domain == work_domain or m.domain.endswith("." + work_domain)]
        # an address kept from a former workplace goes quiet, so mail in the last year is what makes it the current one
        if at_work and months_between(max(m.sent_at for m in at_work), p["today"]) <= 13:
            employer, by_address = at_work, True
    pension =[m for m in readable if PENSION.search(m.subject)]

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
        link = (p.get("read_out") or {}).get("links", {}).get(name)
        found_online = None if link else (p.get("outside") or {}).get("web_links", {}).get(name)
        if len(ms) >= 5 or link or found_online:
            row = P("חשבון קיים על הכתובת המחוברת", ms)
            if link or found_online:
                row["v"], row["link"] = (link or found_online).split("//")[1].removeprefix("www."), link or found_online
            if found_online:
                row["note"] = "נמצא בחיפוש לפי השם, ייתכן שזה מישהו אחר"
            plat_rows.append((name, row))
    own_bills = [m for m in billing if m.holder == "owner"]
    hh_rels = [e for e in rel if e.holder == "household"]
    addressed_msgs = [m for m in msgs if m.sender_class == "registered" and m.direction == "in" and m.holder]
    by_holder = Counter(m.holder for m in addressed_msgs)
    addressed = [f"בשמך: {by_holder['owner']}"] if by_holder["owner"] else []
    if by_holder["household"] and hh:
        addressed.append(f"בשם {hh['name']}: {by_holder['household']}")
    holder_he = {"owner": "על שמך", "household": f"על שם {hh['name']}" if hh else "", None: "לא צוין שם"}

    # ---- interests: at least 3 mails, so a one-off order isn't called an interest
    INTEREST_KEYS.clear()
    by_topic: dict[str, list[dict]] = {}
    for it in p.get("interests", []):
        by_topic.setdefault(it["label"], []).append(it)
    interest_rows = []
    for label, items in by_topic.items():
        n = sum(i["n"] for i in items)
        if n < 3:
            continue
        INTEREST_KEYS[label] = items[0]["key"]
        top = sorted(items, key=lambda i: -i["n"])
        when = [datetime.fromtimestamp(t / 1000, UTC).date().isoformat() for i in items for t in (i["first"], i["last"])]
        a, b = ym(min(when)), ym(max(when))
        interest_rows.append((label, {"v": ", ".join(i["domain"] for i in top[:4]), "n": n, "span": a if a == b else f"{a}–{b}",
                                      "why": None, "note": None}))

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
            ("דוח נתוני אשראי", sig(rules["signals"]["credit_report"]["subject"])),
            ("הלוואות", sig(rules["signals"]["loan"]["subject"])),
            ("בנק לפי מיילים", P(", ".join(bank_names) if banks else "לא זוהה", banks)),
        ]),
        ("עבודה והכנסה", [
            ("מעסיק לפי מיילים", P(employer[0].org_he or (work_domain if by_address else employer[0].domain), employer,
                                   note="כתובת על שמך אצל הארגון" if by_address else None) if employer else
             (P(", ".join(k for k, _ in slip_from.most_common(2)), slips, note="לפי שולח התלושים") if slips
              else NA("המעסיק לא מוכר עדיין למנוע"))),
            ("ותק לפי מיילים מהמעסיק", P(f"מ-{ym(min(m.sent_at for m in employer))}", employer) if employer
             else NA("המעסיק לא מוכר עדיין למנוע")),
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
            ("למי גופים פונים בתיבה", P(" · ".join(addressed) or "לא נמצא", addressed_msgs)),
            ("חשבונות על שמך", P(len(own_bills), own_bills)),
        ] + ([("חשבונות על שם " + hh["name"],
               P(", ".join(e.org_he for e in hh_rels) or 0, ep_msgs(hh_rels), note="חשבון משותף לפי הצהרתך"))]
             if hh else []) + plat_rows),
    ] + ([("תחומי עניין", interest_rows)] if interest_rows else [])

    # ---- findings about the person themselves. Times and counts only, and never a sender of an excluded kind
    ins = p.get("insights") or {}

    def fact(v, n=None, span="", note=None):
        return {"v": v, "n": n, "span": span, "why": None, "note": note}

    def wait_he(minutes: int) -> str:
        if minutes < 60:
            return f"כ-{minutes} דקות"
        return f"כ-{round(minutes / 60)} שעות" if minutes < 48 * 60 else f"כ-{round(minutes / 1440)} ימים"

    # ---- what the few read mails added, only where the envelope alone found nothing
    ro = p.get("read_out") or {}

    def upgrade(label, new, force=False):
        for _, rows in groups:
            for i, (name, r) in enumerate(rows):
                if name == label and (force or r["v"] is None):
                    rows[i] = (label, new)

    if ro.get("city"):
        c = ro["city"]
        a, b = ym(c["first"]), ym(c["last"])
        note = "מתוך חוזים וחשבונות שנקראו"
        upgrade("עיר מגורים לפי חשבונות", fact(c["name"], c["mails"], a if a == b else f"{a}–{b}", note))
        upgrade("גר/ה שם", fact(f"מ-{a} לפחות", c["mails"], a if a == b else f"{a}–{b}", note))
    if ro.get("employer"):
        upgrade("מעסיק לפי מיילים", fact(ro["employer"]["name"], ro["employer"]["mails"], note="מתוך תלושים שנקראו"),
                force=True)  # the slip names the employer; the envelope only names whoever sends the slips

    if ins:
        life = ins.get("life", {})

        def life_row(key):
            x = life.get(key) or {"n": 0, "years": []}
            return fact(x["n"], x["n"], span=", ".join(str(y) for y in x["years"]))

        recurring: dict[str, set[str]] = {}
        for i in p.get("receipt_ids", []):
            m = by_id.get(i)
            if m and m.direction == "in" and m.sender_class in ("registered", "unregistered"):
                recurring.setdefault(m.org_he or m.domain, set()).add(m.sent_at[:7])
        subs = sorted(((k, len(v)) for k, v in recurring.items() if len(v) >= 3), key=lambda x: -x[1])
        companies = {m.domain for m in readable if m.direction == "in" and m.domain}
        share = round(100 * ins["promotions"] / ins["in_period"]) if ins.get("in_period") else 0
        top = [
            ("התיבה במספרים", [
                ("מיילים בכל התיבה", fact(f"{ins['mailbox_total']:,}")),
                ("מיילים לפי שנה", fact(" · ".join(f"{y}: {n:,}" for y, n in sorted(ins["per_year"].items())))),
                ("חברות וגופים שכתבו לך", fact(len(companies), note="בלי אנשים פרטיים")),
                ("חלק הפרסומות בתיבה", fact(f"{share}%", note=f"{ins['promotions']:,} פרסומות")),
                ("מיילים שלא נקראו", fact(f"{ins['unread']:,}" if ins["unread"] else 0)),
            ]),
            ("ההרגלים שלך", [
                ("זמן התגובה החציוני שלך",
                 fact(wait_he(ins["reply_minutes"]), note=f"לפי {ins['reply_n']:,} תשובות. רק הזמנים, בלי תוכן")
                 if ins.get("reply_minutes") is not None else NA("אין מספיק תשובות כדי לחשב")),
                ("השעות שבהן את/ה שולח/ת הכי הרבה",
                 fact(f"\u2066{ins['active_from']:02d}:00–{(ins['active_from'] + 4) % 24:02d}:00\u2069",
                      note=f"{ins['active_share']}% מהמיילים שיצאו") if ins.get("active_from") is not None
                 else NA("אין מספיק מיילים יוצאים כדי לחשב")),
                ("מיילים ששלחת בשבוע", fact((round(ins["sent"] / ins["weeks"], 1) if ins["sent"] / ins["weeks"] >= 1 else "פחות מ-1") if ins.get("sent") else 0)),
            ]),
        ]
        rest = [
            ("מה עולה מהנושאים", [
                ("מיילים על משרות ומועמדות", life_row("job_search")), ("מיילים על טיסות", life_row("flights")),
                ("יעדי טיסה", fact(", ".join(ro.get("destinations") or []) or 0, len(ro.get("destinations") or []))),
                ("מיילים על הזמנות ומשלוחים", life_row("orders")), ("קורסים, כנסים והרצאות", life_row("learning")),
                ("מיילים על חוזים והסכמים", life_row("contracts")), ("מיילים ששלחת על חוזים", life_row("contracts_sent")),
                ("מיילים על הוראות קבע", life_row("standing_orders")),
                ("מיילים על מעבר מגורים", life_row("moving")), ("מיילים על רכישת נכס", life_row("property_docs")), ("ערעורים ותלונות ששלחת", life_row("disputes")),
                ("מיילים אישיים עם תודה בנושא", life_row("thanks")),
                ("מנויים וחיובים חוזרים", fact(", ".join(k for k, _ in subs[:8]) if subs else 0, len(subs),
                                              note="חשבוניות או קבלות ב-3 חודשים לפחות")),
            ]),
            ("מה התיבה חושפת", [
                ("התראות אבטחה בתיבה", life_row("security")), ("מסמכי הכנסה שיושבים בתיבה", life_row("documents")),
            ]),
        ]
        groups = groups + rest + top  # the mailbox statistics interest few people, so they go last

    # ---- the web and the public registries: by name only, so each row says it may be someone else
    out = p.get("outside") or {}
    if out.get("mentions") or out.get("licenses") or out.get("companies"):
        by_name = "לפי השם, ייתכן שזה מישהו אחר"
        web_rows = []
        if out.get("mentions"):
            web_rows.append(("אזכורים ברשת", {**fact(" · ".join(m["text"] for m in out["mentions"]), note=by_name), "links": out["mentions"]}))
        if out.get("licenses"):
            web_rows.append(("רישיונות במאגרים ציבוריים", fact(" · ".join(out["licenses"]), note=by_name)))
        if out.get("companies"):
            web_rows.append(("חברות על השם שלך", fact(" · ".join(out["companies"]), note=by_name)))
        groups = groups + [("ברשת ובמאגרים", web_rows)]

    # ---- rows the paragraph needs
    work_rows = next(rows for t, rows in groups if t == "עבודה והכנסה")
    if ro.get("job_scope"):
        work_rows.append(("היקף משרה", fact(f"{ro['job_scope']['pct']}%", ro["job_scope"]["mails"], note="מתוך תלושים שנקראו")))
    if ro.get("cv"):  # a month and a year: the file itself never reaches the engine
        cv_sent = ym(ro["cv"]["sent"] + "-01")
        work_rows.append(("קורות חיים ששלחת", fact(f"ב-{cv_sent}", 1)))
        if ro["cv"].get("current_since"):
            work_rows.append(("משרה נוכחית לפי קורות חיים", fact(f"מאז {ro['cv']['current_since']}", 1,
                                                              note=f"קורות חיים שנשלחו ב-{cv_sent}")))
    two_years_ago = f"{int(today[:4]) - 2}{today[4:]}"
    academic = Counter(m.domain for m in readable if m.direction == "in" and m.domain.endswith(".ac.il") and m.sent_at >= two_years_ago)
    if sum(academic.values()) >= 3:
        work_rows.append(("מוסד אקדמי בתיבה", P(", ".join(d for d, _ in academic.most_common(2)),
                                                [m for m in readable if m.domain in academic and m.sent_at >= two_years_ago])))

    # ---- the paragraph. Fixed sentences, each from one row and each saying only what that row says: no adjectives about
    # the person and no conclusion. Few numbers on purpose; the numbers are in the rows
    every_row = {name: r for _, rows in groups for name, r in rows}

    def has(label, at_least=None):
        r = every_row.get(label)
        if not r or r["v"] is None or r["v"] in NOTHING_FOUND:
            return None
        return r if at_least is None or (r.get("n") or 0) >= at_least else None

    portrait = []

    def say(label, text, join=None, url=None, needs=(), topic=None, ai=True):
        portrait.append({"label": label, "text": text, **({"join": join} if join else {}), **({"url": url} if url else {}),
                         **({"needs": list(needs)} if needs else {}), **({"topic": topic} if topic else {}),
                         **({} if ai else {"ai": False})})

    def fixed(label, text, needs=(), ai=True):
        say(label, text, needs=needs, topic=FACTS_TOPIC, ai=ai)

    def checked(label):  # the row exists and could be checked, so "nothing in the mailbox" may be said
        return label in every_row and every_row[label]["v"] is not None

    # ---- the facts that open the summary, one to a line and in a fixed order. Each says what is in the mailbox or is not,
    # and where the mailbox has nothing to judge by, the line is left out: silence is not a finding. The wording never names
    # the mailbox as the source ("לא נצפו", not "אין בתיבה"): whoever reads the summary is not told where a fact came from
    # The mailbox itself: the person sends from it every week, and whose names the organisations use in it. It rests on
    # several rows, and blacking out any of them takes the line down. It carries first names, so it never goes to the AI
    sends_weekly = bool(ins.get("sent")) and ins["sent"] / ins["weeks"] >= 1
    shared = bool(hh) and (by_holder["household"] >= 3 or gate == "household")
    if sends_weekly or shared:
        rests_on = (["מיילים ששלחת בשבוע"] if sends_weekly else []) + (
            ["למי גופים פונים בתיבה", "חשבונות על שם " + hh["name"], "חשבון ה-Gmail שחובר"] if shared else [])
        both = f"משותפת ל{owner['name_he'].split()[0]} ול{hh['name'].split()[0]}" if shared else ""
        fixed(rests_on[0], ", ".join(x for x in ("תיבת מייל פעילה" if sends_weekly else "תיבת מייל", both) if x) + ".",
              needs=rests_on[1:], ai=False)
    # regular payments and standing orders: always said, either way
    paying, orders = "ספקים בתשלום קבוע (6 חודשים ומעלה)", "מיילים על הוראות קבע"
    n_paying = (has(paying) or {}).get("v") or 0
    paid = (f"תשלומים סדירים ל-{n_paying} ספקים, חצי שנה ומעלה" if n_paying > 1
            else "תשלום סדיר לספק אחד, חצי שנה ומעלה" if n_paying else "")
    fixed(paying, (", ו".join(x for x in (paid, "נצפו הוראות קבע" if has(orders) else "") if x)
                   or "לא נצפו תשלומים קבועים או הוראות קבע") + ".", needs=[orders])
    problems = "בעיות תשלום מהותיות בכל התקופה"
    if has(problems):
        fixed(problems, "נצפו בעיות תשלום מהותיות.")
    elif problems in every_row and n_paying:  # only with bills to judge by
        fixed(problems, "לא נצפו בעיות תשלום מהותיות.")
    # disputes and legal proceedings are the person's own business: said to them, never handed to the AI to build on
    disputes = "ערעורים ותלונות ששלחת"
    if has(disputes):
        fixed(disputes, "נצפו ערעורים או תלונות.", ai=False)
    elif checked(disputes):
        fixed(disputes, "לא נצפו מחלוקות, ערעורים או תלונות.", ai=False)
    legal = "הליך משפטי, הוצאה לפועל או עיקול"
    if has(legal):
        fixed(legal, "נצפו הודעות על הליך משפטי, הוצאה לפועל או עיקול.", ai=False)
    elif checked(legal):
        fixed(legal, "לא נצפו עיקול, הוצאה לפועל או הליך משפטי.", ai=False)
    alerts = "התראות בנק: חשבון מוגבל, שיק חזר, חריגה"
    if has(alerts):
        fixed(alerts, "נצפו התראות מהבנק.")
    elif banks and alerts in every_row:  # only when mail from a bank exists; otherwise the silence says nothing
        fixed(alerts, "לא נצפו התראות מהבנק על שיק שחזר, חריגה או הגבלת חשבון.")
    if has("חיסכון פנסיוני פעיל"):
        fixed("חיסכון פנסיוני פעיל", "קיים חיסכון פנסיוני פעיל.")
    # A page that names the person together with their city or workplace is about them, so it is said as it is. One that
    # carries the name alone may be about someone else, and stays below with that said
    tied_mentions = [m for m in out.get("mentions") or [] if m.get("tied")][:2]
    for m in tied_mentions:
        fixed("אזכורים ברשת", f"אזכור ברשת: {m['text']}.", ai=False)

    if r := has("עיר מגורים לפי חשבונות"):
        say("עיר מגורים לפי חשבונות", f"מגורים ב{r['v']}.")
    if address:
        say("עדכון כתובת ברשות האוכלוסין", f"עדכון כתובת מגורים במשרד הפנים ב-{ym(address[-1].sent_at)}.")
    # A mortgage in a subject is often an advert, so it counts only when the person wrote about it themselves
    own_mortgage = [m for m in grep("משכנתא") if m.direction == "out"]
    if own_mortgage:
        say("משכנתא", "יש משכנתא.")
    if has("מיילים על רכישת נכס"):
        say("מיילים על רכישת נכס", "מסמכים על רכישת נכס.")
    if (r := has("מעסיק לפי מיילים")) and "שולח" not in (r.get("note") or ""):  # the sender of the slips may be a payroll firm
        say("מעסיק לפי מיילים", f"עבודה ב{'-' if re.match('[A-Za-z0-9]', str(r['v'])) else ''}{r['v']}.")
    if r := has("ותק לפי מיילים מהמעסיק"):
        say("ותק לפי מיילים מהמעסיק", f"עבודה שם {r['v'].replace('מ-', 'לפחות מ-', 1)}.")
    if r := has("היקף משרה"):
        say("היקף משרה", f"היקף משרה של {r['v']}.")
    if r := has("משרה נוכחית לפי קורות חיים"):
        say("משרה נוכחית לפי קורות חיים", f"משרה נוכחית {r['v']}, לפי קורות חיים.")
    if r := has("מוסד אקדמי בתיבה"):
        say("מוסד אקדמי בתיבה", f"קשר בשנתיים האחרונות עם מוסד אקדמי: {r['v']}.")
    if has("מיילים ששלחת על חוזים", 2):
        say("מיילים ששלחת על חוזים", "התכתבות יוצאת על חוזים והסכמים.")
    if has("קורסים, כנסים והרצאות", 3):
        say("קורסים, כנסים והרצאות", "קורסים, כנסים והרצאות.")
    if r := has("יעדי טיסה"):
        say("יעדי טיסה", f"טיסות אל {r['v']}.")
    for label, _ in interest_rows:
        if INTEREST_KEYS.get(label) in ("fitness", "tech", "travel"):  # a streaming account or a credit card says nothing about a person
            say(label, label, join="תחומי עניין")
    for label, r in plat_rows:
        if r.get("link"):
            say(label, label + (" (לפי השם)" if r.get("note") else ""), join="חשבונות ברשת", url=r["link"])
    for m in out.get("mentions") or []:
        if m not in tied_mentions and re.search(r"אלוף|אלופת|מקום ראשון|זכה ב|זכתה ב|champion|winner", m["text"], re.I):
            say("אזכורים ברשת", f"אזכור ברשת, לפי השם בלבד: {m['text']}.")
    if r := has("רישיונות במאגרים ציבוריים"):
        say("רישיונות במאגרים ציבוריים", f"במאגרים הציבוריים, לפי השם בלבד: {r['v']}.")
    if r := has("חברות על השם שלך"):
        say("חברות על השם שלך", f"ברשם החברות, לפי השם בלבד: {r['v']}.")

    topics = {"מגורים": ("עיר מגורים לפי חשבונות", "גר/ה שם", "עדכון כתובת ברשות האוכלוסין", "מיילים על מעבר מגורים", "משכנתא",
                         "מיילים על רכישת נכס", "חשבונות שוטפים: חשמל, גז, מים, תקשורת"),
              "עבודה ולימודים": ("מעסיק לפי מיילים", "ותק לפי מיילים מהמעסיק", "היקף משרה", "משרה נוכחית לפי קורות חיים", "מוסד אקדמי בתיבה",
                                 "מיילים ששלחת על חוזים", "קורסים, כנסים והרצאות"),
              "כספים": ("הקשר הארוך ביותר עם ספק",),
              "פנאי": ("יעדי טיסה",)}
    for x in portrait:
        if x.get("topic"):  # the fixed facts already have theirs, and are always shown
            x["main"] = True
            continue
        x["main"] = x["label"] in ("עיר מגורים לפי חשבונות", "עדכון כתובת ברשות האוכלוסין", "משכנתא", "מעסיק לפי מיילים", "היקף משרה",
                                   "מוסד אקדמי בתיבה") or x.get("join") == "תחומי עניין"
        x["topic"] = next((t for t, labels in topics.items() if x["label"] in labels),
                          "פנאי" if x.get("join") == "תחומי עניין" else "ברשת")
    # what the AI may use besides subjects: facts from the mailbox, not what a name search found about someone of that name,
    # and not the lines marked as the person's own business
    ai_facts = [{"label": x["label"], "text": x["text"]} for x in portrait if x["topic"] != "ברשת" and x.get("ai", True)]

    # ---- what the AI paragraph may see: subjects from businesses only, with whatever identifies someone taken out. `readable`
    # already leaves out personal senders and excluded sectors. A stranger's name inside a subject can't be recognised here
    name_words = {w for n in own_names + ([hh["name"]] if hh else []) for w in n.split() if len(w) >= 2}

    def bare(subject):
        t = re.sub(r"\S+@\S+|https?://\S+|\d+", " ", subject)
        # a street and the strangers these notices quote identify someone, and neither helps a conclusion
        t = re.sub(r"(?:ב?רחוב|רח['׳])\s+\S+(?:\s+\S+)?", " ", t)
        t = re.sub(r"^.*?\b(?:has just read|paid you)\b", " ", t)
        for w in name_words:
            t = t.replace(w, " ")
        return re.sub(r"\s+", " ", re.sub(r"ת\.?\s*ז\.?", " ", t)).strip(" -–:|,.")

    # The AI reads for change over time, so every quarter gets its share of the lines, and within it every sender
    def in_turns(lists):
        out, i = [], 0
        while True:
            layer = [x[i] for x in lists if i < len(x)]
            if not layer:
                return out
            out += layer
            i += 1

    # A job alert is a mailing list: it says a person once signed up to a job site, not that they are looking for work
    # now. Left in, hundreds of them read as a job hunt. An answer to an application is not an alert, and stays
    def job_alert(m):
        return any(m.domain == d or m.domain.endswith("." + d) for d in JOB_BOARDS) or JOB_ALERT.search(m.subject)

    seen_subjects, by_quarter = set(), {}
    for m in sorted(readable, key=lambda x: x.sent_at, reverse=True):
        text = bare(m.subject)
        who = m.org_he or m.domain
        if len(text) >= 4 and "פרסומת" not in text and (who, text) not in seen_subjects and not job_alert(m):
            seen_subjects.add((who, text))
            quarter = (m.sent_at[:4], (int(m.sent_at[5:7]) - 1) // 3)
            by_quarter.setdefault(quarter, {}).setdefault(who, []).append({"d": m.sent_at[:7], "o": who, "s": text[:160]})
    quarters = [in_turns(list(senders.values())) for senders in by_quarter.values()]
    ai_input = sorted(in_turns(quarters)[:400], key=lambda x: x["d"], reverse=True)

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
        "portrait": portrait, "ai_input": ai_input, "ai_facts": ai_facts,
        "suppliers": [{"org_he": e.org_he, "first": ym(e.first), "last": ym(e.last), "months": e.months_active,
                       "active": e.status == "active", "holder": holder_he[e.holder]}
                      for e in sorted(rel, key=lambda e: -e.months_active)],
        "minor": [{"org_he": e.org_he, "first": e.first, "last": e.last, "n_in": e.n_in, "level": e.max_level}
                  for e in minor],
        "unknown": [{"domain": t["domain"], "skeleton": scrub(t["skeleton"]), "count": t["count"],
                     "registered": t["domain"] in registered_doms} for t in unknown],
    }, ensure_ascii=False)
