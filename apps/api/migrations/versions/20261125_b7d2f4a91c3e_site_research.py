"""website research: site_research table + contacts.research_domain

Revision ID: b7d2f4a91c3e
Revises: a3c9e1f27b44
Create Date: 2026-11-25 10:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b7d2f4a91c3e"
down_revision: Union[str, None] = "a3c9e1f27b44"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "site_research",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("domain", sa.String(length=255), nullable=False),
        sa.Column("url", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("options", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("final_url", sa.String(length=1000), nullable=True),
        sa.Column("score", sa.Integer(), nullable=True),
        sa.Column("issues", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("facts", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("keywords", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("keyword_source", sa.String(length=20), nullable=False, server_default=""),
        sa.Column("metrics_source", sa.String(length=20), nullable=False, server_default=""),
        sa.Column("metrics_error", sa.Text(), nullable=True),
        sa.Column("metrics", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("researched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "domain"),
    )
    op.create_index(op.f("ix_site_research_user_id"), "site_research", ["user_id"], unique=False)
    op.create_index(op.f("ix_site_research_status"), "site_research", ["status"], unique=False)
    op.add_column("contacts", sa.Column("research_domain", sa.String(length=255), nullable=True))
    op.create_index("ix_contacts_user_research_domain", "contacts", ["user_id", "research_domain"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_contacts_user_research_domain", table_name="contacts")
    op.drop_column("contacts", "research_domain")
    op.drop_index(op.f("ix_site_research_status"), table_name="site_research")
    op.drop_index(op.f("ix_site_research_user_id"), table_name="site_research")
    op.drop_table("site_research")
