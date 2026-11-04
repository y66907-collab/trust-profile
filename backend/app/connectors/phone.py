"""Phone verification via one-time code (SMS).

Before sending, Veriphone (if configured) checks the number is a real mobile line, so we don't pay for SMS that
can't arrive. That check is internal: it is not stored and not shown. Only the code proves possession.
With TP_SMS_PROVIDER=console nothing is sent and the code is returned to the client (dev only).
"""

import hashlib
import secrets
import time
from typing import Any
from urllib.parse import urlparse

from app.config import settings
from app.connectors import phone_line, sms
from app.connectors.base import (
    Availability,
    Connector,
    ConnectorError,
    EvidenceDraft,
    Method,
    StartResult,
)
from app.models import EvidenceKind, ProofLevel

CODE_TTL = 10 * 60          # a code is valid for 10 minutes
MAX_ATTEMPTS = 5            # wrong guesses per code
RESEND_COOLDOWN = 60        # seconds between sends to the same person
MAX_SENDS_PER_HOUR = 5      # SMS-pumping guard

# In-memory for the skeleton. Move to Redis / DB with TTL before production.
_pending: dict[str, dict] = {}            # person_id -> {phone, code_hash, expires, attempts}
_sends: dict[str, list[float]] = {}       # person_id -> send timestamps


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _message(code: str) -> str:
    host = urlparse(settings.public_base_url).hostname or "localhost"
    # Last line lets Android Chrome (WebOTP) and iOS offer the code above the keyboard: one tap, no typing.
    return f"קוד האימות שלך ב-Creds: {code}\nלא לשתף את הקוד עם אף אחד.\n\n@{host} #{code}"


class PhoneConnector(Connector):
    key = "id.phone"
    title_he = "טלפון"
    kind = EvidenceKind.IDENTITY
    method = Method.VENDOR
    availability = Availability.NOW
    max_proof_level = ProofLevel.DOCUMENTED
    scope_he = "מספר הטלפון שלך, כדי לוודא שהוא שלך. נשמרות רק 4 הספרות האחרונות. לא ניגש לאנשי הקשר."
    fields = ("phone_verified",)

    def not_ready_reason(self) -> str | None:
        return sms.not_ready_reason()

    def note(self) -> str | None:
        if sms.is_console():
            return "מצב פיתוח: לא נשלח SMS, הקוד מוצג על המסך (TP_SMS_PROVIDER=console)"
        return None

    def start(self, person_id: str, params: dict[str, Any]) -> StartResult:
        phone = sms.normalize_il_mobile(params.get("phone", ""))
        if not phone:
            raise ConnectorError("צריך מספר נייד ישראלי (05X-XXXXXXX)")

        now = time.time()
        recent = [t for t in _sends.get(person_id, []) if now - t < 3600]
        if recent and now - recent[-1] < RESEND_COOLDOWN:
            raise ConnectorError(f"אפשר לשלוח קוד חדש בעוד {int(RESEND_COOLDOWN - (now - recent[-1]))} שניות")
        if len(recent) >= MAX_SENDS_PER_HOUR:
            raise ConnectorError("יותר מדי ניסיונות. נסו שוב בעוד שעה")

        # Internal pre-check only: never stored, never shown
        info = phone_line.line_info(phone)
        if info and info["type"] not in ("mobile", "unknown"):
            raise ConnectorError("אפשר לשלוח קוד רק למספר נייד")

        code = f"{secrets.randbelow(10**6):06d}"
        if not sms.is_console():
            try:
                sms.send(phone, _message(code))
            except sms.SmsError as e:
                raise ConnectorError(f"שליחת ה-SMS נכשלה: {e}") from e

        _sends[person_id] = [*recent, now]
        _pending[person_id] = {"phone": phone, "code_hash": _h(code), "expires": now + CODE_TTL, "attempts": 0}
        data = {"sent_to": "•" * 6 + phone[-4:]}
        if sms.is_console():
            data["dev_code"] = code
        return StartResult(kind="otp_sent", data=data)

    def complete(self, person_id: str, payload: dict[str, Any]) -> list[EvidenceDraft]:
        p = _pending.get(person_id)
        if not p or time.time() > p["expires"]:
            _pending.pop(person_id, None)
            raise ConnectorError("הקוד פג. שלחו קוד חדש")
        if _h(str(payload.get("code", "")).strip()) != p["code_hash"]:
            p["attempts"] += 1
            if p["attempts"] >= MAX_ATTEMPTS:
                _pending.pop(person_id, None)
                raise ConnectorError("יותר מדי ניסיונות שגויים. שלחו קוד חדש")
            raise ConnectorError("קוד שגוי")
        _pending.pop(person_id, None)
        phone = p["phone"]
        return [
            EvidenceDraft(
                field="phone_verified",
                value={"phone_hash": _h(phone), "last4": phone[-4:]},
                display=f"טלפון מאומת (מסתיים ב-{phone[-4:]})",
                proof_level=ProofLevel.DOCUMENTED,
            )
        ]
