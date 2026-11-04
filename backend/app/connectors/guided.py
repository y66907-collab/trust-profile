"""Guided download ("הורדה מונחית").

The user opens the official site (e.g. Bituach Leumi), logs in THERE, downloads the document,
and shares it into the app. We parse it and produce evidence.

This file defines one generic connector class + concrete sources.
Parsing is a stub: `complete()` currently expects already-extracted fields.
TODO: document parser (PDF text -> fields), with per-source validators and forgery checks.
"""

from typing import Any

from app.connectors.base import (
    Availability,
    Connector,
    ConnectorError,
    EvidenceDraft,
    Method,
    StartResult,
)
from app.models import EvidenceKind, ProofLevel


class GuidedDownloadConnector(Connector):
    method = Method.GUIDED
    availability = Availability.NOW
    source_url: str
    steps_he: tuple[str, ...]

    def not_ready_reason(self) -> str | None:
        return "קריאת המסמך עוד לא נכתבה"

    def start(self, person_id: str, params: dict[str, Any]) -> StartResult:
        return StartResult(
            kind="instructions",
            data={"open_url": self.source_url, "steps": list(self.steps_he)},
        )

    def complete(self, person_id: str, payload: dict[str, Any]) -> list[EvidenceDraft]:
        extracted = payload.get("extracted")
        if not isinstance(extracted, dict):
            raise ConnectorError("expected 'extracted' fields (parser not implemented yet)")
        return self.to_evidence(extracted)

    def to_evidence(self, x: dict[str, Any]) -> list[EvidenceDraft]:  # pragma: no cover
        raise NotImplementedError


class BituachLeumiWork(GuidedDownloadConnector):
    key = "work.btl"
    title_he = "תקופות עבודה, ביטוח לאומי"
    kind = EvidenceKind.WORK
    max_proof_level = ProofLevel.AUTHORITATIVE
    scope_he = "רשימת המעסיקים ותאריכי העבודה. לא שכר, לא קצבאות, לא מידע רפואי."
    fields = ("employment_history",)
    source_url = "https://www.btl.gov.il/"
    steps_he = (
        "התחברי לאזור האישי בביטוח לאומי",
        "בחרי 'אישור תקופות עבודה'",
        "הורידי את ה-PDF ושתפי לאפליקציה",
    )

    def to_evidence(self, x: dict[str, Any]) -> list[EvidenceDraft]:
        periods = x.get("periods") or []
        if not periods:
            raise ConnectorError("no employment periods found")
        employers = {p["employer"] for p in periods}
        years = round(sum(p.get("months", 0) for p in periods) / 12, 1)
        return [
            EvidenceDraft(
                field="employment_history",
                value={"periods": periods, "total_years": years},
                display=f"{years} שנות עבודה, {len(employers)} מעסיקים",
                proof_level=ProofLevel.AUTHORITATIVE,
            )
        ]


class RentalContract(GuidedDownloadConnector):
    key = "home.contract"
    title_he = "חוזה שכירות"
    kind = EvidenceKind.HOME
    max_proof_level = ProofLevel.DOCUMENTED
    scope_he = "עיר, תקופת השכירות ושם המשכיר. הכתובת המדויקת לא תוצג לאף אחד."
    fields = ("rental",)
    source_url = ""
    steps_he = ("פתחי את החוזה מהמייל או מאתר החתימה", "שתפי את הקובץ לאפליקציה")

    def to_evidence(self, x: dict[str, Any]) -> list[EvidenceDraft]:
        for k in ("city", "start", "landlord_name"):
            if not x.get(k):
                raise ConnectorError(f"missing {k}")
        return [
            EvidenceDraft(
                field="rental",
                value={
                    "city": x["city"],
                    "start": x["start"],
                    "end": x.get("end"),
                    "landlord_name": x["landlord_name"],
                    "gush_helka": x.get("gush_helka"),  # used for Tabu cross-check, never displayed
                },
                display=f"שוכר ב{x['city']} מ-{x['start']}",
                proof_level=ProofLevel.DOCUMENTED,
            )
        ]
