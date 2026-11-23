# Deploying to the VPS

Every push to `main` runs [.github/workflows/deploy.yml](../.github/workflows/deploy.yml). It SSHes to the server
(secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`), resets `/opt/sendharbor` to the pushed commit and runs:

```bash
docker compose -p sfmail -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build --remove-orphans
```

It can also be started by hand from the repo's **Actions** tab (Deploy to VPS → Run workflow).
`deploy/.env` lives only on the server and is never touched by the deploy.

## Ports on this server

BillionMail already uses 25, 465, 587, 143, 993, 8080 and 41443. This stack uses:

| Port | What | Exposed |
|---|---|---|
| 3010 | web (Next.js) | `BIND_ADDR` (0.0.0.0 until HTTPS is on, then 127.0.0.1) |
| 8010 | API (FastAPI) | same |
| 80, 443 | Caddy (HTTPS proxy, optional `proxy` profile) | public |

Postgres and Redis have no host ports. Container, volume and network names all start with `sfmail`, so nothing
collides with BillionMail's containers.

## One-time setup (run on the server, one step at a time)

1. **Check Git and Docker Compose are installed.**
   ```bash
   git --version && docker compose version
   ```
   If `git` is missing: `apt-get update && apt-get install -y git`.

2. **Check 80/443 and 3010/8010 are free** (should print nothing).
   ```bash
   ss -tlnp | grep -E ':(80|443|3010|8010)\s'
   ```

3. **Clone the repo.** Public repo:
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

4. **Create the env file from the template.**
   ```bash
   cd /opt/sendharbor && cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
   ```

5. **Generate secrets** and paste each into `deploy/.env` (`nano deploy/.env`):
   ```bash
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
   echo "JWT_SECRET=$(openssl rand -hex 48)"
   echo "ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_')"
   echo "SUPERADMIN_PASSWORD=$(openssl rand -base64 18)"
   ```
   Also set `SUPERADMIN_EMAIL`, and replace `YOUR_SERVER_IP` with `185.193.19.137` for now.
   Back up `ENCRYPTION_KEY` somewhere safe: losing it makes stored mailbox passwords and tokens unreadable.

6. **First start.**
   ```bash
   docker compose -p sfmail -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
   ```
   The app is then on `http://185.193.19.137:3010` (API docs on `:8010/docs`).

From here on, pushes to `main` deploy automatically.

## Turning on HTTPS (once the domain is chosen)

1. Add DNS A records for `app.YOUR_DOMAIN` and `api.YOUR_DOMAIN` pointing at `185.193.19.137`.
2. In `deploy/.env`, uncomment and fill `COMPOSE_PROFILES=proxy`, `WEB_DOMAIN`, `API_DOMAIN`, `ACME_EMAIL`, and set:
   ```
   BIND_ADDR=127.0.0.1
   PUBLIC_API_URL=https://api.YOUR_DOMAIN
   WEB_URL=https://app.YOUR_DOMAIN
   CORS_ORIGINS=https://app.YOUR_DOMAIN
   ```
3. Re-run the start command from step 6. Caddy fetches the certificates on its own. The web image is rebuilt,
   since the API URL is baked into it at build time.
4. If you use Google/Microsoft OAuth, update the redirect URIs to `https://api.YOUR_DOMAIN/api/v1/mailboxes/oauth/...`.

## Useful commands

```bash
cd /opt/sendharbor
docker compose -p sfmail -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
docker logs -f sfmail-api        # or sfmail-worker, sfmail-web, sfmail-caddy
```
