"""Shared response schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class UserOut(ORM):
    id: uuid.UUID
    email: str
    full_name: str
    role: str
    status: str
    timezone: str
    expires_at: datetime | None
    last_login_at: datetime | None
    created_at: datetime
    max_daily_emails: int
    max_monthly_emails: int
    max_domains: int
    max_mailboxes: int
    max_campaigns: int
    max_contacts: int
    verify_credits_monthly: int
    features: dict
    tracking_domain: str | None


class Usage(BaseModel):
    emails_today: int
    emails_month: int
    verifications_month: int
    domains: int
    mailboxes: int
    active_campaigns: int
    contacts: int


class MeOut(BaseModel):
    user: UserOut
    usage: Usage


class Page(BaseModel):
    total: int
    items: list
