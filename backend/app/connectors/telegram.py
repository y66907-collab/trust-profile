"""Telegram Login Widget. Proves the person controls a Telegram account.

Telegram signs the login payload with HMAC-SHA256(key = SHA256(bot_token)); we verify that signature here,
so a client cannot fabricate an account. Nothing else is read: no chats, no contacts.
Needs TP_TELEGRAM_BOT_TOKEN / TP_TELEGRAM_BOT_USERNAME (and the widget domain set via @BotFather /setdomain).

Account age is estimated from the numeric user id (ids grow over time). It is an approximation, shown only
as "ותיק" / "חדש", never as a date.
"""

import hashlib
import hmac
import time
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

MAX_AGE_SECONDS = 10 * 60

# Rough public estimates of the first user id issued each year. Good enough for "old account / new account".
_ID_BY_YEAR = [
    (2013, 0), (2014, 20_000_000), (2015, 60_000_000), (2016, 150_000_000), (2017, 300_000_000),
    (2018, 500_000_000), (2019, 800_000_000), (2020, 1_100_000_000), (2021, 1_700_000_000),
    (2022, 5_000_000_000), (2023, 5_900_000_000), (2024, 6_800_000_000), (2025, 7_600_000_000),
]


def estimated_join_year(user_id: int) -> int:
    year = _ID_BY_YEAR[0][0]
    for y, first_id in _ID_BY_YEAR:
        if user_id >= first_id:
            year = y
    return year


def verify_login(data: dict[str, Any], bot_token: str, now: float | None = None) -> None:
    """Raise ConnectorError unless `data` carries a valid, fresh Telegram signature."""
    if not data.get("hash") or not data.get("id") or not data.get("auth_date"):
        raise ConnectorError("incomplete telegram login data")
    check = "\n".join(f"{k}={data[k]}" for k in sorted(data) if k != "hash" and data[k] is not None)
    secret = hashlib.sha256(bot_token.encode()).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, str(data["hash"])):
        raise ConnectorError("telegram signature mismatch")
    if (now or time.time()) - int(data["auth_date"]) > MAX_AGE_SECONDS:
        raise ConnectorError("telegram login expired")


class TelegramConnector(Connector):
    key = "soc.telegram"
    title_he = "Telegram"
    kind = EvidenceKind.PRESENCE
    method = Method.OAUTH
    availability = Availability.NOW
    max_proof_level = ProofLevel.DOCUMENTED
    scope_he = "שם המשתמש בטלגרם והאם החשבון ותיק. לא קוראים הודעות ולא אנשי קשר."
    fields = ("telegram_account",)

    def not_ready_reason(self) -> str | None:
        return None if settings.telegram_bot_token else "חסר TP_TELEGRAM_BOT_TOKEN ב-.env"

    def start(self, person_id: str, params: dict[str, Any]) -> StartResult:
        if not settings.telegram_bot_token:
            raise ConnectorError("Telegram is not configured (TP_TELEGRAM_BOT_TOKEN)")
        # The Login Widget runs in the browser; the client renders it with these values and posts the result.
        return StartResult(kind="widget", data={
            "bot_username": settings.telegram_bot_username,
            "callback_url": f"{settings.public_base_url}/oauth/telegram/callback",
        })

    def complete(self, person_id: str, payload: dict[str, Any]) -> list[EvidenceDraft]:
        verify_login(payload, settings.telegram_bot_token)
        user_id = int(payload["id"])
        year = estimated_join_year(user_id)
        username = payload.get("username")
        label = f"@{username}" if username else "חשבון מאומת"
        return [
            EvidenceDraft(
                field="telegram_account",
                value={"user_id": user_id, "username": username, "estimated_join_year": year},
                display=f"Telegram: {label}, חשבון ותיק (משוער משנת {year})",
                proof_level=ProofLevel.DOCUMENTED,
            )
        ]
