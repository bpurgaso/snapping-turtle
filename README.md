# snapping-turtle

Self-hosted screenshot capture and sharing for you and a small circle of
friends. A browser extension (Chrome + Firefox) captures the visible tab, a
selected region or the whole page and uploads it to **your** server; each
capture gets an unguessable link where the owner annotates (red/white
rectangles, arrows, text) and anyone with the link sees the flat render plus
a link back to the original page. Nothing goes to a third party.

It is built defensively from day one — capability URLs with 160 bits of
entropy, byte-identical 404s so nothing can be enumerated, per-IP bans and a
global breaker, full attribution of every upload, an append-only admin audit
log enforced by the database, strict CSP, automated TLS via DNS-01 with a
single published port, retention with tombstones, nightly verified backups. Design: [PLAN.md](PLAN.md). Working
rules: [CLAUDE.md](CLAUDE.md). All docs: [docs/README.md](docs/README.md).

**Status:** v1 complete (milestones M0–M8, PLAN.md §16). What remains is
human-gated: store submission and AMO signing with the owner's accounts
([extension/STORE_SUBMISSION.md](extension/STORE_SUBMISSION.md)).

## How it works

```
extension ──POST /api/v1/captures (bearer token)──▶ Caddy (TLS) ──▶ app (Fastify) ──▶ Postgres + image volume
Linux client (tray) ──────────── same ──────────────▶ │
viewer ──GET /s/<id> ─────────────────────────────▶ page + /s/<id>/image.png (flat render, cached)
```

Accounts are required to upload; the admin creates them with one-time links
(no email needed) or opens registration for a while. Captures expire after
30 days by default; owners can extend to a year, admins can keep forever.

## Fresh deploy — from DNS to first capture

You need a Linux box with Docker + Compose v2, a hostname in a Cloudflare
DNS zone, and **one** inbound port open in the firewall: 28443 (TCP and UDP)
— nothing on 80 or 443, since certificates come from Let's Encrypt via the
DNS-01 challenge and never need an inbound connection. The port is
conflict avoidance, not a defense: scanners sweep every port, and what
protects captures is the 160-bit link plus the guard (PLAN.md §6, §12).
Node is only needed on the machine that builds the extension (below).

1. **DNS + API token.** Create an A/AAAA record for your hostname (say
   `shots.example.com`) pointing at the box, **DNS-only (grey cloud)** —
   Cloudflare's proxy neither forwards port 28443 nor coexists with the
   origin's own certificate. Wait until `dig +short shots.example.com`
   answers from outside. Then create a Cloudflare API token scoped to that
   one zone with *Zone → Zone → Read* and *Zone → DNS → Edit* (both are
   required; step-by-step in [deploy/README.md](deploy/README.md) "TLS").

