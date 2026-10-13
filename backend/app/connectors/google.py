"""Google sign-in (OpenID Connect). Skeleton: builds the redirect, expects the verified userinfo on complete.

TODO: exchange `code` for tokens and call the userinfo endpoint server-side.
Needs TP_GOOGLE_CLIENT_ID / TP_GOOGLE_CLIENT_SECRET.
"""

from typing import Any
from urllib.parse import urlencode

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


class GoogleConnector(Connector):
    key = "id.google"
    title_he = "Google"
    kind = EvidenceKind.IDENTITY
    method = Method.OAUTH
    availability = Availability.NOW
    max_proof_level = ProofLevel.DOCUMENTED
    scope_he = "שם, מייל ותמונה מחשבון Google. לא ניגש למיילים, לקבצים או ליומן."
    fields = ("google_account",)

    def start(self, person_id: str, params: dict[str, Any]) -> StartResult:
        q = urlencode(
            {
                "client_id": "TP_GOOGLE_CLIENT_ID",
                "redirect_uri": f"{settings.public_base_url}/oauth/google/callback",
                "response_type": "code",
                "scope": "openid email profile",
                "state": person_id,
            }
        )
        return StartResult(kind="redirect", data={"url": f"https://accounts.google.com/o/oauth2/v2/auth?{q}"})

    def complete(self, person_id: str, payload: dict[str, Any]) -> list[EvidenceDraft]:
        # Skeleton accepts already-verified userinfo. Replace with server-side token exchange.
        email = payload.get("email")
        if not email or not payload.get("email_verified"):
            raise ConnectorError("unverified google account")
        return [
            EvidenceDraft(
                field="google_account",
                value={"email": email, "name": payload.get("name")},
                display="חשבון Google מאומת",
                proof_level=ProofLevel.DOCUMENTED,
            )
        ]
