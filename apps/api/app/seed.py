"""Create the first super admin: `python -m app.seed` (add `--reset` to reset an existing admin's password)."""

import asyncio
import sys

from sqlalchemy import select

from app.config import settings
from app.core.security import hash_password
from app.database import async_session
from app.models import User
from app.models.user import DEFAULT_FEATURES, ROLE_SUPER_ADMIN


async def main(reset: bool) -> None:
    email = settings.SUPERADMIN_EMAIL.lower()
    async with async_session() as db:
        user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user and not reset:
            print(f"Super admin exists: {email} (use --reset to reset its password)")
            return
        if user:
            user.role = ROLE_SUPER_ADMIN
            user.status = "active"
            user.password_hash = hash_password(settings.SUPERADMIN_PASSWORD)
            action = "reset"
        else:
            db.add(User(email=email, password_hash=hash_password(settings.SUPERADMIN_PASSWORD), full_name="Super Admin",
                        role=ROLE_SUPER_ADMIN, features=dict(DEFAULT_FEATURES), max_daily_emails=100000,
                        max_monthly_emails=1000000, max_domains=1000, max_mailboxes=1000, max_campaigns=1000,
                        max_contacts=1000000, verify_credits_monthly=100000))
            action = "created"
        await db.commit()
    print(f"Super admin {action}: {email}")


if __name__ == "__main__":
    asyncio.run(main("--reset" in sys.argv))