2. **Configure.**

   ```sh
   git clone <this repository> snapping-turtle && cd snapping-turtle
   cp deploy/.env.example deploy/.env
   $EDITOR deploy/.env
   ```

   Set at least: `PUBLIC_HOST=shots.example.com`; `PUBLIC_PORT=28443` (the
   one port you opened); `CLOUDFLARE_API_TOKEN` (the token from step 1 —
   it lives only in this git-ignored file and Caddy's environment);
   `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` (`openssl rand -hex 24` each);
   `SESSION_SECRET` (`openssl rand -base64 48`); `ADMIN_BOOTSTRAP_USER` /
   `_PASSWORD` for the first admin (≥ 12 chars); and
   `EXTENSION_GECKO_ID=snapping-turtle@shots.example.com` (the Firefox
   add-on id — pick it once, never change it). Every other variable has a
   sane default and is documented in the file. Every URL the service mints
   carries the port (`https://shots.example.com:28443/…`).

3. **Start.**

   ```sh
   docker compose -f deploy/docker-compose.yml up -d --build
   docker compose -f deploy/docker-compose.yml ps        # wait for app: healthy; caddy publishes 28443 only
   docker compose -f deploy/docker-compose.yml logs caddy | grep 'certificate obtained'
   curl -sSI https://shots.example.com:28443/login | head -1     # HTTP/2 200
   ```

   Caddy obtains the Let's Encrypt certificate at startup through DNS-01
   (a temporary `_acme-challenge` TXT record; typically under a minute);
   migrations run when the app starts. The nightly backup sidecar starts too
   (see day-2 below).

4. **Seed the admin** (once), then drop the bootstrap variables from `.env`:

   ```sh
   docker compose -f deploy/docker-compose.yml run --rm app node dist/db/seed.js
   ```

5. **Get an API token.** Sign in at `https://shots.example.com:28443/login`, open
   **Account**, create a token. It is shown once; the page also prints a
   ready-to-paste `curl` line if you want to test the upload path without the
   extension.

6. **Install the extension.** Two ways:
   - _Published builds_ (after you have submitted them —
     [extension/STORE_SUBMISSION.md](extension/STORE_SUBMISSION.md)): open
     `https://shots.example.com:28443/` — the home page offers **Install for
     Firefox** (a stable link, `/ext/firefox-latest`, that always resolves to
     the newest signed `.xpi`; Firefox then updates itself from
     `/ext/updates.json`) and **Install for Chrome** once `CHROME_EXTENSION_URL`
     in `deploy/.env` points at the unlisted Web Store listing.
   - _Your own build_, on a machine with Node 22 + pnpm (`corepack enable`):

     ```sh
     pnpm install
     pnpm --filter extension build:release          # reads deploy/.env; audits the artifacts
     ```

     Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
     `extension/dist/chrome/`. Firefox: `about:debugging#/runtime/this-firefox`
     → **Load Temporary Add-on** → `extension/dist/firefox/manifest.json`
     (temporary add-ons vanish on restart; the signed `.xpi` is the permanent
     route).

   Then: toolbar icon → **Settings** → paste the token → **Test connection**
   → **Save**. Firefox asks for host permission on the first save; Chrome
   only if you enter a server other than the built-in default.

   **Linux desktop (Fedora 44 / KDE Plasma):** install the client RPM from
   the GitHub release (or build it with `client-linux/scripts/package-rpm.sh`
   — set `CLIENT_APP_ID` in `deploy/.env` first, once, and never change it),
   then `snapping-turtle --configure` with a token and launch
   **snapping-turtle** from the app menu. Details in "Linux client" below.

7. **First capture.** On any normal web page click the toolbar icon →
   **Visible** (or `Alt+Shift+S`). The capture page opens in a new tab: draw
   a rectangle, an arrow, some text — it autosaves. **Copy page link** shares
   the annotated view; **Copy image link** shares the flat PNG. Open the page
   link in a private window to see what recipients see. Region
   (`Alt+Shift+R`) and Full page (`Alt+Shift+F`) work the same way.

## Linux client

A native, tray-resident capture client for Linux desktops — primary target
Fedora 44 with KDE Plasma on Wayland — lives in [client-linux/](client-linux/)
(Rust; the one non-TypeScript component, rationale in CLAUDE.md).

1. **Install** the RPM attached to the release, or build it:

   ```sh
   client-linux/scripts/package-rpm.sh        # needs cargo, gcc, rpm-build; reads deploy/.env
   sudo dnf install client-linux/dist/snapping-turtle-*.rpm
   ```

2. **Configure** with a token from your Account page (stored in the KWallet /
   Secret Service keyring, or a 0600 file when there is none); it also asks
   whether to start at login:

   ```sh
   snapping-turtle --configure
   ```

3. **Capture** from the tray menu, the launcher entry's desktop actions, or
   the global shortcuts Plasma asks you to approve (Meta+Alt+S full screen,
   Meta+Alt+W window, Meta+Alt+R region). Full screen and window go through
   KWin's ScreenShot2 (no dialogs); region opens the desktop's own chooser
   — on Plasma 6.7 that chooser has no rectangle option yet, which
   [client-linux/README.md](client-linux/README.md) documents per mode. The
   upload has no source page, so the capture page shows no "Open original
   page" link; everything else is the same page.

Disable autostart with `snapping-turtle --autostart off`. The manual
checklist for a real desktop session is
[client-linux/TESTING.md](client-linux/TESTING.md).

## Onboarding friends

Registration stays closed by default; the admin hands out accounts:

1. `https://shots.example.com:28443/admin` → **Users** → **Create user** → enter a
   username → copy the one-time **set-password link** (valid 24 h, usable
   once; you never see or choose their password).
2. Send the link over any channel. They open it, set a password and are
   signed in.
3. They create their API token on **Account** and paste it into the
   extension's settings (with your server address, if they installed a build
   made for a different default).

