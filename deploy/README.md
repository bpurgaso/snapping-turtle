# Deploying snapping-turtle

Three services (PLAN.md §14): `caddy` (TLS via ACME DNS-01, body limits, the
coarse rate cap), `app` (Fastify), `postgres`. Postgres is on an internal-only
network; the app runs as the unprivileged `node` user with a read-only root
filesystem, `no-new-privileges` and all capabilities dropped. The host
publishes exactly one port, `PUBLIC_PORT` (28443 by default, TCP + UDP);
nothing listens on 80 or 443.

## Production

```sh
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env          # PUBLIC_HOST, CLOUDFLARE_API_TOKEN, POSTGRES_PASSWORD, SESSION_SECRET at minimum
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps    # wait for app: healthy; caddy shows only PUBLIC_PORT
docker compose -f deploy/docker-compose.yml logs caddy | grep -E 'certificate obtained|error'
```

Generate secrets rather than typing them: `openssl rand -base64 48` for
`SESSION_SECRET`, `openssl rand -hex 24` for `POSTGRES_PASSWORD`.

The firewall opens `PUBLIC_PORT` (TCP and UDP) and nothing else — not 80,
not 443 (see "TLS" below for why neither is needed). Migrations run
automatically when the app starts. Create the first admin once:

```sh
docker compose -f deploy/docker-compose.yml run --rm app node dist/db/seed.js
```

then remove `ADMIN_BOOTSTRAP_*` from `deploy/.env`. Re-running the seed never
changes an existing user's password.

## TLS: Let's Encrypt via DNS-01, one high port, no 80/443

Caddy obtains and renews the certificate for `PUBLIC_HOST` with the ACME
**DNS-01** challenge: instead of Let's Encrypt connecting *to* the host on
port 80 (HTTP-01) or 443 (TLS-ALPN-01), Caddy proves control of the DNS zone
by creating a `_acme-challenge` TXT record through the Cloudflare API and
removing it afterwards. Consequences worth knowing:

- **No inbound 80/443, ever.** Nothing binds them: the Caddyfile's
  `auto_https disable_redirects` removes the HTTP→HTTPS redirect server that
  would otherwise listen on :80, and Caddy's ACME client uses the DNS
  solver *exclusively* once one is configured (certmagic registers no
  HTTP-01/TLS-ALPN-01 solver in that case), so no challenge ever needs a
  connection in. The compose file publishes `PUBLIC_PORT` only; the
  migration rehearsal asserts nothing else listens.
- **Renewal depends on the token staying valid.** Caddy renews ~30 days
  before expiry using the same token, in the background, with no cron. If
  the token is revoked, rotated in Cloudflare but not in `deploy/.env`, or
  loses a permission, renewals fail quietly until the certificate expires —
  the failures are in `docker compose logs caddy` (errors from the `tls.obtain`
  logger naming the DNS challenge, the zone or the token). Treat "rotate the
  token" as "update `deploy/.env` and `up -d` in the same change", and
  keep the token's expiry unset or far out.
- **The one published port is HTTP/1.1, HTTP/2 and HTTP/3** (`Alt-Svc:
  h3=":28443"`), so both TCP and UDP for it are published.

**Why a high port at all, and what it is not.** Moving off 443 keeps this
service out of the way of anything else on the box or a shared IP, and
combined with DNS-01 it takes two well-known listeners off the host — that
is conflict avoidance and surface reduction. It is **not** a security
control: mass scanners sweep all 65,535 ports and will find 28443 in the
same pass as 443, so nothing in this design relies on the port being
unknown. The defenses are the ones PLAN.md §6 and §12 describe — 160-bit
capability URLs, byte-identical 404s, the per-IP ban ladder and the global
breaker, strict headers — and they are identical on any port. 28443 was
chosen because it is memorable and sits below Linux's default ephemeral
port range (`net.ipv4.ip_local_port_range` starts at 32768), so no kernel
port reservation is needed for the listener; any other free port below
32768 works the same way — change `PUBLIC_PORT`, `up -d`, rebuild the
extension.

