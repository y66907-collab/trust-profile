"""Phone verification via OTP. In dev mode the code is returned in the response."""

import hashlib
import secrets
from typing import Any

from app.config import settings
from app.connectors.base import (
    Availability,
    Connector,
    ConnectorError,
    EvidenceDraft,
    Method,
    StartResult,
)
from app.models import EvidenceKind, ProofLevel

# In-memory for the skeleton. Move to Redis / DB with TTL before production.
_pending: dict[str, tuple[str, str]] = {}  # person_id -> (phone, code_hash)


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


class PhoneConnector(Connector):
    key = "id.phone"
    title_he = "טלפון"
    kind = EvidenceKind.IDENTITY
    method = Method.VENDOR
    availability = Availability.NOW
    max_proof_level = ProofLevel.DOCUMENTED
    scope_he = "מספר הטלפון שלך, כדי לוודא שהוא שלך. לא ניגש לאנשי הקשר."
    fields = ("phone_verified",)

    def start(self, person_id: str, params: dict[str, Any]) -> StartResult:
        phone = (params.get("phone") or "").strip()
        if not phone:
            raise ConnectorError("phone is required")
        code = f"{secrets.randbelow(10**6):06d}"
        _pending[person_id] = (phone, _h(code))
        # TODO: send SMS via provider when not in dev mode
        data = {"sent_to": phone[-4:].rjust(len(phone), "•")}
        if settings.dev_mode:
            data["dev_code"] = code
        return StartResult(kind="otp_sent", data=data)

    def complete(self, person_id: str, payload: dict[str, Any]) -> list[EvidenceDraft]:
        phone, code_hash = _pending.pop(person_id, (None, None))
        if not phone or _h(str(payload.get("code", ""))) != code_hash:
            raise ConnectorError("invalid code")
        return [
            EvidenceDraft(
                field="phone_verified",
                value={"phone_hash": _h(phone), "last4": phone[-4:]},
                display=f"טלפון מאומת (מסתיים ב-{phone[-4:]})",
                proof_level=ProofLevel.DOCUMENTED,
            )
        ]