Forgot password → **Reset password** on their row issues the same kind of
link. **Disable** revokes their sessions and tokens in one step. Every one of
these actions lands in the audit log. To let people sign up themselves for a
while, flip **Registration** on the admin page (also audited) and off again.

## Day-2 operations

| Task                                                                                   | Where                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backups (nightly `pg_dump` + image snapshots, optional restic off-box) and **restore** | [deploy/README.md](deploy/README.md) — run `deploy/backup/verify-restore.sh` after the first night                                                                                   |
| Someone banned themselves testing links; see bans and breaker state; **unban**         | `/admin` → Guard                                                                                                                                                                     |
| What the app is telling you about attacks and admin actions (`sec.*` log lines)        | [docs/security-events.md](docs/security-events.md); `docker compose -f deploy/docker-compose.yml logs app \| grep '"tag":"sec.'`                                                     |
| Prove the guard still trips under load                                                 | `pnpm loadtest` — [docs/loadtest.md](docs/loadtest.md)                                                                                                                               |
| Upgrade the app                                                                        | `git pull && docker compose -f deploy/docker-compose.yml up -d --build` — patch bumps of the Postgres pin flow through Dependabot; **majors** follow the runbook in deploy/README.md |
| Move to a new domain                                                                   | [docs/runbooks/domain-migration.md](docs/runbooks/domain-migration.md) — rehearse with `deploy/test-domain-migration.sh` first                                                       |
| TLS: DNS-01, the single port, rotating the Cloudflare token, swapping providers        | [deploy/README.md](deploy/README.md) "TLS"                                                                                                                                           |
| Ship an extension update                                                               | bump `extension/package.json`, `build:release`, then Web Store upload / `sign:firefox` — [extension/STORE_SUBMISSION.md](extension/STORE_SUBMISSION.md)                              |
| Dependency and image scanning                                                          | [docs/supply-chain.md](docs/supply-chain.md) (CI: pnpm audit, Trivy, Dependabot)                                                                                                     |

## Local development

```sh
pnpm install                              # Node 22 (.nvmrc) + pnpm via corepack
cp deploy/.env.example deploy/.env        # compose and pnpm dev read the same file
docker run -d --name st-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=snapping_turtle -p 5432:5432 postgres:16.15-alpine
# in deploy/.env: DATABASE_URL=postgres://app:devpassword@localhost:5432/snapping_turtle
#                 PUBLIC_ORIGIN=http://localhost:3000   (overrides the https://$PUBLIC_HOST derivation)
pnpm --filter server db:migrate
pnpm --filter server db:seed              # ADMIN_BOOTSTRAP_* from deploy/.env
pnpm dev                                  # http://localhost:3000, web/shared watch builds
PUBLIC_ORIGIN=http://localhost:3000 pnpm --filter extension build   # dev builds pointing at it
```

Plain `http://` is accepted only for localhost and only as the build-time
default. For the full stack locally, `PUBLIC_HOST=localhost` plus the
`docker-compose.local.yml` override gives you `https://localhost:28443`
under Caddy's internal CA, no DNS token needed — see deploy/README.md. The
Playwright suites need Chromium once:
`pnpm --filter web exec playwright install chromium`.

Uploading from a terminal, if you want to see the wire contract:

```sh
curl -sS -X POST http://localhost:3000/api/v1/captures \
  -H "Authorization: Bearer st_XXXXXXXXXXXXXXXXXXXXXXXXXXX" \
  -F "image=@screenshot.png" -F "sourceUrl=https://example.com/page" -F "title=Example page"
# → {"pageUrl":"http://localhost:3000/s/<27-char id>","imageUrl":".../image.png"}
```

