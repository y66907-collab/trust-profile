"""Connector interface.

Every data source is a Connector. A connector:
1. declares what it collects (fields, kind, proof level, availability) -> shown to the user BEFORE consent
2. start(): begins the flow (OAuth redirect URL, OTP send, guided-download instructions, ...)
3. complete(): receives the result and returns a list of EvidenceDraft

Connectors never write to the DB. The service layer does, after sanitising.
That keeps the "what we store" rules in one place (sanitize.py).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from app.models import EvidenceKind, ProofLevel


class Method(str, Enum):
    OAUTH = "oauth"
    GUIDED = "guided"        # guided download: user logs in at the source, we receive the document
    VENDOR = "vendor"        # external vendor (e.g. ID + selfie)
    REFEREE = "referee"      # a third party confirms by clicking a link
    LINK = "link"            # public profile link + ownership proof
    INTERNAL = "internal"    # our own cross-check (e.g. Tabu)


class Availability(str, Enum):
    NOW = "now"
    PAID = "paid"
    FUTURE = "future"


@dataclass
class EvidenceDraft:
    field: str
    value: dict[str, Any]
    display: str
    proof_level: ProofLevel


@dataclass
class StartResult:
    """What the client needs to continue the flow."""

    kind: str                       # "redirect" | "otp_sent" | "instructions" | "none"
    data: dict[str, Any] = field(default_factory=dict)


class Connector(ABC):
    key: str
    title_he: str
    kind: EvidenceKind
    method: Method
    availability: Availability
    max_proof_level: ProofLevel
    # Plain-language scope shown to the user before they consent. Stored on the Consent row.
    scope_he: str
    # Fields this connector may produce. Anything else is dropped by the sanitiser.
    fields: tuple[str, ...]

    @abstractmethod
    def start(self, person_id: str, params: dict[str, Any]) -> StartResult: ...

    @abstractmethod
    def complete(self, person_id: str, payload: dict[str, Any]) -> list[EvidenceDraft]: ...

    def not_ready_reason(self) -> str | None:
        """Why this source can't be used right now (missing keys, parser not written), or None if it works."""
        return None

    def note(self) -> str | None:
        """Optional hint for the UI, e.g. an optional add-on that is switched off."""
        return None

    def describe(self) -> dict[str, Any]:
        reason = self.not_ready_reason()
        return {
            "ready": reason is None,
            "not_ready_reason": reason,
            "note": self.note(),
            "key": self.key,
            "title": self.title_he,
            "kind": self.kind.value,
            "method": self.method.value,
            "availability": self.availability.value,
            "max_proof_level": int(self.max_proof_level),
            "scope": self.scope_he,
            "fields": list(self.fields),
        }


class ConnectorError(Exception):
    pass
