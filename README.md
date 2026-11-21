# Sigmaflux Mail

Multi-tenant cold email platform: admin-managed users with limits, mailbox connections (Google / Microsoft / SMTP),
domain health checks, an email verifier, lead lists with CSV import, templates with variables + tracking, a visual
sequence builder, a campaign engine, reply detection and a unified inbox.

Spec & decisions: [PROJECT.md](PROJECT.md) · Design references: [design/](design/)

## Stack

| Part | Tech | Port |
|---|---|---|
| `apps/api` | FastAPI · SQLAlchemy 2 (async) · Alembic · Postgres | 8010 |
| `apps/api` worker | `python -m app.worker` — campaign engine + IMAP reply/bounce poller (Redis-locked) | — |
| `apps/web` | Next.js 16 · React 19 · TanStack Query · Zustand · React Flow · TipTap | 3010 |
| infra | `docker-compose.yml` — Postgres 16 (5440), Redis 7 (6390) | |

## Run locally

```bash
# 1. Infra
docker compose up -d

# 2. API
cd apps/api
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # macOS/Linux: .venv/bin/pip
cp .env.example .env                                # set JWT_SECRET, ENCRYPTION_KEY, SUPERADMIN_*
.venv/Scripts/alembic upgrade head
.venv/Scripts/python -m app.seed                    # creates the super admin from .env
.venv/Scripts/python -m uvicorn app.main:app --port 8010

# 3. Worker (separate terminal) — sends campaigns, detects replies/bounces
.venv/Scripts/python -m app.worker

# 4. Web (separate terminal)
cd apps/web
npm install
cp .env.example .env.local
npm run dev                                         # http://localhost:3010
```

API docs: http://localhost:8010/docs

> On Windows, run uvicorn **without** `--reload` (the reloader can orphan its worker and hold the port).

## Configuration notes

- **Google / Microsoft mailboxes** need OAuth apps. Set `GOOGLE_CLIENT_ID/SECRET` and `MICROSOFT_CLIENT_ID/SECRET`, and
  register the redirect URIs `{PUBLIC_API_URL}/api/v1/mailboxes/oauth/google/callback` and `…/microsoft/callback`.
  Until then, connect Gmail/Outlook via SMTP with an app password.
- **Email verifier** probes mail servers on **port 25**. Run the API/worker on a VPS where outbound 25 is open
  (Hetzner/OVH on request). Without it, SMTP-level checks return `unknown (smtp_unreachable)`; syntax/MX/disposable/role checks still work.
- **Tracking** links point at `PUBLIC_API_URL`. In production, CNAME a tracking subdomain to the API and set `PUBLIC_API_URL` to it.
- Secrets (SMTP passwords, OAuth tokens, AI/Apollo keys) are Fernet-encrypted with `ENCRYPTION_KEY` — back it up; losing it makes stored credentials unreadable.

## Layout

```
apps/api/app
  core/        security (JWT, bcrypt), crypto (Fernet), signed tracking tokens, deps
  models/      users, domains, mailboxes, contacts/lists, templates, sequences, campaigns, messages, events, …
  routers/     auth, admin, dashboard+inbox, domains, mailboxes(+OAuth), contacts/lists, templates, sequences,
               campaigns, verifier, integrations, tracking (open/click/unsubscribe)
  services/    dns_checker, verifier, renderer (variables/spintax/tracking), engine, transport (SMTP/IMAP/XOAUTH2),
               schedule (windows/working days), graph (sequence validation), limits, oauth, ai
  worker.py    background loop
apps/web/app
  login, (app)/dashboard, campaigns, sequences, templates, inbox, leads, lead-finder, verifier,
  mailboxes, domains, warmup, settings, admin
```
