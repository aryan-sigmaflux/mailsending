"""Users. One admin-created user = one tenant; every tenant table carries `user_id`."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, IdMixin, TimestampMixin

ROLE_SUPER_ADMIN = "super_admin"
ROLE_USER = "user"

DEFAULT_FEATURES = {
    "warmup": True,
    "sequences": True,
    "apollo": True,
    "ai": True,
    "tracking_domain": True,
}


class User(IdMixin, TimestampMixin, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    full_name: Mapped[str] = mapped_column(String(200), default="")
    role: Mapped[str] = mapped_column(String(20), default=ROLE_USER)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | suspended
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")

    # ── Limits set by the super admin ───────────────
    max_daily_emails: Mapped[int] = mapped_column(Integer, default=500)
    max_monthly_emails: Mapped[int] = mapped_column(Integer, default=10000)
    max_domains: Mapped[int] = mapped_column(Integer, default=3)
    max_mailboxes: Mapped[int] = mapped_column(Integer, default=10)
    max_campaigns: Mapped[int] = mapped_column(Integer, default=10)
    max_contacts: Mapped[int] = mapped_column(Integer, default=10000)
    verify_credits_monthly: Mapped[int] = mapped_column(Integer, default=1000)
    features: Mapped[dict] = mapped_column(JSONB, default=lambda: dict(DEFAULT_FEATURES))

    # Custom tracking domain (CNAME → PUBLIC_API_URL host)
    tracking_domain: Mapped[str | None] = mapped_column(String(255))
    tracking_domain_verified: Mapped[bool] = mapped_column(Boolean, default=False)

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_SUPER_ADMIN
