"""Lead lists, contacts and the suppression list."""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, Table, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, IdMixin, TimestampMixin

list_contacts = Table(
    "list_contacts",
    Base.metadata,
    Column("list_id", UUID(as_uuid=True), ForeignKey("contact_lists.id", ondelete="CASCADE"), primary_key=True),
    Column("contact_id", UUID(as_uuid=True), ForeignKey("contacts.id", ondelete="CASCADE"), primary_key=True, index=True),
)

# Standard contact columns, exposed to templates as variables (e.g. {{FirstName}} / {{first_name}}).
STANDARD_FIELDS = ["email", "first_name", "last_name", "company", "title", "phone", "website", "linkedin_url", "city", "country"]


class ContactList(IdMixin, TimestampMixin, Base):
    __tablename__ = "contact_lists"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(20), default="manual")  # csv | apollo | manual
    # Custom column names seen on import — become template variables.
    columns: Mapped[list] = mapped_column(JSONB, default=list)


class Contact(IdMixin, TimestampMixin, Base):
    __tablename__ = "contacts"
    __table_args__ = (UniqueConstraint("user_id", "email"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(320))
    first_name: Mapped[str] = mapped_column(String(120), default="")
    last_name: Mapped[str] = mapped_column(String(120), default="")
    company: Mapped[str] = mapped_column(String(200), default="")
    title: Mapped[str] = mapped_column(String(200), default="")
    phone: Mapped[str] = mapped_column(String(60), default="")
    website: Mapped[str] = mapped_column(String(255), default="")
    linkedin_url: Mapped[str] = mapped_column(String(255), default="")
    city: Mapped[str] = mapped_column(String(120), default="")
    country: Mapped[str] = mapped_column(String(120), default="")
    fields: Mapped[dict] = mapped_column(JSONB, default=dict)
    source: Mapped[str] = mapped_column(String(20), default="manual")

    verify_status: Mapped[str] = mapped_column(String(20), default="unknown")  # valid|invalid|catch_all|risky|unknown
    verify_reason: Mapped[str] = mapped_column(String(200), default="")
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    unsubscribed: Mapped[bool] = mapped_column(Boolean, default=False)


class Suppression(Base):
    __tablename__ = "suppressions"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), primary_key=True)
    reason: Mapped[str] = mapped_column(String(30))  # unsubscribed | bounced | complained | manual
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
