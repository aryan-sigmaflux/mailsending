"""contact history + do-not-contact: suppressions.note, messages(user_id, to_email) index, mailboxes.warmup_started_at

Revision ID: c4e8a2d6f1b9
Revises: b7d2f4a91c3e
Create Date: 2026-11-27 10:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c4e8a2d6f1b9"
down_revision: Union[str, None] = "b7d2f4a91c3e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("suppressions", sa.Column("note", sa.Text(), nullable=False, server_default=""))
    op.create_index("ix_messages_user_to_email", "messages", ["user_id", "to_email"])
    op.add_column("mailboxes", sa.Column("warmup_started_at", sa.DateTime(timezone=True), nullable=True))
    # Mailboxes already warming start their schedule today.
    op.execute("UPDATE mailboxes SET warmup_started_at = now() WHERE warmup_enabled")


def downgrade() -> None:
    op.drop_column("mailboxes", "warmup_started_at")
    op.drop_index("ix_messages_user_to_email", table_name="messages")
    op.drop_column("suppressions", "note")
