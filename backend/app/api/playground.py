"""Dev-only playground: search public registries from a small web page (/playground)."""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app.public_registries import lookup, valid_israeli_id

router = APIRouter(prefix="/playground", tags=["playground"])

PAGE = Path(__file__).resolve().parent.parent / "static" / "playground.html"


class SearchIn(BaseModel):
    name_he: str = ""
    name_en: str = ""
    city: str = ""
    # Sent in the body (not the URL) so it never lands in access logs. Validated, never stored or echoed.
    id_number: str = ""


@router.get("", response_class=HTMLResponse)
def page():
    return PAGE.read_text(encoding="utf-8")


@router.post("/search")
def search(body: SearchIn):
    if not (body.name_he.strip() or body.name_en.strip()):
        raise HTTPException(422, "name_he or name_en is required")
    res = lookup(body.name_he.strip(), body.name_en.strip(), body.city.strip())
    res["id_valid"] = valid_israeli_id(body.id_number) if body.id_number.strip() else None
    return res
