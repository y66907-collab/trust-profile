"""Data model.

Principles baked into the schema:
- Everything belongs to a Person. The person owns their profile.
- Every fact is an Evidence row with a proof_level (1-4) and a source.
- Nothing is shown to anyone except through a ShareLink the person created.
- Every read through a share link is logged (ShareView). Every write is audited.
- Evidence expires (retention) and can be revoked per source.
"""

import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(UTC)


class ProofLevel(enum.IntEnum):
    CLAIMED = 1        # the person typed it
    DOCUMENTED = 2     # backed by a document / account
    THIRD_PARTY = 3    # confirmed by a referee / employer / platform
    AUTHORITATIVE = 4  # official source or registered owner (Tabu)


class EvidenceKind(str, enum.Enum):
    IDENTITY = "identity"
    WORK = "work"
    HOME = "home"
    REFERENCE = "reference"
    REPUTATION = "reputation"
    PRESENCE = "presence"


class Person(Base):
    __tablename__ = "persons"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    display_name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    evidence: Mapped[list["Evidence"]] = relationship(back_populates="person", cascade="all, delete-orphan")
    consents: Mapped[list["Consent"]] = relationship(back_populates="person", cascade="all, delete-orphan")


class Consent(Base):
    """One row per source the person connected. Revoking a consent revokes its evidence."""

    __tablename__ = "consents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    person_id: Mapped[str] = mapped_column(ForeignKey("persons.id", ondelete="CASCADE"), index=True)
    source_key: Mapped[str] = mapped_column(String(64))
    scope: Mapped[str] = mapped_column(Text)  # human-readable: what we told them we collect
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    person: Mapped[Person] = relationship(back_populates="consents")


class Evidence(Base):
    __tablename__ = "evidence"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    person_id: Mapped[str] = mapped_column(ForeignKey("persons.id", ondelete="CASCADE"), index=True)
    source_key: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    field: Mapped[str] = mapped_column(String(64))
    value: Mapped[dict] = mapped_column(JSON)       # structured value (internal)
    display: Mapped[str] = mapped_column(Text)      # what a viewer sees, already minimised
    proof_level: Mapped[int] = mapped_column(Integer)
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)

    person: Mapped[Person] = relationship(back_populates="evidence")


class RefereeRequest(Base):
    """A referee (previous landlord, employer, roommate) confirms by clicking a link.
    They never register. We store only a hash of their phone/email."""

    __tablename__ = "referee_requests"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    person_id: Mapped[str] = mapped_column(ForeignKey("persons.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(32))  # landlord / employer / roommate / client
    referee_name: Mapped[str] = mapped_column(String(200))
    contact_hash: Mapped[str] = mapped_column(String(64))
    context: Mapped[dict] = mapped_column(JSON, default=dict)  # e.g. address city, period
    token: Mapped[str] = mapped_column(String(64), unique=True, default=_uuid)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending/answered/declined
    answers: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ShareLink(Base):
    __tablename__ = "share_links"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    person_id: Mapped[str] = mapped_column(ForeignKey("persons.id", ondelete="CASCADE"), index=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, default=_uuid)
    context: Mapped[str] = mapped_column(String(32))          # rental / hiring / pro / tickets
    included_kinds: Mapped[list] = mapped_column(JSON)         # which EvidenceKinds are visible
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    one_time: Mapped[bool] = mapped_column(Boolean, default=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ShareView(Base):
    __tablename__ = "share_views"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    share_id: Mapped[str] = mapped_column(ForeignKey("share_links.id", ondelete="CASCADE"), index=True)
    viewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    person_id: Mapped[str] = mapped_column(String(32), index=True)
    action: Mapped[str] = mapped_column(String(64))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
