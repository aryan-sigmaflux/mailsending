"""re-score historic opens/clicks: ignore scanners, Apple MPP and delivery-time prefetches

Mirrors app/services/engagement.py at the time of writing. Machine events are tagged with meta.machine and
messages' opened_at / clicked_at / counters are rebuilt from human events (plus replies, which imply an open).

Revision ID: a3c9e1f27b44
Revises: fd8d32c15051
Create Date: 2026-11-23 10:00:00
"""
from typing import Sequence, Union

from alembic import op

revision: str = "a3c9e1f27b44"
down_revision: Union[str, None] = "fd8d32c15051"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCANNERS = (
    "barracuda|proofpoint|mimecast|symantec|messagelabs|forcepoint|trendmicro|sophos|fortinet|ironport|cisco|zscaler|"
    "checkpoint|bitdefender|kaspersky|microsoft office existence|safelinks|bot|crawler|spider|preview|python|curl|wget|"
    "go-http-client|java/|okhttp|headless|phantomjs|axios|node-fetch|libwww|httpclient"
)


def upgrade() -> None:
    op.execute(f"""
        UPDATE events e SET meta = coalesce(e.meta, '{{}}'::jsonb) || jsonb_build_object('machine', r.reason)
        FROM (
            SELECT e2.id,
                CASE
                    WHEN coalesce(trim(e2.meta->>'ua'), '') = '' THEN 'no user agent'
                    WHEN lower(trim(e2.meta->>'ua')) = 'mozilla/5.0' THEN 'Apple Mail Privacy Protection'
                    WHEN lower(e2.meta->>'ua') ~ '({SCANNERS})' THEN 'security scanner / bot'
                    WHEN e2.created_at < m.sent_at + interval '60 seconds' THEN 'within 60s of sending'
                END AS reason
            FROM events e2 JOIN messages m ON m.id = e2.message_id
            WHERE e2.kind IN ('open', 'click') AND NOT (coalesce(e2.meta, '{{}}'::jsonb) ? 'machine')
        ) r
        WHERE e.id = r.id AND r.reason IS NOT NULL
    """)
    op.execute("""
        WITH human AS (
            SELECT message_id,
                   min(created_at) FILTER (WHERE kind = 'open') AS first_open,
                   min(created_at) FILTER (WHERE kind = 'click') AS first_click,
                   count(*) FILTER (WHERE kind = 'open') AS opens,
                   count(*) FILTER (WHERE kind = 'click') AS clicks
            FROM events
            WHERE kind IN ('open', 'click') AND message_id IS NOT NULL AND NOT (coalesce(meta, '{}'::jsonb) ? 'machine')
            GROUP BY message_id
        )
        UPDATE messages m SET
            opened_at = least(h.first_open, h.first_click, m.replied_at),
            clicked_at = h.first_click,
            open_count = coalesce(h.opens, 0),
            click_count = coalesce(h.clicks, 0)
        FROM messages m2 LEFT JOIN human h ON h.message_id = m2.id
        WHERE m.id = m2.id
    """)


def downgrade() -> None:
    # Classification is additive metadata; the previous (inflated) numbers aren't worth restoring.
    pass
