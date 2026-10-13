"""What we never store, enforced in one place.

Every EvidenceDraft passes through here before it touches the DB.
If a connector (or a future AI document parser) returns a forbidden field, it is dropped.
"""

from app.connectors.base import Connector, EvidenceDraft

# Protected / sensitive attributes. Never stored, never shown, never used for anything.
FORBIDDEN_KEYS = frozenset(
    {
        "religion", "nationality", "ethnicity", "origin", "marital_status", "sexual_orientation",
        "gender_identity", "health", "disability", "political", "biometric", "selfie", "photo",
        "id_image", "id_number", "teudat_zehut", "bank_account", "card_number", "posts",
        "likes", "friends", "exact_salary", "street_address",
    }
)


def _clean(value: dict) -> dict:
    out = {}
    for k, v in value.items():
        if k.lower() in FORBIDDEN_KEYS:
            continue
        out[k] = _clean(v) if isinstance(v, dict) else v
    return out


def sanitize(connector: Connector, drafts: list[EvidenceDraft]) -> list[EvidenceDraft]:
    kept: list[EvidenceDraft] = []
    for d in drafts:
        if d.field not in connector.fields or d.field.lower() in FORBIDDEN_KEYS:
            continue
        d.proof_level = min(d.proof_level, connector.max_proof_level)
        d.value = _clean(d.value)
        kept.append(d)
    return kept
