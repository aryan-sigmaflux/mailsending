"""Templates and sequences (visual workflow graphs)."""

import uuid

from sqlalchemy import Boolean, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, IdMixin, TimestampMixin


class Template(IdMixin, TimestampMixin, Base):
    __tablename__ = "templates"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    subject: Mapped[str] = mapped_column(String(500), default="")
    body_html: Mapped[str] = mapped_column(Text, default="")
    track_opens: Mapped[bool] = mapped_column(Boolean, default=True)
    track_clicks: Mapped[bool] = mapped_column(Boolean, default=True)
    # Variable names used in subject/body (computed on save) — powers the missing-variable check.
    variables: Mapped[list] = mapped_column(JSONB, default=list)


class Sequence(IdMixin, TimestampMixin, Base):
    __tablename__ = "sequences"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    # {"nodes": [{id, type: start|wait|send|condition, position, data}], "edges": [{id, source, target, sourceHandle}]}
    graph: Mapped[dict] = mapped_column(JSONB, default=lambda: {"nodes": [], "edges": []})
