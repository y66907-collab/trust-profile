"""Browser-facing OAuth callbacks. The providers redirect here; we finish the flow and store evidence.

The person is identified from the signed `state` (GitHub) or from the signed widget payload + `person`
query param (Telegram), never from a cookie, so these endpoints have no session of their own.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app import services as svc
from app.connectors import github, registry
from app.connectors.base import ConnectorError
from app.db import get_session
from app.models import Person

router = APIRouter(prefix="/oauth", tags=["oauth"])


def _finish(db: Session, person_id: str, source_key: str, payload: dict) -> HTMLResponse:
    p = db.get(Person, person_id)
    if not p:
        raise HTTPException(404, "person not found")
    c = registry.get(source_key)
    try:
        drafts = c.complete(person_id, payload)
    except ConnectorError as e:
        raise HTTPException(400, str(e))
    svc.record_consent(db, p, c)
    rows = svc.store_evidence(db, p, c, drafts)
    db.commit()
    lines = "".join(f"<li>{r.display}</li>" for r in rows)
    return HTMLResponse(
        f'<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>{c.title_he}</title>'
        f'<body style="font-family:system-ui;padding:32px"><h2>✔ {c.title_he} חובר</h2><ul>{lines}</ul>'
        f'<p><a href="/demo?person={person_id}">חזרה</a></p></body></html>'
    )


@router.get("/github/callback", response_class=HTMLResponse)
def github_callback(code: str = "", state: str = "", error: str = "", db: Session = Depends(get_session)):
    if error:
        raise HTTPException(400, f"github: {error}")
    try:
        person_id = github.person_from_state(state)
    except ConnectorError as e:
        raise HTTPException(400, str(e))
    return _finish(db, person_id, "rep.github", {"code": code})


@router.get("/telegram/callback", response_class=HTMLResponse)
def telegram_callback(request: Request, person: str, db: Session = Depends(get_session)):
    # The Login Widget (redirect mode) appends id, first_name, username, photo_url, auth_date, hash as query params
    payload = {k: v for k, v in request.query_params.items() if k != "person"}
    return _finish(db, person, "soc.telegram", payload)
