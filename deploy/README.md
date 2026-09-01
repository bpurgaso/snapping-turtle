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

## Backups and restore

The `backup` service (`deploy/Dockerfile.backup`, `deploy/backup/backup.sh`)
runs nightly at `BACKUP_TIME_UTC` (default 03:30) and, every run:

1. `pg_dump -Fc` of the database into the `backups` volume
   (`/backups/db/snapping_turtle-<stamp>.dump`, custom format, ACLs kept so the
   `st_app` grants restore too) plus a `.counts` manifest of row counts;
2. a hardlinked `rsync` snapshot of the image volume
   (`/backups/images/<stamp>/` — unchanged files share inodes with the previous
   snapshot, so daily snapshots cost roughly one copy plus the day's uploads);
3. rotation: local dumps and snapshots older than `BACKUP_KEEP_DAYS` (14) go;
4. **off-box, when `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` are set:** a
   restic snapshot of the new dump, its manifest and the images, then
   `restic forget --prune` with `RESTIC_KEEP_DAILY/WEEKLY/MONTHLY` (14/8/6).
   Backend credentials (`AWS_*`, `B2_*`) pass through from `deploy/.env`.
   The repository is initialised on first use.

**Limitation when restic is not configured:** the `backups` volume lives on the
same disk as the data. That protects against a bad migration, an accidental
delete or a corrupt table — not against losing the host. Copy the volume
elsewhere (`docker run --rm -v snapping-turtle_backups:/b:ro -v $PWD:/out alpine tar czf /out/backups.tgz -C /b .`)
or, better, set `RESTIC_REPOSITORY`.

The sidecar runs as uid 1000 (the app's `node` user) with a read-only root, the
image volume mounted read-only, no capabilities, and reaches only the
`internal` network (Postgres) plus an `egress` network for the restic target.
It logs one `sec.backup.completed` line per run with sizes and counts, and
`sec.backup.failed` on error — never a connection string or repository URL.

Ad-hoc backup: `docker compose -f deploy/docker-compose.yml run --rm backup run`.

### Proving a backup restores

```sh
deploy/backup/verify-restore.sh
```

starts a scratch `postgres:16-alpine` on the compose-internal network, restores
the latest dump into it (creating the `st_app` role first, as a real restore
must — roles are cluster-level and not part of a database dump), compares row
counts with the manifest, checks that `st_app` still cannot `UPDATE`/`DELETE`
`audit_log`, restores the newest live capture's image file — from the local
snapshot, or from the latest restic snapshot when `RESTIC_REPOSITORY` is set —
and verifies its sha256 against the restored row. It prints `PASS`/`FAIL`
lines and exits non-zero on any failure; the live stack is never touched.
Run it after the first nightly backup and whenever the backup target changes.

### Restoring for real

On a fresh host with `deploy/.env` recovered (the secrets matter: `SESSION_SECRET`,
`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, and `RESTIC_PASSWORD` if used):

```sh
docker compose -f deploy/docker-compose.yml up -d postgres          # empty cluster
# 1. database — from the backups volume or a restic restore of /backups/db/latest.dump
docker compose -f deploy/docker-compose.yml run --rm --no-deps backup sh -c '
  psql -X -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '"'"'st_app'"'"') THEN CREATE ROLE st_app LOGIN; END IF; END \$\$;" &&
  pg_restore --no-owner --exit-on-error -d "$PGDATABASE" /backups/db/latest.dump'
# 2. images — copy the matching snapshot into the images volume
docker run --rm -v snapping-turtle_backups:/b:ro -v snapping-turtle_images:/data/images \
  alpine sh -c 'cp -a /b/images/latest/. /data/images/ && chown -R 1000:1000 /data/images'
# 3. everything else
docker compose -f deploy/docker-compose.yml up -d
```

With restic, replace steps 1–2's sources with
`restic restore latest --target /tmp/r` inside the backup container (it has
the repository env) and copy from `/tmp/r/backups/db/…` and
`/tmp/r/data/images/…`. The app re-syncs `st_app`'s password from
`APP_DB_PASSWORD` at boot, so the restored grants become usable immediately.

### Upgrading Postgres across a major version

A major bump of the `postgres` image (`16-alpine` → `17`/`18`) is a data
migration, not a dependency update, and Dependabot is configured to ignore it
(`.github/dependabot.yml`). Postgres will not open a data directory written by
an older major — the new image simply refuses to start on the old volume — and
an older `pg_restore` cannot read dumps produced by a newer `pg_dump`, so the
server image and the backup sidecar's client (`deploy/Dockerfile.backup`) have
to move together. The procedure reuses the backup tooling above:

```sh
# 0. fresh backup, and prove it restores before touching anything
docker compose -f deploy/docker-compose.yml run --rm backup run
deploy/backup/verify-restore.sh
# 1. stop writers; keep postgres and backup up
docker compose -f deploy/docker-compose.yml stop app
# 2. bump BOTH images in one commit: deploy/docker-compose.yml (postgres service)
#    and deploy/Dockerfile.backup (FROM postgres:<new>-alpine); also the
#    scratch image in deploy/backup/verify-restore.sh and the CI service in
#    .github/workflows/ci.yml so they keep matching production.
# 3. bring up an empty cluster of the new major on a NEW volume
docker compose -f deploy/docker-compose.yml stop postgres && docker compose -f deploy/docker-compose.yml rm -f postgres
docker volume rm snapping-turtle_pgdata              # or rename it to keep a fallback
docker compose -f deploy/docker-compose.yml up -d --build postgres backup
# 4. restore the dump from step 0 exactly as in "Restoring for real" (create
#    st_app first, then pg_restore --no-owner --exit-on-error)
# 5. verify against the new cluster, then release traffic
deploy/backup/verify-restore.sh
docker compose -f deploy/docker-compose.yml up -d --build
```

Keep the step-0 dump (and the old volume, if renamed) until the new cluster has
completed at least one nightly backup that `verify-restore.sh` passes.

## Domain migration

Change `PUBLIC_HOST`, run `docker compose ... up -d`, rebuild the extension so its
baked-in default server matches (`pnpm --filter extension build`). Keep the old
name serving a `redir 308` block for one retention window (PLAN.md §15).

## Notes

- Caddy runs as root inside its container (needed to bind 80/443 in the stock
  image); the app and Postgres do not.
- Resource limits are set via `deploy.resources.limits`; adjust per host.
- Trivy scans the built app and backup images in CI (HIGH/CRITICAL fail the
  build; reviewed exceptions live in `deploy/.trivyignore`).
