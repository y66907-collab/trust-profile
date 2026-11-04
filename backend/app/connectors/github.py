"""GitHub OAuth. Proves the person controls a GitHub account; we read account age and public activity.

Verification is server-side: `complete()` exchanges the OAuth `code` for a token and calls the API itself,
so a client cannot hand us a made-up profile. Scope is empty (public profile only, no repo or email access).
Needs TP_GITHUB_CLIENT_ID / TP_GITHUB_CLIENT_SECRET.
"""

import hmac
import json
import secrets
import urllib.parse
import urllib.request
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

AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"


def _state(person_id: str) -> str:
    """Signed state: binds the callback to the person who started the flow (CSRF protection)."""
    sig = hmac.new(settings.github_client_secret.encode(), person_id.encode(), "sha256").hexdigest()[:32]
    return f"{person_id}.{sig}"


def person_from_state(state: str) -> str:
    person_id, _, sig = state.partition(".")
    if not person_id or not hmac.compare_digest(_state(person_id), f"{person_id}.{sig}"):
        raise ConnectorError("bad state")
    return person_id


def _post_json(url: str, data: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode(data).encode(),
        headers={"Accept": "application/json", "User-Agent": "trust-profile/0.1"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def _get_json(url: str, token: str) -> dict[str, Any]:
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                      "User-Agent": "trust-profile/0.1"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


class GitHubConnector(Connector):
    key = "rep.github"
    title_he = "GitHub"
    kind = EvidenceKind.REPUTATION
    method = Method.OAUTH
    availability = Availability.NOW
    max_proof_level = ProofLevel.DOCUMENTED
    scope_he = "שם המשתמש, תאריך פתיחת החשבון ומספר הפרויקטים הציבוריים. לא ניגש לקוד, לריפוזיטוריז פרטיים או למייל."
    fields = ("github_account",)

    # Overridable for tests
    exchange_code = staticmethod(lambda code: _post_json(TOKEN_URL, {
        "client_id": settings.github_client_id, "client_secret": settings.github_client_secret, "code": code,
    }))
    fetch_user = staticmethod(lambda token: _get_json(USER_URL, token))

    def not_ready_reason(self) -> str | None:
        return None if settings.github_client_id else "חסר TP_GITHUB_CLIENT_ID ב-.env"

    def start(self, person_id: str, params: dict[str, Any]) -> StartResult:
        if not settings.github_client_id:
            raise ConnectorError("GitHub is not configured (TP_GITHUB_CLIENT_ID)")
        q = urllib.parse.urlencode({
            "client_id": settings.github_client_id,
            "redirect_uri": f"{settings.public_base_url}/oauth/github/callback",
            "scope": "",  # public profile only
            "state": _state(person_id),
            "allow_signup": "false",
        })
        return StartResult(kind="redirect", data={"url": f"{AUTHORIZE_URL}?{q}"})

    def complete(self, person_id: str, payload: dict[str, Any]) -> list[EvidenceDraft]:
        code = payload.get("code")
        if not code:
            raise ConnectorError("missing code")
        tok = self.exchange_code(code)
        token = tok.get("access_token")
        if not token:
            raise ConnectorError(f"github token exchange failed: {tok.get('error', 'no token')}")
        u = self.fetch_user(token)
        if not u.get("login") or not u.get("created_at"):
            raise ConnectorError("github user lookup failed")
        created = u["created_at"][:10]
        return [
            EvidenceDraft(
                field="github_account",
                value={
                    "login": u["login"],
                    "created_at": created,
                    "public_repos": u.get("public_repos", 0),
                    "followers": u.get("followers", 0),
                },
                display=f"GitHub: @{u['login']}, חשבון מאז {created[:4]}, {u.get('public_repos', 0)} פרויקטים ציבוריים",
                proof_level=ProofLevel.DOCUMENTED,
            )
        ]


def nonce() -> str:
    return secrets.token_urlsafe(16)
