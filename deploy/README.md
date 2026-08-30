# Deploying snapping-turtle

Three services (PLAN.md §14): `caddy` (TLS, ACME, redirects, body limits), `app`
(Fastify), `postgres`. Postgres is on an internal-only network; the app runs as
the unprivileged `node` user with a read-only root filesystem, `no-new-privileges`
and all capabilities dropped.

## Production

```sh
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env          # PUBLIC_HOST, POSTGRES_PASSWORD, SESSION_SECRET at minimum
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps    # wait for app: healthy
```

Generate secrets rather than typing them: `openssl rand -base64 48` for
`SESSION_SECRET`, `openssl rand -hex 24` for `POSTGRES_PASSWORD`.

Caddy obtains and renews a Let's Encrypt certificate for `PUBLIC_HOST`; ports 80
and 443 must be reachable from the internet. Migrations run automatically when
the app starts. Create the first admin once:

```sh
docker compose -f deploy/docker-compose.yml run --rm app node dist/db/seed.js
```

then remove `ADMIN_BOOTSTRAP_*` from `deploy/.env`. Re-running the seed never
changes an existing user's password.

## Local / development without ACME

Set `PUBLIC_HOST=localhost` in `deploy/.env` and run the same `up` command.
Caddy treats `localhost` as an internal name and signs it with its own CA — no
Let's Encrypt traffic, no public ports required. The site is at
`https://localhost` (self-signed; `curl -k` or trust the CA below).

For any other non-public hostname (a LAN name, `shots.test`, …) add the local
override, which forces `tls internal`:

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up -d --build
```

To make browsers trust the internal CA, export its root and add it to your OS
trust store:

```sh
docker compose -f deploy/docker-compose.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
# macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain caddy-local-root.crt
```

`/healthz` is answered by Caddy with a 404 on purpose (PLAN.md §8: internal
only); the compose healthcheck calls the app container directly.

## Domain migration

Change `PUBLIC_HOST`, run `docker compose ... up -d`, rebuild the extension so its
baked-in default server matches (`pnpm --filter extension build`). Keep the old
name serving a `redir 308` block for one retention window (PLAN.md §15).

## Notes

- Caddy runs as root inside its container (needed to bind 80/443 in the stock
  image); the app and Postgres do not.
- Resource limits are set via `deploy.resources.limits`; adjust per host.
- Backups, Trivy image scanning and the separate least-privilege DB role for
  `audit_log` arrive with M5/M7.