Only the bearer token authenticates uploads; sessions are deliberately not
accepted there. Uploads are sniffed by magic bytes (PNG/JPEG), decoded under
pixel and dimension caps and re-encoded — stored files never contain the
uploaded bytes.

## Commands

| Command                                                           | What it does                                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                                        | server watch + web/shared watch builds                                                                            |
| `pnpm build`                                                      | all packages (shared → server, web, extension)                                                                    |
| `pnpm test`                                                       | unit tests, one vitest project per package                                                                        |
| `pnpm test:integration`                                           | server against a real Postgres (`DATABASE_URL`): API, authz matrix, guard, purge, links                           |
| `pnpm test:parity`                                                | Playwright: pages under production CSP; editor ↔ server render goldens                                            |
| `pnpm lint && pnpm typecheck`                                     | must pass before commit                                                                                           |
| `pnpm --filter extension build:chrome` / `build:firefox`          | dev builds → `extension/dist/`                                                                                    |
| `pnpm --filter extension build:release`                           | audited production builds of both targets (needs `PUBLIC_HOST`+`PUBLIC_PORT`/`PUBLIC_ORIGIN` + `EXTENSION_GECKO_ID`) |
| `pnpm --filter extension sign:firefox`                            | AMO signing (env credentials) → `deploy/ext/` `.xpi` + `updates.json`; `--xpi <file>` publishes a pre-signed file |
| `pnpm --filter extension test:smoke`                              | Playwright: overlay/driver fixtures + the built Chrome extension (`build:chrome` first)                           |
| `cd client-linux && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cargo build --release` | the Linux client's contract (CI runs it in a `fedora:44` container)                               |
| `client-linux/scripts/package-rpm.sh`                             | release binary + RPM → `client-linux/dist/` (`CLIENT_APP_ID`, `PUBLIC_HOST`+`PUBLIC_PORT` from `deploy/.env`)      |
| `DATABASE_URL=… client-linux/scripts/integration.sh`              | real server + the client binary's upload path + row/page assertions (CI)                                          |
| `pnpm --filter server db:generate` / `db:migrate` / `db:seed`     | new migration / apply / bootstrap admin                                                                           |
| `docker compose -f deploy/docker-compose.yml up -d --build`       | the stack                                                                                                         |
| `docker compose -f deploy/docker-compose.yml run --rm backup run` | ad-hoc backup                                                                                                     |
| `deploy/backup/verify-restore.sh`                                 | prove the latest backup restores                                                                                  |
| `deploy/test-domain-migration.sh`                                 | rehearse a domain migration on a throwaway stack                                                                  |
| `pnpm loadtest [ban\|breaker\|baseline]`                          | k6 guard scenarios (dedicated compose project)                                                                    |
| `scripts/check-image-pins.sh`                                     | every Postgres image tag equals the compose pin (CI)                                                              |

CI (`.github/workflows/ci.yml`) runs the lot on every push and PR plus
`pnpm audit` and Trivy scans of the three images; a `v*` tag runs
`.github/workflows/release.yml`, which builds both extension zips and attaches
them to a GitHub release (signing stays local, credentials never enter CI).

## Layout

```
shared/     annotation schema (TypeBox), API types, constants — source of truth
server/     Fastify app, Drizzle + Postgres, sharp flat renderer, guard, purge job
web/        Vite bundles served by server/: capture page + editor, auth, account, admin
extension/  MV3 codebase → chrome + firefox builds; STORE_SUBMISSION.md, TESTING.md
client-linux/  Rust tray client (portal + KWin capture, upload, RPM); README.md per-mode findings, TESTING.md
deploy/     compose (+ local/loadtest/migration overrides), Caddyfiles, Dockerfiles, backup/, caddy.d/, ext/
loadtest/   k6 guard scenarios
scripts/    check-image-pins.sh
docs/       index in docs/README.md
```

## License

Not chosen yet — the owner's decision. Until a `LICENSE` file exists, all
rights are reserved by default.
