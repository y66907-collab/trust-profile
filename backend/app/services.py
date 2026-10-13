"""Business logic. The API layer stays thin; all writes go through here so audit + sanitising are never skipped."""

import hashlib
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.connectors import referee as ref
from app.connectors.base import Connector, EvidenceDraft
from app.connectors.sanitize import sanitize
from app.connectors.tabu import NullTabuLookup, TabuLookup, landlord_is_registered_owner
from app.models import (
    AuditLog,
    Consent,
    Evidence,
    EvidenceKind,
    Person,
    ProofLevel,
    RefereeRequest,
    ShareLink,
    ShareView,
)

tabu_lookup: TabuLookup = NullTabuLookup()


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def audit(db: Session, person_id: str, action: str, **detail) -> None:
    db.add(AuditLog(person_id=person_id, action=action, detail=detail))


# ---------- connect ----------

def record_consent(db: Session, person: Person, connector: Connector) -> None:
    db.add(Consent(person_id=person.id, source_key=connector.key, scope=connector.scope_he))
    audit(db, person.id, "consent.granted", source=connector.key)


def store_evidence(db: Session, person: Person, connector: Connector, drafts: list[EvidenceDraft]) -> list[Evidence]:
    drafts = sanitize(connector, drafts)
    # Replace previous evidence from the same source (refresh, not accumulate)
    for old in db.scalars(select(Evidence).where(Evidence.person_id == person.id, Evidence.source_key == connector.key)):
        db.delete(old)
    rows = []
    for d in drafts:
        e = Evidence(
            person_id=person.id,
            source_key=connector.key,
            kind=connector.kind.value,
            field=d.field,
            value=d.value,
            display=d.display,
            proof_level=int(d.proof_level),
            expires_at=_now() + timedelta(days=settings.evidence_retention_days),
        )
        db.add(e)
        rows.append(e)
    audit(db, person.id, "evidence.stored", source=connector.key, count=len(rows))
    return rows


def revoke_source(db: Session, person: Person, source_key: str) -> int:
    n = 0
    for e in db.scalars(select(Evidence).where(Evidence.person_id == person.id, Evidence.source_key == source_key)):
        db.delete(e)
        n += 1
    for c in db.scalars(select(Consent).where(Consent.person_id == person.id, Consent.source_key == source_key)):
        c.revoked_at = _now()
    audit(db, person.id, "source.revoked", source=source_key, deleted=n)
    return n


def active_evidence(db: Session, person_id: str, kinds: list[str] | None = None) -> list[Evidence]:
    q = select(Evidence).where(Evidence.person_id == person_id, Evidence.revoked.is_(False))
    if kinds is not None:
        q = q.where(Evidence.kind.in_(kinds))
    now = _now()
    return [e for e in db.scalars(q) if _aware(e.expires_at) > now]


def completeness(db: Session, person_id: str) -> dict:
    """Completeness meter. NOT a trust score: it says how much was proven, not who the person is."""
    ev = active_evidence(db, person_id)
    kinds_done = {e.kind for e in ev}
    all_kinds = [k.value for k in EvidenceKind]
    return {
        "percent": round(100 * len(kinds_done) / len(all_kinds)),
        "done": sorted(kinds_done),
        "missing": [k for k in all_kinds if k not in kinds_done],
    }


# ---------- referees ----------

def contact_hash(contact: str) -> str:
    return hashlib.sha256(contact.strip().lower().encode()).hexdigest()


def create_referee_request(db: Session, person: Person, role: str, name: str, contact: str, context: dict) -> RefereeRequest:
    if role not in ref.QUESTIONS:
        raise ValueError(f"unknown role {role}")
    r = RefereeRequest(
        person_id=person.id, role=role, referee_name=name, contact_hash=contact_hash(contact), context=context,
    )
    db.add(r)
    audit(db, person.id, "referee.requested", role=role)
    # TODO: send WhatsApp / SMS with the link
    return r


def answer_referee(db: Session, r: RefereeRequest, answers: dict) -> Evidence:
    clean = ref.validate_answers(r.role, answers)
    r.answers = clean
    r.status = "answered"
    r.answered_at = _now()

    level = ProofLevel.THIRD_PARTY
    display = ref.summary_he(r.role, clean)
    # Landlord referee + Tabu: upgrade to authoritative when the referee is the registered owner
    if r.role == "landlord" and landlord_is_registered_owner(
        tabu_lookup, r.referee_name, (r.context or {}).get("gush_helka")
    ):
        level = ProofLevel.AUTHORITATIVE
        display += " · בעלים רשום בטאבו"

    e = Evidence(
        person_id=r.person_id,
        source_key=f"ref.{r.role}",
        kind=EvidenceKind.REFERENCE.value,
        field=f"referee_{r.id}",
        value={"role": r.role, "answers": clean, "city": (r.context or {}).get("city")},
        display=display,
        proof_level=int(level),
        expires_at=_now() + timedelta(days=settings.evidence_retention_days),
    )
    db.add(e)
    audit(db, r.person_id, "referee.answered", role=r.role, level=int(level))
    return e


# ---------- sharing ----------

CONTEXT_DEFAULT_KINDS = {
    "rental": ["identity", "work", "home", "reference"],
    "hiring": ["identity", "work", "reference", "reputation"],
    "pro": ["identity", "reference", "reputation"],
    "tickets": ["identity", "reputation", "presence"],
}


def create_share(db: Session, person: Person, context: str, kinds: list[str] | None, days: int | None, one_time: bool) -> ShareLink:
    kinds = kinds or CONTEXT_DEFAULT_KINDS.get(context, [k.value for k in EvidenceKind])
    s = ShareLink(
        person_id=person.id,
        context=context,
        included_kinds=kinds,
        expires_at=_now() + timedelta(days=days or settings.share_default_days),
        one_time=one_time,
    )
    db.add(s)
    audit(db, person.id, "share.created", context=context, kinds=kinds)
    return s


def share_is_open(db: Session, s: ShareLink) -> bool:
    if s.revoked_at or _aware(s.expires_at) <= _now():
        return False
    if s.one_time and db.scalar(select(ShareView).where(ShareView.share_id == s.id)) is not None:
        return False
    return True


def view_share(db: Session, s: ShareLink) -> dict:
    """What a viewer sees: display strings + proof levels. Never the raw `value`."""
    ev = active_evidence(db, s.person_id, s.included_kinds)
    db.add(ShareView(share_id=s.id))
    audit(db, s.person_id, "share.viewed", share=s.id)
    person = db.get(Person, s.person_id)
    return {
        "name": person.display_name,
        "context": s.context,
        "items": [
            {"kind": e.kind, "display": e.display, "proof_level": e.proof_level,
             "verified_at": e.verified_at.date().isoformat()}
            for e in sorted(ev, key=lambda e: (e.kind, -e.proof_level))
        ],
    }