### Creating the Cloudflare API token (least privilege)

In the Cloudflare dashboard: *My Profile → API Tokens → Create Token →
Create Custom Token*:

| Setting         | Value                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Permissions     | **Zone → Zone → Read** and **Zone → DNS → Edit** (both; `DNS:Edit` alone fails the plugin's zone lookup, which needs `Zone:Read`) |
| Zone Resources  | *Include → Specific zone → the one zone `PUBLIC_HOST` lives in* — not "All zones"                                               |
| Client IP filtering | optional: the server's public IP, if it is static                                                                           |
| TTL             | none, or far enough out that a renewal cannot silently miss it                                                                   |

Copy the token once into `CLOUDFLARE_API_TOKEN` in `deploy/.env`. It is
read only by Caddy, from its environment (`{env.CLOUDFLARE_API_TOKEN}` in
the Caddyfile), never written to any file or log by anything in this repo
(CLAUDE.md rules 3 and 12). A token with `Zone:Read` + `DNS:Edit` on one
zone can rewrite that zone's records — that is the blast radius if the host
is compromised; a dedicated zone for this service bounds it further.

**The DNS record must be DNS-only (grey cloud).** `PUBLIC_HOST`'s A/AAAA
record in Cloudflare must have the proxy switched **off**: Cloudflare's
proxy only forwards a fixed list of ports (28443 is not one of them) and it
terminates TLS with its own edge certificate, which cannot coexist with the
origin-issued Let's Encrypt certificate the extension and browsers expect
from this origin. Orange cloud = connection refused or a certificate for
the wrong party; grey cloud = works. The DNS-01 challenge itself is
unaffected either way.

### Provider swap

The DNS provider is a build argument plus one Caddyfile line. To move to
another provider from the `caddy-dns` organisation (say `route53`,
`digitalocean`, `hetzner`, …):

1. `deploy/Dockerfile.caddy`: set `CADDY_DNS_MODULE` to
   `github.com/caddy-dns/<provider>@<tag>` (pin a tag or commit, never
   `@latest` — the TLS terminator is supply-chain surface), or pass
   `--build-arg` at build time;
2. `deploy/Caddyfile`, snippet `tls_dns`: `dns <provider> {env.<PROVIDER_TOKEN>}`
   with whatever credential arguments that provider's README specifies;
3. `deploy/docker-compose.yml`: pass the new variable into the `caddy`
   service's environment and document it in `deploy/.env.example`;
4. `docker compose ... up -d --build`, then confirm `certificate obtained`
   in the Caddy log.

Not done here, on purpose: a shared edge (one Caddy in front of several
sites, or this service behind someone else's reverse proxy). That is a
different answer to a different problem — the edge then owns certificates,
ports and the client IP the guard keys on (`TRUST_PROXY`), and this
compose file assumes it *is* the edge.

## Local / development without ACME

Every local run — `localhost` included — uses the local override, which
swaps in `Caddyfile.local` (same `PUBLIC_HOST:PUBLIC_PORT` listener, Caddy's
internal CA instead of ACME, no Cloudflare token needed):

```sh
# in deploy/.env: PUBLIC_HOST=localhost   (or a LAN name, shots.test, …)
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up -d --build
```

The site is then at `https://localhost:28443` (self-signed; `curl -k`, or
trust the CA below). The override is required even for `localhost`: the
production Caddyfile configures the DNS-01 issuer explicitly, and an
explicit issuer overrides the internal-CA default Caddy would otherwise
apply to local names — with the production file, `localhost` would try Let's
Encrypt and fail. Nothing public is needed: no port has to be reachable
from outside, and the stack still publishes only `PUBLIC_PORT`.

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

starts a scratch Postgres (the compose-pinned image) on the compose-internal network, restores
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

### The Postgres image pin

`deploy/docker-compose.yml` pins an explicit patch release
(`postgres:16.15-alpine`), not the floating `16-alpine` tag, and
`scripts/check-image-pins.sh` (run in CI) holds every other site that names
the image — the backup sidecar's `FROM`, the CI service container,
`verify-restore.sh`'s scratch container and the README quickstart — to the
same literal. Two reasons for the explicit pin, decided in M8:

- **Reproducible deploys.** `docker compose up -d --build` never re-pulls a
  tag the host already has, so a floating `16-alpine` means "whatever this
  box pulled the first time" — silently stale, and different from box to box.
  An explicit tag is what it says it is until someone changes it.
- **A visible update trail.** Dependabot cannot propose anything against a
  floating tag (there is nothing to bump), so patch releases arrived never.
  With the explicit pin the docker-compose ecosystem opens a `16.N → 16.N+1`
  PR (its ignore rule is majors-only), the pin check makes that PR sync the
  other sites before it can go green, and the deploy picks it up on the next
  `up -d`. Patch upgrades within a major are safe on the existing data volume.

## Upgrading Postgres across a major version

A major bump of the `postgres` image (`16.15-alpine` → `17`/`18`) is a data
migration, not a dependency update, and Dependabot is configured to ignore it
(`.github/dependabot.yml`; minors/patches of the compose pin still flow, and a
Dependabot bump of that pin fails `scripts/check-image-pins.sh` until the
other sites are synced in the same PR — the drift is loud on purpose). Postgres will not open a data directory written by
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
# 2. change the pin in deploy/docker-compose.yml (postgres service) — that is
#    the authoritative, Dependabot-visible literal — then run
#    scripts/check-image-pins.sh: it fails until deploy/Dockerfile.backup
#    (FROM), deploy/backup/verify-restore.sh (scratch image), the CI service in
#    .github/workflows/ci.yml and the README quickstart carry the same tag.
#    Sync them in the same commit; CI runs the check on every push.
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

One variable: change `PUBLIC_HOST`, add the old-domain `redir 308` block in
`deploy/caddy.d/` (copy the example — it listens on the same `PUBLIC_PORT`
and gets its certificate through the same DNS-01 snippet), `docker compose
... up -d`, then `build:release` + re-sign/republish the extension so its
baked-in default matches. The precondition is that the API token can edit
the new name's zone; no port opens or closes. The full procedure — DNS
preconditions, verification, what users see, how long the redirect must
live, rollback — is
[`docs/runbooks/domain-migration.md`](../docs/runbooks/domain-migration.md),
and `deploy/test-domain-migration.sh` rehearses it against a throwaway compose
project (both hostnames, the custom port, Caddy's internal CA standing in
for DNS-01) and asserts that shared `/s/<id>?query` links survive the
redirect byte-for-byte and that nothing listens on 80/443. Run it before a
real migration.

## Extension distribution

The app serves `deploy/ext/` read-only at `https://$PUBLIC_HOST:$PUBLIC_PORT/ext/`: the
AMO-signed Firefox `.xpi` and the `updates.json` Firefox polls for updates
(`pnpm --filter extension sign:firefox` writes both; see
`extension/STORE_SUBMISSION.md`). Chrome installs come from the unlisted Web
Store listing and update through the store.

## Notes

- Caddy runs as root inside its container (the stock image's default; it
  binds only `PUBLIC_PORT` and its loopback admin endpoint); the app and
  Postgres do not.
- `PUBLIC_ORIGIN` is derived by compose as `https://$PUBLIC_HOST:$PUBLIC_PORT`
  and is the single source of every generated URL — page links, image links,
  `/ext/updates.json`. The app refuses to boot if `PUBLIC_PORT` and the port
  in `PUBLIC_ORIGIN` disagree (config drift fails loudly, like the image-pin
  check in CI).
- Resource limits are set via `deploy.resources.limits`; adjust per host.
- Trivy scans the built app, backup and Caddy images in CI (HIGH/CRITICAL
  fail the build; reviewed exceptions live in `deploy/.trivyignore`). The
  Caddy image is the xcaddy build with the DNS and rate-limit plugins, so
  the scanned binary is the one that runs.
