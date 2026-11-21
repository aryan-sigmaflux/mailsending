"""Domains and mailboxes."""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, IdMixin, TimestampMixin

DEFAULT_WARMUP = {"start_per_day": 4, "ramp_per_day": 2, "max_per_day": 40, "reply_rate": 30}


class Domain(IdMixin, TimestampMixin, Base):
    __tablename__ = "domains"
    __table_args__ = (UniqueConstraint("user_id", "name"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    verify_token: Mapped[str] = mapped_column(String(64))
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    health_score: Mapped[int | None] = mapped_column(Integer)
    last_check: Mapped[dict | None] = mapped_column(JSONB)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Mailbox(IdMixin, TimestampMixin, Base):
    __tablename__ = "mailboxes"
    __table_args__ = (UniqueConstraint("user_id", "email"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    domain_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("domains.id", ondelete="SET NULL"))
    provider: Mapped[str] = mapped_column(String(20))  # smtp | google | microsoft
    email: Mapped[str] = mapped_column(String(320))
    from_name: Mapped[str] = mapped_column(String(200), default="")
    signature_html: Mapped[str] = mapped_column(Text, default="")

    smtp_host: Mapped[str | None] = mapped_column(String(255))
    smtp_port: Mapped[int | None] = mapped_column(Integer)
    smtp_security: Mapped[str] = mapped_column(String(10), default="ssl")  # ssl | starttls | none
    smtp_username: Mapped[str | None] = mapped_column(String(320))
    imap_host: Mapped[str | None] = mapped_column(String(255))
    imap_port: Mapped[int | None] = mapped_column(Integer)
    imap_security: Mapped[str] = mapped_column(String(10), default="ssl")
    imap_username: Mapped[str | None] = mapped_column(String(320))
    # Encrypted JSON: smtp_password, imap_password, access_token, refresh_token, expires_at
    secrets_enc: Mapped[str | None] = mapped_column(Text)

    daily_limit: Mapped[int] = mapped_column(Integer, default=40)
    min_delay_seconds: Mapped[int] = mapped_column(Integer, default=90)
    max_delay_seconds: Mapped[int] = mapped_column(Integer, default=240)

    warmup_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    warmup: Mapped[dict] = mapped_column(JSONB, default=lambda: dict(DEFAULT_WARMUP))

    status: Mapped[str] = mapped_column(String(20), default="active")  # active | error | paused
    last_error: Mapped[str | None] = mapped_column(Text)
    health_score: Mapped[int] = mapped_column(Integer, default=100)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    imap_last_uid: Mapped[int] = mapped_column(Integer, default=0)
