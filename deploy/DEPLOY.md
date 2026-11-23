# Deploying to the VPS

Every push to `main` runs [.github/workflows/deploy.yml](../.github/workflows/deploy.yml). It SSHes to the server
(secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`), resets `/opt/sendharbor` to the pushed commit and runs:

```bash
docker compose -p sfmail -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build --remove-orphans
```

It can also be started by hand from the repo's **Actions** tab (Deploy to VPS → Run workflow).
`deploy/.env` lives only on the server and is never touched by the deploy.

## How traffic flows

```
https://sendharbor.sigmaflux.in ── host nginx (80/443, certbot TLS)
     /api/*, /health  → 127.0.0.1:8010  (sfmail-api)
     everything else  → 127.0.0.1:3010  (sfmail-web)
```

BillionMail already uses 25, 465, 587, 143, 993, 8080 and 41443. This stack only adds 3010 and 8010, bound to
127.0.0.1. Postgres and Redis have no host ports. Container, volume and network names all start with `sfmail`.
The nginx site is a separate file, so other sites on the host nginx are not touched.

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

5. **Add the nginx site.**
   ```bash
   cp /opt/sendharbor/deploy/nginx/sendharbor.conf /etc/nginx/sites-available/sendharbor.conf
   ln -s /etc/nginx/sites-available/sendharbor.conf /etc/nginx/sites-enabled/sendharbor.conf
   nginx -t && systemctl reload nginx
   ```
   If `/etc/nginx/sites-available` doesn't exist, copy the file to `/etc/nginx/conf.d/sendharbor.conf` instead.

6. **Get the HTTPS certificate** (DNS A record `sendharbor.sigmaflux.in → 185.193.19.137` must already resolve).
   ```bash
   apt-get update && apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d sendharbor.sigmaflux.in --redirect
   ```
   Certbot adds the 443 block to the site file and sets up automatic renewal.

7. Open https://sendharbor.sigmaflux.in and log in with the super admin from `deploy/.env`.

From here on, pushes to `main` deploy automatically. The nginx file is not redeployed; if it ever changes in the repo,
copy it again (step 5) and re-run certbot (step 6).

If you use Google/Microsoft OAuth, register the redirect URIs
`https://sendharbor.sigmaflux.in/api/v1/mailboxes/oauth/google/callback` and `…/microsoft/callback`.

## Useful commands

```bash
cd /opt/sendharbor
docker compose -p sfmail -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
docker logs -f sfmail-api        # or sfmail-worker, sfmail-web
```
