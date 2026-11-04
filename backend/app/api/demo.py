"""Dev-only demo page: create a person, connect GitHub / Telegram, see the evidence. (/demo)"""

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(prefix="/demo", tags=["demo"])
PAGE = Path(__file__).resolve().parent.parent / "static" / "demo.html"


@router.get("", response_class=HTMLResponse)
def page():
    return PAGE.read_text(encoding="utf-8")
