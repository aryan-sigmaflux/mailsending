# Sigmaflux Mailing Platform — Project Spec

> Status: **Draft v0.2** (2026-11-16). Core scope decided; see §7 Decisions Log and §8 Deferred.

A multi-tenant cold-email / outreach platform. Admins provision users with quotas; users connect mailboxes and domains, warm them up, verify leads, build templates and visual sequences, run campaigns, and source leads from Apollo with AI assistance.

---

## 1. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js** (App Router, TypeScript) | Tailwind + shadcn/ui; **React Flow (@xyflow/react)** for the workflow builder |
| Backend API | **FastAPI** (Python 3.12) | SQLAlchemy 2.0 + Alembic, Pydantic v2 |
| Database | **PostgreSQL 16** | Tenant isolation via `tenant_id` on every row (+ optional Row-Level Security) |
| Queue / workers | **Redis + Celery** (or ARQ) | Sending, warmup, IMAP polling, verification, Apollo sync |
| Scheduler | Celery Beat | Warmup ticks, campaign send windows, DNS re-checks |
| Secrets | AES-GCM encryption at rest | SMTP passwords, OAuth tokens, Apollo/AI keys never stored in plaintext |
| Mail libs | `aiosmtplib`, `aioimaplib`, `dnspython`, Gmail API, Microsoft Graph | |

```
Next.js (web)  ──►  FastAPI (REST + auth)  ──►  PostgreSQL
                         │
                         ▼
                    Redis queue ──► Workers: sender · warmup · imap-poller · verifier · apollo-sync · ai
                                         │
                         SMTP / Gmail API / MS Graph / IMAP / DNS / Apollo / AI providers
```

---

## 2. Roles & Multi-Tenancy

| Role | Can do |
|---|---|
| **Super Admin** | Create/suspend users (tenants), set plans & limits, view global usage, manage warmup pool, view system health |
| **User** | Everything inside their own workspace |

**Tenancy model (decided):** one admin-created user = one tenant. No team members / sub-users. Limits apply per user.

### Admin-controlled limits (per user)
- Max emails / day and / month (global across all their mailboxes)
- Max connected **domains**
- Max connected **mailboxes**
- Max active **campaigns**
- Max **contacts** stored
- Email **verification credits** / month
- Feature flags: warmup, Apollo, AI, visual sequences, custom tracking domain
- Account status: active / suspended / expiry date

Limits are enforced server-side at action time (connect mailbox, add domain, enqueue send, verify).

---

## 3. Modules

### 3.1 Mailbox Connections
Providers:
- **Google Workspace / Gmail** — OAuth2; send via Gmail API (or SMTP XOAUTH2), read via Gmail API/IMAP
- **Microsoft 365 / Outlook** — OAuth2; send/read via Microsoft Graph
- **Custom SMTP + IMAP** — host/port/TLS/username/password; connection test on save

Per-mailbox settings: daily send limit, min/max delay between sends, sending window, signature, display name, reply-to, warmup on/off, status (healthy / auth error / paused).

### 3.2 Domains & Domain Checker
- Add domain → verify ownership (TXT record)
- Health checks: **SPF, DKIM, DMARC, MX**, BIMI (optional), reverse DNS, domain age
- **Blacklist check** against common DNSBLs (Spamhaus, Barracuda, SORBS, etc.)
- Custom **tracking domain** (CNAME) for open/click tracking
- Scheduled re-checks + alerts when something breaks
- Health score per domain

### 3.3 Warmup (IMAP-based)
- Opt-in mailboxes join a **warmup pool**; pool mailboxes send short, natural emails to each other
- Warmup worker logs into recipients via **IMAP** and: finds warmup mails (tagged via header/keyword), **moves from Spam → Inbox**, marks read / important, sometimes replies
- Configurable ramp-up: start volume, daily increase, max warmup/day, reply rate
- Warmup emails auto-filtered so they never pollute the user's real inbox/reporting
- Metrics: inbox vs spam placement %, warmup sent/received per day
- **Pool scope (decided): one shared global pool across all tenants.** Super admin can view/remove mailboxes from the pool (e.g. bad reputation). Warmup content is generic and never exposes one tenant's data to another.

