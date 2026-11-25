# Deploying to the VPS

Every push to `main` runs [.github/workflows/deploy.yml](../.github/workflows/deploy.yml). It SSHes to the server
(secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`), resets `/opt/sendharbor` to the pushed commit and runs:

```bash
docker compose -p sfmail -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build --remove-orphans
```

It can also be started by hand from the repo's **Actions** tab (Deploy to VPS → Run workflow).
`deploy/.env` lives only on the server and is never touched by the deploy.

> **One-time, before deploying the commit that adds `--appendonly yes` to Redis:** run this on the server first.
>
> ```bash
> docker exec sfmail-redis redis-cli config set appendonly yes
> ```
>
> Redis keeps stopped bulk verifications. If it is restarted with `--appendonly yes` before an append-only file
> exists, it starts **empty** and ignores its snapshot — the command above writes that file from the live data, so
> the restart keeps everything. Check with `docker exec sfmail-redis redis-cli info persistence | grep aof_enabled`
> (should print `aof_enabled:1`), then push.

## How traffic flows

```
https://sendharbor.sigmaflux.in ── aaPanel nginx (80/443, panel Let's Encrypt cert)
     /api/*, /health  → 127.0.0.1:8010  (sfmail-api)
     everything else  → 127.0.0.1:3010  (sfmail-web)
```

BillionMail already uses 25, 465, 587, 143, 993, 8080 and 41443. This stack only adds 3010 and 8010, bound to
127.0.0.1. Postgres and Redis have no host ports. Container, volume and network names all start with `sfmail`.
The proxy rules live in their own file in the site's aaPanel extension folder, so other sites are not touched.

## One-time setup (run on the server, one step at a time)

1. **Clone the repo.** Public repo:
   ```bash
   git clone https://github.com/aryan-sigmaflux/mailsending.git /opt/sendharbor
   ```
   Private repo: create a read-only deploy key first, add the printed public key under
   GitHub → repo → Settings → Deploy keys, then clone over SSH:
   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/sendharbor_deploy -C sendharbor-vps
   cat ~/.ssh/sendharbor_deploy.pub
   printf 'Host github.com\n  IdentityFile ~/.ssh/sendharbor_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
   git clone git@github.com:aryan-sigmaflux/mailsending.git /opt/sendharbor
   ```

2. **Create the env file from the template.**
   ```bash
   cd /opt/sendharbor && cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
   ```

3. **Generate secrets** and paste each into `deploy/.env` (`nano deploy/.env`), along with `SUPERADMIN_EMAIL`:
   ```bash
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
   echo "JWT_SECRET=$(openssl rand -hex 48)"
   echo "ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_')"
   echo "SUPERADMIN_PASSWORD=$(openssl rand -base64 18)"
   ```
   Back up `ENCRYPTION_KEY` somewhere safe: losing it makes stored mailbox passwords and tokens unreadable.

4. **Start the app.**
   ```bash
   docker compose -p sfmail -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
   ```
   Check: `curl -s http://127.0.0.1:8010/health`

5. **Add the proxy rules to the existing aaPanel site.** The panel site for `sendharbor.sigmaflux.in` already
   listens on 80/443 with a Let's Encrypt certificate, and includes every `*.conf` in its extension folder.
   ```bash
   cp /opt/sendharbor/deploy/nginx/sendharbor.conf /www/server/panel/vhost/nginx/extension/sendharbor.sigmaflux.in/sendharbor-app.conf
   nginx -t && nginx -s reload
   ```
   Don't add a reverse proxy for this site in the panel UI as well, or nginx reports a duplicate `location /`.

6. Open https://sendharbor.sigmaflux.in and log in with the super admin from `deploy/.env`.
   The certificate keeps renewing through the panel (the rules leave `/.well-known/acme-challenge/` to it).

From here on, pushes to `main` deploy automatically. The nginx file is not redeployed; if it ever changes in the repo,
copy it again (step 5).

If you use Google/Microsoft OAuth, register the redirect URIs
`https://sendharbor.sigmaflux.in/api/v1/mailboxes/oauth/google/callback` and `…/microsoft/callback`.

## Useful commands

```bash
cd /opt/sendharbor
docker compose -p sfmail -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
docker logs -f sfmail-api        # or sfmail-worker, sfmail-web
```

## Research leads: keyword data (Google Ads Keyword Planner)

Research leads runs in `sfmail-worker` (website audits, AI keywords, keyword metrics) — nothing extra to deploy; the
`alembic upgrade head` on API start adds the `site_research` table. Each user connects their own sources in
**Settings**: an AI provider (for the 5 keywords), **Keyword data**, and optionally **PageSpeed**.

### Option A — Google Ads API (Keyword Planner data, free)

Since Sept 2026 API access belongs to a **Google Cloud project** (developer tokens are ignored). Keyword Planner
needs **Basic** access — *Explorer* access blocks KeywordPlanIdeaService.

1. **Google Ads account** — any account you can sign in to (ads.google.com). Note its customer ID (top right,
   `123-456-7890`). If it sits under a manager (MCC) account, note that ID too.
2. **Cloud project** — console.cloud.google.com → create a project → *APIs & Services → Library* → enable
   **Google Ads API**. The project now has Test access.
3. **Brand verification** (required for Basic) — *APIs & Services → OAuth consent screen*:
   *Overview* → Get started → fill in app name / support email → Create; *Audience* → user type **External**,
   **Publish app** (status *In production*); *Branding* → fill the required fields → Save → **Verify branding**
   (takes a few minutes) → **Publish branding**.
4. **Apply for Basic** — open https://console.cloud.google.com/google/ads-apis/overview for the same project →
   *Upgrade access level* → Explorer first if asked, then **Basic** → *Apply for access*. Usually approved within minutes.
5. **Credentials — pick one:**
   - **Service account (recommended).** *IAM & Admin → Service accounts* → Create → open it → *Keys* → Add key →
     JSON (downloads a .json file). In Google Ads → *Admin → Access and security* → **+** → add the service
     account's email (`…@….iam.gserviceaccount.com`) with *Standard* access.
     In the platform: Settings → Keyword data → Google Ads → *Service account key* → upload the .json.
   - **OAuth refresh token.** *APIs & Services → Credentials* → Create credentials → OAuth client ID → type
     **Web application**, authorized redirect URI `https://developers.google.com/oauthplayground`. Then on
     https://developers.google.com/oauthplayground: gear icon → *Use your own OAuth credentials* → paste client ID
     and secret → in Step 1 enter scope `https://www.googleapis.com/auth/adwords` → *Authorize APIs* (sign in with a
     Google account that can open the Ads account) → Step 2 *Exchange authorization code for tokens* → copy the
     **refresh token**. In the platform choose *OAuth client + refresh token* and paste client ID, secret, token.
6. Enter the **customer ID** (and manager ID if any), pick the default location/language → **Connect & test**.
   The test looks up "running shoes" and stores the account's currency (bids are shown in it).

Common test errors: `invalid_grant: account not found` → wrong/deleted key; `PERMISSION_DENIED` /
`USER_PERMISSION_DENIED` → the service account or Google user hasn't been added to that Ads account (or the
manager ID is missing); `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` / `ACTION_NOT_PERMITTED` → the project doesn't
have Basic access yet.

### Option B — DataForSEO (same numbers, pay per lookup, no Google approval)

Sign up at dataforseo.com, copy the API login + password from *API access*, and paste them in Settings → Keyword data.

Volumes use the lead's country when it's known (else the default location chosen in Settings).
