from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import services as svc
from app.connectors import referee as ref
from app.connectors import registry
from app.connectors.base import ConnectorError
from app.db import get_session
from app.models import AuditLog, Person, RefereeRequest, ShareLink, ShareView

router = APIRouter()


def _person(db: Session, person_id: str) -> Person:
    p = db.get(Person, person_id)
    if not p:
        raise HTTPException(404, "person not found")
    return p


# ---------- catalog ----------

@router.get("/sources")
def list_sources():
    return [c.describe() for c in registry.REGISTRY.values()]


# ---------- persons ----------

class PersonIn(BaseModel):
    display_name: str


@router.post("/persons", status_code=201)
def create_person(body: PersonIn, db: Session = Depends(get_session)):
    p = Person(display_name=body.display_name)
    db.add(p)
    db.flush()
    svc.audit(db, p.id, "person.created")
    db.commit()
    return {"id": p.id, "display_name": p.display_name}


@router.get("/persons/{person_id}/me")
def what_we_store(person_id: str, db: Session = Depends(get_session)):
    """'What is stored about me' — everything, including raw values. Only for the person themselves."""
    _person(db, person_id)
    return {
        "evidence": [
            {"source": e.source_key, "kind": e.kind, "field": e.field, "value": e.value, "display": e.display,
             "proof_level": e.proof_level, "expires_at": e.expires_at.isoformat()}
            for e in svc.active_evidence(db, person_id)
        ],
        "completeness": svc.completeness(db, person_id),
    }


@router.get("/persons/{person_id}/audit")
def audit_log(person_id: str, db: Session = Depends(get_session)):
    rows = db.scalars(select(AuditLog).where(AuditLog.person_id == person_id).order_by(AuditLog.at.desc()))
    return [{"action": a.action, "detail": a.detail, "at": a.at.isoformat()} for a in rows]


# ---------- connect ----------

@router.post("/persons/{person_id}/connect/{source_key}/start")
def connect_start(person_id: str, source_key: str, params: dict[str, Any] | None = None,
                  db: Session = Depends(get_session)):
    _person(db, person_id)
    c = registry.get(source_key)
    if not c:
        raise HTTPException(404, "unknown source")
    try:
        res = c.start(person_id, params or {})
    except ConnectorError as e:
        raise HTTPException(400, str(e))
    return {"source": c.describe(), "next": res.kind, "data": res.data}


@router.post("/persons/{person_id}/connect/{source_key}/complete")
def connect_complete(person_id: str, source_key: str, payload: dict[str, Any],
                     db: Session = Depends(get_session)):
    p = _person(db, person_id)
    c = registry.get(source_key)
    if not c:
        raise HTTPException(404, "unknown source")
    try:
        drafts = c.complete(person_id, payload)
    except ConnectorError as e:
        raise HTTPException(400, str(e))
    svc.record_consent(db, p, c)
    rows = svc.store_evidence(db, p, c, drafts)
    db.commit()
    return {"stored": [{"field": r.field, "display": r.display, "proof_level": r.proof_level} for r in rows]}


@router.delete("/persons/{person_id}/sources/{source_key}")
def revoke(person_id: str, source_key: str, db: Session = Depends(get_session)):
    p = _person(db, person_id)
    n = svc.revoke_source(db, p, source_key)
    db.commit()
    return {"deleted": n}


# ---------- referees ----------

class RefereeIn(BaseModel):
    role: str
    name: str
    contact: str               # phone or email; stored only as a hash
    city: str | None = None
    gush_helka: str | None = None


@router.post("/persons/{person_id}/referees", status_code=201)
def request_referee(person_id: str, body: RefereeIn, db: Session = Depends(get_session)):
    p = _person(db, person_id)
    try:
        r = svc.create_referee_request(db, p, body.role, body.name, body.contact,
                                       {"city": body.city, "gush_helka": body.gush_helka})
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    return {"id": r.id, "link": f"/r/{r.token}"}


@router.get("/r/{token}")
def referee_form(token: str, db: Session = Depends(get_session)):
    r = db.scalar(select(RefereeRequest).where(RefereeRequest.token == token))
    if not r or r.status != "pending":
        raise HTTPException(404, "link not valid")
    person = db.get(Person, r.person_id)
    return {"about": person.display_name, "role": r.role, "questions": ref.QUESTIONS[r.role]}


@router.post("/r/{token}")
def referee_submit(token: str, answers: dict[str, Any], db: Session = Depends(get_session)):
    r = db.scalar(select(RefereeRequest).where(RefereeRequest.token == token))
    if not r or r.status != "pending":
        raise HTTPException(404, "link not valid")
    e = svc.answer_referee(db, r, answers)
    db.commit()
    return {"thanks": True, "proof_level": e.proof_level}


# ---------- sharing ----------

class ShareIn(BaseModel):
    context: str = "rental"
    kinds: list[str] | None = None
    days: int | None = None
    one_time: bool = False


@router.post("/persons/{person_id}/shares", status_code=201)
def create_share(person_id: str, body: ShareIn, db: Session = Depends(get_session)):
    p = _person(db, person_id)
    s = svc.create_share(db, p, body.context, body.kinds, body.days, body.one_time)
    db.commit()
    return {"id": s.id, "link": f"/s/{s.token}", "expires_at": s.expires_at.isoformat(), "kinds": s.included_kinds}


@router.get("/persons/{person_id}/shares/{share_id}/views")
def share_views(person_id: str, share_id: str, db: Session = Depends(get_session)):
    rows = db.scalars(select(ShareView).where(ShareView.share_id == share_id))
    return [v.viewed_at.isoformat() for v in rows]


@router.delete("/persons/{person_id}/shares/{share_id}")
def revoke_share(person_id: str, share_id: str, db: Session = Depends(get_session)):
    s = db.get(ShareLink, share_id)
    if not s or s.person_id != person_id:
        raise HTTPException(404)
    s.revoked_at = svc._now()
    svc.audit(db, person_id, "share.revoked", share=share_id)
    db.commit()
    return {"revoked": True}


@router.get("/s/{token}")
def open_share(token: str, db: Session = Depends(get_session)):
    s = db.scalar(select(ShareLink).where(ShareLink.token == token))
    if not s or not svc.share_is_open(db, s):
        raise HTTPException(404, "link expired or revoked")
    out = svc.view_share(db, s)
    db.commit()
    return out