### 3.4 Email Verifier (mail-ID checker)
Pipeline per address:
1. Syntax validation
2. Domain exists + **MX lookup**
3. Disposable domain detection
4. Role account detection (info@, sales@ …)
5. **SMTP handshake** (`EHLO → MAIL FROM → RCPT TO`, no DATA) to confirm mailbox exists
6. **Catch-all** detection (probe a random address on the domain)

Result: `valid` / `invalid` / `catch-all` / `risky` / `unknown`.
Single check + bulk CSV / list verification; uses verification credits.

> ⚠️ Infra note: SMTP verification requires **outbound port 25**, which most clouds (AWS, GCP, Azure, many VPS) block by default. Needs a dedicated verifier server/IP with port 25 open and clean reputation, or a fallback to a third-party verification API.

### 3.5 Contacts / Leads
- Lists, tags, custom fields, CSV import with column mapping
- Dedupe by email per tenant
- Verification status shown per contact
- Global **suppression list** (unsubscribed, bounced, complained) per tenant

### 3.6 Templates
Users create, edit, duplicate and delete templates (subject + body). Templates are reusable across campaigns and sequences.

#### Editor
- **Rich text editor** (Gmail-like: bold, italic, links, lists, inline images) with a plain-text toggle (e.g. TipTap)
- **Button block**: styled call-to-action button (label, URL, colour), rendered as email-safe HTML
- **Live preview** rendered against a real lead from a chosen list, so the user sees variables filled in
- **Spintax** `{Hi|Hello|Hey}` for variation
- Signature insertion, unsubscribe link
- AI assist: generate / rewrite / shorten (uses user's AI key)

#### Variables
- Syntax: `{{Name}}`, `{{Company}}`, `{{Title}}`, … usable in **subject and body**
- Variable sources:
  - **Uploaded CSV**: every column header becomes a variable (e.g. column `Name` → `{{Name}}`)
  - **Apollo-enriched leads**: standard Apollo fields mapped to variables (first name, last name, title, company, industry, city, LinkedIn URL, company website, headcount…)
  - Custom fields added manually on contacts
- Variable picker in the editor lists all variables available across the user's lists
- Fallback syntax: `{{Name|there}}` → uses "there" when the value is empty
- **Missing-variable check** at campaign launch: warns which leads are missing values used in the chosen templates (skip lead / use fallback / block launch)

#### Research variables (Google search + AI context)
A template can contain a research block that runs a **web search per lead** and inserts AI-written context.
- Syntax (example): `{{research: "recent news about {{Company}} in {{City}}" | instruction: "write one opening line referencing it"}}`
- **No separate search API.** Research uses the AI model's **built-in web search / grounding** through the user's own AI key:
  - Gemini → Google Search grounding
  - OpenAI → web search tool
  - Anthropic → web search tool
  - OpenRouter → web-search-enabled models / web plugin
- Per lead: the prompt is built from lead variables + the block's instruction → the model searches the web itself → its answer (with sources) is inserted into the email
- The user picks a "research model" in AI settings; the UI blocks research blocks if that model has no web search capability
- **Pre-generate + review flow (decided):** before a campaign launches, research runs for every lead in the background. The user then sees a review table (lead → generated line → sources) where they can **edit, regenerate, or approve** each line. Bulk "approve all" is available. Only approved lines are sent
- Results cached per lead + block so retries and follow-ups don't re-spend
- If the search finds nothing useful, the block's fallback text is used
- Generated lines are stored on the message so the user can see exactly what was sent

#### Tracking (links & buttons)
- **Open tracking**: invisible pixel, toggle per template
- **Click tracking**: every link and button is rewritten to go through the user's **custom tracking domain** (redirect logs the click, then forwards to the real URL)
- Per-link toggle to exclude a link from tracking
- Reports show clicks per link/button, per template, per campaign

### 3.7 Sequences — Visual Workflow Builder
Built with React Flow. Stored as a graph (nodes + edges JSON) and executed by a state machine per contact.

| Node | Purpose |
|---|---|
| **Start** | Entry point; defines trigger (contact added to campaign) |
| **Send Mail** | Select **one or more templates**. If several are selected, one is picked at **random with an even split** for each lead. The chosen template is recorded so analytics show performance per template. Option: "reply in same thread" as the previous email |
| **Wait** | Inputs for **days, hours, minutes**, plus a **"Working days only"** checkbox. Non-working days are skipped when counting, and sending moves to the next working day. Working days are set **per campaign** (default Mon–Fri, editable, e.g. Mon–Sat) in the **campaign's time zone** |
| **Action (Condition branch)** | Checks if the contact **opened / clicked / replied** to a previous step (optionally within N days) and routes them down a **Yes** or **No** edge |

Execution rules: stop on reply (default), stop on bounce/unsubscribe, respect mailbox limits & send windows.

### 3.8 Campaigns
- **Campaign type**, one of:
  - **Single template**: one-off send of one template (or several picked at random) to the list
  - **Sequence**: runs a visual workflow (3.7) per lead
- Choose **lead list(s)** and **sending mailboxes** (rotation across multiple inboxes)
- Schedule: start date, **working days** (default Mon–Fri, editable), daily time window, campaign time zone
- If templates use research blocks: a **"Research review"** step runs before launch (see 3.6)
- Throttling: per-mailbox limits + campaign daily cap + random delays
- Tracking: opens (pixel), clicks (redirect via tracking domain), replies (IMAP/API polling), bounces
- Compliance: `List-Unsubscribe` + one-click unsubscribe header (Gmail/Yahoo bulk-sender rules)
- States: draft → scheduled → running → paused → completed
- Analytics: sent, delivered, opened, clicked, replied, bounced, unsubscribed — per step and per mailbox

### 3.9 Apollo Integration (tab)
Connect via **Apollo API key** or **Apollo MCP server**. Uses the user's own AI key (3.10). Two modes:

#### Mode A — Agentic chat (turn-based)
1. User types a natural-language query, e.g. *"manufacturers in India with more than 30 employees"*
2. AI agent converts it into a structured Apollo search request (industry, location, headcount, titles…) and shows the filters it chose
3. Agent runs a preview/count and shows an **estimated credit cost**
4. **User approves** (or edits the request / sets a max lead count) before any credits are spent
5. Leads are fetched and **enriched**, then saved to a lead list
6. Multi-turn: user can refine ("only Pune", "add CTOs too") and the agent updates the request

#### Mode B — Document upload → companies → people
1. User uploads a document: **PDF (incl. scanned), JPG/PNG images, Excel/CSV** (e.g. trade-fair exhibitor list, directory, brochure). Spreadsheets are parsed directly (user picks the company column); PDFs/images go through OCR + AI
2. **OCR + AI extraction** pulls out company names (plus website/location if present)
3. User reviews/edits the extracted company list
4. User picks **who to target** at each company: CEO, Founders, HR, specific departments/titles, or general employees
5. Credit estimate → **user approves** → Apollo matches companies, finds people by role, enriches them
6. Results saved to a lead list

Common to both:
- Credit approval gate before every spend; spend history logged per user
- Credits are the user's **own Apollo account**; no admin-side cap on Apollo usage
- Results go through the **email verifier** (optional toggle) before joining a list
- Dedupe against existing contacts and suppression list

### 3.10 AI (Bring-Your-Own-Key)
- User adds their own key. Supported providers: **OpenAI, Anthropic, Google Gemini, OpenRouter**, plus **any OpenAI-compatible custom endpoint** (base URL + key + model name)
- Provider abstraction layer in the backend so every feature (chat agent, OCR/extraction, writing) works with any provider; user picks a default model per feature
- OCR/document extraction needs a vision/PDF-capable model; the UI warns if the selected model lacks it
- Uses: write templates & sequences, personalize first lines per lead, classify replies (interested / not interested / OOO), drive Apollo lead search
- Keys encrypted; usage logged per tenant

### 3.11 Unified Inbox (basic)
- One inbox showing campaign replies from all connected mailboxes
- Read and **reply in thread** from the platform (sent through the original mailbox)
- Filter by mailbox / campaign; mark read/unread
- Warmup emails hidden
- No AI categorization in v1

---

## 4. Core Data Model (initial sketch)

```
users            (id, email, password_hash, role, status, expires_at)
tenants          (id, owner_user_id, name, plan_id)
tenant_limits    (tenant_id, max_daily_emails, max_monthly_emails, max_domains,
                  max_mailboxes, max_campaigns, max_contacts, verify_credits, feature_flags jsonb)
domains          (id, tenant_id, name, verified, spf, dkim, dmarc, mx, blacklist jsonb, health_score, checked_at)
mailboxes        (id, tenant_id, domain_id, provider, email, smtp_cfg_enc, imap_cfg_enc,
                  oauth_tokens_enc, daily_limit, send_window, warmup_enabled, status)
warmup_settings  (mailbox_id, start_volume, ramp_per_day, max_per_day, reply_rate)
warmup_events    (id, mailbox_id, peer_mailbox_id, type, placement, created_at)
contacts         (id, tenant_id, email, first_name, last_name, company, custom jsonb, verify_status)
lists / list_contacts
suppressions     (tenant_id, email, reason)
templates        (id, tenant_id, name, subject, body_html, body_text, variables[],
                  track_opens, track_clicks, research_blocks jsonb)
template_links   (id, template_id, url, label, is_button, tracked)
research_cache   (id, tenant_id, campaign_id, contact_id, block_hash, prompt, sources jsonb,
                  output_text, status[pending|generated|edited|approved|failed], created_at)
sequences        (id, tenant_id, name, graph jsonb, version)
campaigns        (id, tenant_id, sequence_id, status, schedule jsonb, settings jsonb)
campaign_mailboxes / campaign_contacts (state, current_node_id, next_run_at)
messages         (id, tenant_id, campaign_id, contact_id, mailbox_id, node_id, template_id,
                  rendered_subject, rendered_body, message_id_header, thread_id, status, sent_at)
link_clicks      (id, message_id, template_link_id, clicked_at, ip, user_agent)
events           (id, message_id, type[open|click|reply|bounce|unsub], meta jsonb, at)
verifications    (id, tenant_id, email, result, reason, checked_at)
integrations     (id, tenant_id, type[apollo|openai|anthropic|...], mode[api|mcp], secret_enc, config jsonb)
usage_counters   (tenant_id, date, emails_sent, verifications, ai_tokens)
audit_log        (id, actor_id, tenant_id, action, payload, at)
```

---

## 5. Proposed Repo Layout

```
/apps
  /web          Next.js frontend
  /api          FastAPI app (routers, schemas, services, models)
  /workers      Celery workers (sender, warmup, imap, verifier, apollo, ai)
/packages
  /shared       Shared types / OpenAPI-generated TS client
/infra          docker-compose (postgres, redis, api, web, workers), env templates
PROJECT.md
```

---

## 6. Build Phases (proposal)

1. **Foundation** — auth, super admin, tenants, limits, base UI shell
2. **Mailboxes & Domains** — SMTP/IMAP, Google, Microsoft connect; domain checker
3. **Contacts, Templates, Email Verifier**
4. **Sequences builder + Campaign engine** — sending, tracking, reply detection
5. **Warmup** — pool, IMAP actions, ramp-up, placement metrics
6. **Apollo + AI** integrations
7. Analytics, unified inbox, hardening, deployment

---

## 7. Open Questions

## 7. Decisions Log

| Topic | Decision |
|---|---|
| Apollo + AI | Two modes: agentic chat and document upload with OCR (3.9) |
| Tenancy | Single user per tenant, no team members |
| Warmup pool | Shared global pool |
| Action node | Condition branch (opened / clicked / replied) |
| AI providers | OpenAI, Anthropic, Gemini, OpenRouter, any OpenAI-compatible endpoint |
| Unified inbox | Yes, basic (read + reply, no AI tagging) |
| Billing | Admin-managed only, no payments in the app |
| Hosting | VPS (Hetzner/OVH etc.) via Docker Compose; port 25 unblocked for the verifier |
| Apollo credits | User's own Apollo account; approval per spend, no admin cap |
| Doc upload types | PDF, JPG/PNG, Excel/CSV |
| Template editor | Rich text (Gmail-like) + plain-text toggle |
| v1 extras | Open/click tracking with custom tracking domain |
| Template variables | `{{Var}}` from CSV columns, Apollo fields and custom fields, with fallbacks |
| Research variables | Per-lead research via the AI model's built-in web search (no separate search API); pre-generated and reviewed before launch |
| Campaign types | Single template **or** sequence |
| Send Mail node | Multi-template select, even random split per lead |
| Wait node | Days / hours / minutes + "working days only" checkbox; working days configurable per campaign (default Mon–Fri), campaign time zone |
| Template tracking | Link and button click tracking, open pixel, per-link opt-out |

## 8. Deferred (post-v1)
- A/B testing of subject/body variants
- 2FA (TOTP) login
- Public API keys / outbound webhooks (e.g. push to Sigmaflux CRM)
- AI reply categorization in the unified inbox
- Team members per tenant
- Self-serve billing (Stripe)

## 9. Build Status (2026-11-16)

| Module | Status | Notes |
|---|---|---|
| Auth, super admin, user limits & feature flags | ✅ Built | Limits enforced server-side (402 on quota) |
| Mailboxes — SMTP/IMAP | ✅ Built | Connection test on save, per-mailbox limits/delays/signature, send-test |
| Mailboxes — Google / Microsoft OAuth | ✅ Built, needs OAuth app creds | XOAUTH2 over SMTP/IMAP, token refresh |
| Domain checker | ✅ Built | MX, SPF, DKIM (common selectors), DMARC, DNSBL/DBL, ownership TXT, score |
| Email verifier | ✅ Built | Syntax → MX → disposable/role → SMTP RCPT → catch-all; needs port 25 in prod |
| Lead lists + CSV import | ✅ Built | Column mapping, custom columns → variables, dedupe, suppression |
| Templates | ✅ Built | Rich editor, `{{Var|fallback}}`, spintax, buttons, open/click tracking, live preview, AI assist |
| Sequence builder | ✅ Built | React Flow: Start / Send Mail (multi-template random) / Wait (d/h/m + working days) / Condition |
| Campaigns + engine | ✅ Built | Single or sequence, send windows, rotation, caps, threading, preflight & missing-variable policy |
| Tracking + unsubscribe | ✅ Built | Signed pixel/click/unsub links, RFC 8058 one-click, List-Unsubscribe headers |
| Reply & bounce detection | ✅ Built | IMAP poller matches In-Reply-To/References; stop-on-reply |
| Unified inbox (basic) | ✅ Built | Read replies, reply in thread |
| AI / Apollo key management | ✅ Built | BYOK, encrypted, connection test |
| Warmup engine | ⏳ Next | Settings + pool membership saved; sender + IMAP spam-rescue worker not built yet |
| Apollo agent (Mode A) & document → leads (Mode B) | ⏳ Next | UI shell in place |
| Research variables (AI web search) | ⏳ Next | Pre-generate + review flow per §3.6 |
| Scheduled domain re-checks / alerts | ⏳ Next | Manual re-check works today |
