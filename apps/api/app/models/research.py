"""Website research: one audit + keyword study per (user, domain), shared by every lead on that domain."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, IdMixin, TimestampMixin


class SiteResearch(IdMixin, TimestampMixin, Base):
    __tablename__ = "site_research"
    __table_args__ = (UniqueConstraint("user_id", "domain"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    domain: Mapped[str] = mapped_column(String(255))  # normalized host without "www."
    url: Mapped[str] = mapped_column(String(500))  # what was audited (homepage)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)  # queued|running|done|failed|cancelled
    # {pagespeed: bool, location_code: int, language_code: str}
    options: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(Text)

    final_url: Mapped[str | None] = mapped_column(String(1000))
    score: Mapped[int | None] = mapped_column(Integer)  # 0–100, 100 = nothing wrong
    # [{code, severity: high|medium|low, title, detail, category}]
    issues: Mapped[list] = mapped_column(JSONB, default=list)
    # raw findings: title, meta_description, h1s, load_ms, pagespeed, broken_links, …
    facts: Mapped[dict] = mapped_column(JSONB, default=dict)
    summary: Mapped[str] = mapped_column(Text, default="")  # what the business sells (AI)
    # [{keyword, set: smart|basic, volume, competition, competition_index, low_bid, high_bid, cpc, currency, monthly}]
    keywords: Mapped[list] = mapped_column(JSONB, default=list)
    keyword_source: Mapped[str] = mapped_column(String(20), default="")  # "ai+heuristic" | "heuristic" | "ai" (older rows)
    metrics_source: Mapped[str] = mapped_column(String(20), default="")  # google_ads | dataforseo | ""
    metrics_error: Mapped[str | None] = mapped_column(Text)
    # Numbers sequence conditions branch on — see app.services.research.METRICS.
    metrics: Mapped[dict] = mapped_column(JSONB, default=dict)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    researched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
