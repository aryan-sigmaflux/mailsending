"""Campaigns, per-contact campaign state, sent messages and tracking events."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, IdMixin, TimestampMixin

DEFAULT_SCHEDULE = {"timezone": "UTC", "days": [0, 1, 2, 3, 4], "start": "09:00", "end": "17:00", "start_at": None}
DEFAULT_SETTINGS = {"daily_cap": 200, "stop_on_reply": True}

# Campaign-contact states that the engine still works on.
LIVE_STATES = ("pending", "active", "waiting")


class Campaign(IdMixin, TimestampMixin, Base):
    __tablename__ = "campaigns"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20), default="single")  # single | sequence
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft|running|paused|completed
    sequence_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sequences.id", ondelete="SET NULL"))
    template_ids: Mapped[list] = mapped_column(JSONB, default=list)  # single-template campaigns (random pick)
    list_ids: Mapped[list] = mapped_column(JSONB, default=list)
    mailbox_ids: Mapped[list] = mapped_column(JSONB, default=list)
    schedule: Mapped[dict] = mapped_column(JSONB, default=lambda: dict(DEFAULT_SCHEDULE))
    settings: Mapped[dict] = mapped_column(JSONB, default=lambda: dict(DEFAULT_SETTINGS))
    # Graph frozen at launch so later sequence edits don't affect in-flight contacts.
    graph_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CampaignContact(IdMixin, TimestampMixin, Base):
    __tablename__ = "campaign_contacts"
    __table_args__ = (UniqueConstraint("campaign_id", "contact_id"),)

    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    contact_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("contacts.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # pending | active | waiting | done | replied | bounced | unsubscribed | failed | stopped
    state: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    current_node: Mapped[str | None] = mapped_column(String(64))
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    mailbox_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("mailboxes.id", ondelete="SET NULL"))
    first_message_id: Mapped[str | None] = mapped_column(String(255))  # Message-ID header, for threading
    last_message_id: Mapped[str | None] = mapped_column(String(255))
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    steps_sent: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)


class Message(IdMixin, Base):
    __tablename__ = "messages"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    campaign_contact_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("campaign_contacts.id", ondelete="CASCADE"), index=True)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("contacts.id", ondelete="SET NULL"))
    mailbox_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("mailboxes.id", ondelete="SET NULL"), index=True)
    template_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("templates.id", ondelete="SET NULL"))
    node_id: Mapped[str | None] = mapped_column(String(64))
    to_email: Mapped[str] = mapped_column(String(320))
    subject: Mapped[str] = mapped_column(String(500), default="")
    body_html: Mapped[str] = mapped_column(Text, default="")
    message_id_header: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    in_reply_to: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="sent")  # sent | failed | bounced
    error: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    clicked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    open_count: Mapped[int] = mapped_column(Integer, default=0)
    click_count: Mapped[int] = mapped_column(Integer, default=0)
    # Inbound reply body (for the unified inbox)
    reply_snippet: Mapped[str | None] = mapped_column(Text)


class Event(IdMixin, Base):
    __tablename__ = "events"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("messages.id", ondelete="CASCADE"), index=True)
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("contacts.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(20), index=True)  # open | click | reply | bounce | unsubscribe
    url: Mapped[str | None] = mapped_column(Text)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
