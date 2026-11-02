"""Deterministic mail-profile engine (demo).

Input : envelopes only (thread id, message id, sender, first recipient, subject). No bodies.
Output: stage-by-stage JSON so every finding can be traced back to the messages behind it.

Stages
  1. load      envelope -> Message (date decoded from the Gmail id, direction, domains)
  2. sender    domain -> organisation, via senders.json (curated table, not AI)
  3. template  subject -> skeleton (numbers/months masked), then Drain-style merge per sender
  4. label     template -> event type, via labels.json (the ONLY step an LLM does in production,
               once per template, never per message; here the file is filled by hand)
  5. event     labelled message -> Event (type, org, date, reference)
  6. episode   events of one org -> cases with a state machine (open / resolved / quiet)
               + the person's own outgoing mail to that org inside the case window
  7. rule      materiality rules from rules.json decide what becomes a finding
  8. finding   fixed Hebrew sentence templates filled with numbers and dates

Same input + same three JSON files -> same output, every time.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path

HERE = Path(__file__).parent
OWN: set[str] = set()  # the subject's own address(es); the pilot fills it from the Gmail profile
PERSONAL_DOMAINS = {"gmail.com", "walla.co.il", "walla.com", "hotmail.com", "outlook.com", "yahoo.com", "012.net.il",
                    "netvision.net.il", "bezeqint.net", "013net.net", "icloud.com", "live.com", "googlemail.com"}


# ----------------------------------------------------------------------------------------------
# 1. load
# ----------------------------------------------------------------------------------------------
@dataclass
class Message:
    thread_id: str
    msg_id: str
    sent_at: str
    direction: str  # in | out
    counterparty: str  # the other side's address
    domain: str
    subject: str
    org: str | None = None
    org_he: str | None = None
    sector: str | None = None
    sender_class: str = ""  # registered | unregistered | personal | excluded | unknown
    holder: str | None = None  # owner | household | None (name on the bill)
    skeleton: str = ""
    template_id: str = ""
    event_type: str | None = None


def gmail_id_date(hex_id: str) -> date:
    """A Gmail message id is a hex number whose top bits are the epoch milliseconds."""
    return datetime.fromtimestamp((int(hex_id, 16) >> 20) / 1000, UTC).date()


def domain_of(addr: str) -> str:
    return addr.split("@")[-1].lower().strip(" >") if "@" in addr else ""


def load(paths: list[Path]) -> list[Message]:
    seen: set[str] = set()
    out: list[Message] = []
    for p in paths:
        with p.open(encoding="utf-8") as f:
            for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
                if len(row) < 4 or not re.fullmatch(r"[0-9a-f]{10,20}", row[1].strip()):
                    continue
                row += [""] * (6 - len(row))
                thread_id, msg_id, _count, sender, to, subject = (c.strip() for c in row[:6])
                if msg_id in seen:
                    continue
                seen.add(msg_id)
                outgoing = sender.lower() in OWN
                other = to if outgoing else sender
                out.append(Message(thread_id, msg_id, gmail_id_date(msg_id).isoformat(), "out" if outgoing else "in",
                                   other.lower(), domain_of(other), subject))
    out.sort(key=lambda m: m.sent_at)
    return out


# ----------------------------------------------------------------------------------------------
# 2. sender registry
# ----------------------------------------------------------------------------------------------
def resolve_senders(msgs: list[Message], registry: dict, excluded: dict | None = None,
                    platforms: tuple = ()) -> None:
    """excluded: sectors the engine is not allowed to read at all (health, donations...). Policy, not AI.
    platforms: invoicing services that send for many businesses; the org stays empty until a label names it."""
    excluded = excluded or {}
    for m in msgs:
        if not m.domain:
            m.sender_class = "unknown"
            continue
        if m.domain in PERSONAL_DOMAINS:
            m.sender_class = "personal"
            continue
        # longest registered suffix wins: mail.menora.co.il -> menora.co.il
        parts = m.domain.split(".")
        hit = next((".".join(parts[i:]) for i in range(len(parts) - 1) if ".".join(parts[i:]) in registry), None)
        if hit:
            e = registry[hit]
            m.sector = e["sector"]
            if e["sector"] in excluded:
                m.sender_class = "excluded"  # dropped before any further step; org is not even attached
                continue
            if e["sector"] not in platforms:
                m.org, m.org_he = e["org"], e["org_he"]
            m.sender_class = "registered"
        else:
            m.sender_class = "unregistered"


# ----------------------------------------------------------------------------------------------
# 3. templates
# ----------------------------------------------------------------------------------------------
MONTHS = ("ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר|"
          "january|february|march|april|may|june|july|august|september|october|november|december|"
          "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec")
_PREFIX = re.compile(r"^\s*((re|fw|fwd|השב|הועבר)\s*:\s*)+", re.I)
_MONTH = re.compile(rf"(?<![\w]){MONTHS}(?![\w])", re.I)
_NUM = re.compile(r"[#№]?\d[\d,./\-:]*")
_SPACE = re.compile(r"\s+")


NAMES: list[tuple[str, str]] = []  # (name as written, placeholder) — filled from owner.json, longest first
OWNER: dict = {}


def holder_of(subject: str) -> str | None:
    """Whose name is on this bill: the owner's, a declared household member's, or none we know."""
    for name, ph in NAMES:
        if name in (subject or ""):
            return "owner" if ph == "<OWNER>" else "household"
    return None


def mask(subject: str) -> str:
    s = _PREFIX.sub("", subject or "")
    for name, _ in NAMES:  # names out before anything else, so "<name> החשבונית שלך" and "החשבונית שלך" merge
        s = s.replace(name, " ")  # whose name it was is kept separately in Message.holder
    s = s.strip(" ,-")
    s = _MONTH.sub("<MONTH>", s)
    s = _NUM.sub("<N>", s)
    return _SPACE.sub(" ", s).strip().lower() or "<EMPTY>"


def _sim(a: list[str], b: list[str]) -> float:
    return sum(x == y for x, y in zip(a, b)) / len(a)


def mine_templates(msgs: list[Message], threshold: float = 0.6) -> dict[str, dict]:
    """Drain-style: per sender domain, subjects with the same token count are merged when most tokens agree;
    the tokens that disagree become <*>. Names, amounts and dates fall out as variables."""
    groups: dict[tuple[str, int], list[dict]] = defaultdict(list)
    templates: dict[str, dict] = {}
    for m in msgs:
        if m.sender_class not in ("registered", "unregistered"):
            continue
        toks = mask(m.subject).split(" ")
        key = (m.domain if m.direction == "in" else f"out:{m.domain}", len(toks))
        best, best_sim = None, 0.0
        for cl in groups[key]:
            s = _sim(cl["tokens"], toks)
            if s > best_sim:
                best, best_sim = cl, s
        # an invoicing platform writes the business name into the subject: merging would erase it
        need = 1.0 if m.sector == "platform" else threshold
        if best is None or best_sim < need:
            best = {"tokens": toks, "members": []}
            groups[key].append(best)
        else:
            best["tokens"] = [t if t == u else "<*>" for t, u in zip(best["tokens"], toks)]
        best["members"].append(m)
    for (dom, _), clusters in groups.items():
        for cl in clusters:
            skel = " ".join(cl["tokens"])
            tid = hashlib.sha1(f"{dom}|{skel}".encode()).hexdigest()[:8]
            for m in cl["members"]:
                m.skeleton, m.template_id = skel, tid
            templates[tid] = {"template_id": tid, "domain": dom, "skeleton": skel, "count": len(cl["members"]),
                              "examples": [m.subject for m in cl["members"][:3]]}
    return templates


# ----------------------------------------------------------------------------------------------
# 4. label  (production: LLM fills this once per NEW template, schema-constrained; demo: labels.json)
# ----------------------------------------------------------------------------------------------
def apply_labels(msgs: list[Message], templates: dict[str, dict], labels: list[dict]) -> None:
    """A label matches a template by domain + a substring of its skeleton. First match wins."""
    for t in templates.values():
        t["event_type"], t["org"] = None, None
        for lab in labels:
            if (lab["domain"] == t["domain"] or t["domain"].endswith("." + lab["domain"])) and lab["match"] in t["skeleton"]:
                t["event_type"] = lab["event_type"]
                t["org"] = (lab["org"], lab["org_he"]) if "org" in lab else None  # platform: the label names the business
                break
    for m in msgs:
        if m.template_id:
            t = templates[m.template_id]
            m.event_type = t["event_type"]
            if t["org"]:
                m.org, m.org_he = t["org"]


# ----------------------------------------------------------------------------------------------
# 5-6. events and episodes
# ----------------------------------------------------------------------------------------------
_REF = re.compile(r"\d{5,}")


@dataclass
class Episode:
    episode_key: str
    org: str
    org_he: str
    kind: str  # relationship | issue | case
    first: str
    last: str
    status: str
    events: Counter = field(default_factory=Counter)
    n_in: int = 0
    n_out: int = 0
    max_level: int = 0
    months_active: int = 0
    holder: str | None = None
    message_ids: list[str] = field(default_factory=list)


def _months(a: str, b: str) -> int:
    da, db = date.fromisoformat(a), date.fromisoformat(b)
    return (db.year - da.year) * 12 + db.month - da.month + 1


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def build_episodes(msgs: list[Message], rules: dict, today: str) -> list[Episode]:
    et = rules["event_types"]
    by_org: dict[str, list[Message]] = defaultdict(list)
    for m in msgs:
        if m.org:
            by_org[m.org].append(m)
    episodes: list[Episode] = []
    for org, ms in by_org.items():
        ms.sort(key=lambda m: m.sent_at)
        org_he = ms[0].org_he or org
        outgoing = [m for m in ms if m.direction == "out"]
        typed = [m for m in ms if m.direction == "in" and m.event_type in et]

        # relationship: the routine stream (bills, receipts) collapses into ONE row per org
        routine = [m for m in typed if et[m.event_type]["family"] == "routine"]
        if routine:
            ep = Episode(f"{org}:rel", org, org_he, "relationship", routine[0].sent_at, routine[-1].sent_at,
                         "active" if _days(routine[-1].sent_at, today) <= rules["relationship_active_days"] else "ended")
            ep.events.update(m.event_type for m in routine)
            ep.n_in = len(routine)
            ep.months_active = len({m.sent_at[:7] for m in routine})
            ep.message_ids = [m.msg_id for m in routine]
            holders = Counter(holder_of(m.subject) for m in routine)
            ep.holder = holders.most_common(1)[0][0]
            episodes.append(ep)

        # issues: consecutive events closer than the gap belong to the same case
        hot = [m for m in typed if et[m.event_type]["family"] == "issue"]
        cur: list[Message] = []
        for m in hot + [None]:
            if m is not None and (not cur or _days(cur[-1].sent_at, m.sent_at) <= rules["episode_gap_days"]):
                cur.append(m)
                continue
            if cur:
                episodes.append(_close_episode(org, org_he, cur, typed, outgoing, rules, today))
            cur = [m] if m is not None else []

    # cases with an official body: grouped by the case number in the subject, ACROSS organisations
    # (the regulator and the insurer answering it share one file number -> one case)
    cases: dict[str, list[Message]] = defaultdict(list)
    for m in msgs:
        if m.org and m.direction == "in" and m.event_type in et and et[m.event_type]["family"] == "case":
            refs = _REF.findall(m.subject)
            cases[refs[0] if refs else f"{m.org}:{m.sent_at[:7]}"].append(m)
    for ref, ms in cases.items():
        ms.sort(key=lambda m: m.sent_at)
        orgs = list(dict.fromkeys(m.org for m in ms))
        names = " + ".join(dict.fromkeys(m.org_he for m in ms))
        mine = [m for m in msgs if m.direction == "out" and m.org in orgs]
        ep = Episode(hashlib.sha1(f"case|{ref}".encode()).hexdigest()[:10], "+".join(orgs), names, "case",
                     ms[0].sent_at, ms[-1].sent_at, "open" if _days(ms[-1].sent_at, today) < rules["quiet_after_days"]
                     else "quiet")
        ep.events.update(m.event_type for m in ms)
        ep.n_in, ep.n_out = len(ms), len(mine)
        ep.message_ids = [m.msg_id for m in ms + mine]
        episodes.append(ep)
    return episodes


def _close_episode(org, org_he, cur, typed, outgoing, rules, today) -> Episode:
    et = rules["event_types"]
    first, last = cur[0].sent_at, cur[-1].sent_at
    fam = et[cur[0].event_type]["family"]
    refs = sorted({r for m in cur for r in _REF.findall(m.subject)})
    key = hashlib.sha1(f"{org}|{first}|{'|'.join(refs)}".encode()).hexdigest()[:10]
    # state machine: resolved if a closing event from the same org follows; quiet if nothing for N days
    closer = next((m for m in typed if et[m.event_type].get("closes") and m.sent_at >= last
                   and _days(last, m.sent_at) <= rules["resolve_within_days"]), None)
    if closer:
        status = "resolved"
    elif _days(last, today) >= rules["quiet_after_days"]:
        status = "quiet"
    else:
        status = "open"
    w0, w1 = first, (closer.sent_at if closer else last)
    pad = rules["outgoing_window_pad_days"]
    mine = [m for m in outgoing if _days(w0, m.sent_at) >= -pad and _days(m.sent_at, w1) >= -pad]
    ep = Episode(key, org, org_he, fam, first, closer.sent_at if closer else last, status)
    ep.events.update(m.event_type for m in cur)
    ep.n_in, ep.n_out = len(cur), len(mine)
    ep.max_level = max(et[m.event_type]["level"] for m in cur)
    ep.message_ids = [m.msg_id for m in cur] + [m.msg_id for m in mine] + ([closer.msg_id] if closer else [])
    return ep


# ----------------------------------------------------------------------------------------------
# 7-8. materiality rules and findings
# ----------------------------------------------------------------------------------------------
def fmt(d: str) -> str:
    return f"{d[5:7]}.{d[:4]}"


def span(a: str, b: str) -> str:
    return f"ב-{fmt(a)}" if a[:7] == b[:7] else f"בין {fmt(a)} ל-{fmt(b)}"


def n_he(n: int, one: str, many: str) -> str:
    return f"{one} אחת" if n == 1 else f"{n} {many}"


def findings(episodes: list[Episode], rules: dict, today: str) -> tuple[list[dict], list[dict]]:
    r, kept, dropped = rules["materiality"], [], []
    for ep in episodes:
        age_m = _months(ep.last, today) - 1
        why: str | None = None
        if ep.kind == "relationship":
            if ep.months_active < r["relationship_min_months"]:
                why = f"קשר של {ep.months_active} חודשים, מתחת לסף {r['relationship_min_months']}"
            else:
                yrs = round(_months(ep.first, ep.last) / 12, 1)
                text = (f"{ep.org_he}: קשר שוטף מ-{fmt(ep.first)} עד {fmt(ep.last)} "
                        f"({ep.months_active} חודשים עם חשבון או קבלה), בלי אירועי חיוב חריגים בתקופה")
                if any(o.org == ep.org and o.kind == "issue" for o in episodes):
                    text = text.replace(", בלי אירועי חיוב חריגים בתקופה", "")
                note = None
                if ep.holder == "household":
                    hh = OWNER["household"][0]
                    note = f"החשבון על שם {hh['label_he']}. לפי הצהרת בעל/ת הפרופיל: {hh['declared_he']}"
                elif ep.holder == "owner":
                    note = "החשבון על שם בעל/ת הפרופיל"
                kept.append({"section": "קשרים יציבים", "text": text, "note": note, "episode": ep.episode_key,
                             "years": yrs, "org_he": ep.org_he, "first": ep.first, "last": ep.last,
                             "months": ep.months_active, "status": ep.status, "holder": ep.holder})
                continue
        elif ep.kind == "issue":
            if ep.max_level < r["issue_min_level"] and ep.n_in < r["issue_min_events"]:
                why = f"תזכורת בודדת (דרגה {ep.max_level}, {ep.n_in} הודעות), מתחת לסף"
            elif ep.status == "resolved" and age_m > r["resolved_issue_max_age_months"]:
                why = f"נסגר לפני {age_m} חודשים, מעבר לחלון של {r['resolved_issue_max_age_months']}"
            else:
                st = {"resolved": "נסגר", "quiet": "לא נמצא המשך", "open": "פתוח"}[ep.status]
                text = (f"{ep.org_he}: {n_he(ep.n_in, 'הודעה', 'הודעות')} על בעיית תשלום {span(ep.first, ep.last)} "
                        f"(דרגה {ep.max_level} מתוך 4). מצב: {st}")
                kept.append({"section": "אירועי תשלום", "text": text, "episode": ep.episode_key, "org_he": ep.org_he,
                             "first": ep.first, "last": ep.last, "status": ep.status, "level": ep.max_level,
                             "n_in": ep.n_in, "n_out": ep.n_out})
                continue
        elif ep.kind == "case":
            st = {"open": "פעיל", "quiet": "לא נמצא המשך"}[ep.status]
            text = (f"{ep.org_he}: תיק פנייה מול גוף רשמי {span(ep.first, ep.last)}, "
                    f"{n_he(ep.n_in, 'הודעה', 'הודעות')} מהגוף. מצב: {st}")
            kept.append({"section": "פניות לגופים רשמיים", "text": text, "episode": ep.episode_key, "org_he": ep.org_he,
                         "first": ep.first, "last": ep.last, "status": ep.status, "n_in": ep.n_in, "n_out": ep.n_out})
            continue
        dropped.append({"episode": ep.episode_key, "org": ep.org_he, "kind": ep.kind, "why": why or "—"})
    return kept, dropped


# ----------------------------------------------------------------------------------------------
# run
# ----------------------------------------------------------------------------------------------
def run(raw: list[Path], today: str) -> dict:
    registry = json.loads((HERE / "senders.json").read_text(encoding="utf-8"))
    labels = json.loads((HERE / "labels.json").read_text(encoding="utf-8"))
    rules = json.loads((HERE / "rules.json").read_text(encoding="utf-8"))
    OWNER.clear()
    OWNER.update(json.loads((HERE / "owner.json").read_text(encoding="utf-8")))
    NAMES.clear()
    NAMES.extend([(n, "<OWNER>") for n in OWNER["own_names"]]
                 + [(n, "<HOUSEHOLD>") for h in OWNER["household"] for n in h["names"]])
    NAMES.sort(key=lambda x: -len(x[0]))

    msgs = load(raw)
    for m in msgs:
        m.holder = holder_of(m.subject)
    resolve_senders(msgs, registry, rules["excluded_sectors"], tuple(rules.get("platform_sectors", ())))
    templates = mine_templates(msgs)
    apply_labels(msgs, templates, labels)
    eps = build_episodes(msgs, rules, today)
    kept, dropped = findings(eps, rules, today)

    # coverage: how many templates explain 80% of business mail
    biz = [m for m in msgs if m.sender_class in ("registered", "unregistered") and m.direction == "in"]
    counts = sorted((t["count"] for t in templates.values() if not t["domain"].startswith("out:")), reverse=True)
    acc, n80 = 0, 0
    for c in counts:
        if acc >= 0.8 * len(biz):
            break
        acc, n80 = acc + c, n80 + 1
    labelled = sum(1 for m in biz if m.event_type)

    return {
        "rule_version": rules["version"],
        "today": today,
        "stats": {
            "messages": len(msgs),
            "date_range": [msgs[0].sent_at, msgs[-1].sent_at] if msgs else None,
            "by_class": Counter(m.sender_class for m in msgs),
            "by_direction": Counter(m.direction for m in msgs),
            "business_in": len(biz),
            "templates": len(counts),
            "templates_for_80pct": n80,
            "singletons": sum(1 for c in counts if c == 1),
            "business_in_labelled": labelled,
            "registered_orgs": len({m.org for m in msgs if m.org}),
        },
        "messages": [asdict(m) for m in msgs],
        "templates": sorted(templates.values(), key=lambda t: -t["count"]),
        "episodes": [{**asdict(e), "events": dict(e.events)} for e in eps],
        "findings": kept,
        "dropped": dropped,
    }


if __name__ == "__main__":
    today = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()
    raw = sorted((HERE / "raw").glob("*.tsv")) + sorted((HERE / "raw3").glob("*.tsv"))
    out = run(raw, today)
    (HERE / "out.json").write_text(json.dumps(out, ensure_ascii=False, indent=1, default=list), encoding="utf-8")
    s = out["stats"]
    print(json.dumps(s, ensure_ascii=False, default=dict, indent=1))
    print(f"\nfindings: {len(out['findings'])}  dropped: {len(out['dropped'])}")
    for f in out["findings"]:
        print(" -", f["section"], "|", f["text"])
