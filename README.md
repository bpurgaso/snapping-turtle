# snapping-turtle

Self-hosted screenshot capture and sharing. Browser extensions (Chrome + Firefox)
capture a tab and upload it to your own server; each capture gets an unguessable
URL where the owner annotates and anyone with the link sees the result.

Design: [PLAN.md](PLAN.md). Working rules: [CLAUDE.md](CLAUDE.md).
**Status:** M1 — server core. Accounts (sign in / sign up behind the admin
toggle), personal API tokens, the hardened upload endpoint, and the view-only
capture page with its uniform 404 are live. The extension (M2), editor (M3),
flat renderer (M4) and admin panel/guard (M5) come next.

## Prerequisites

- Node 22 (`.nvmrc`; `nvm use`) and pnpm via corepack: `corepack enable`
- Docker + Compose v2 for the full stack or a throwaway Postgres
- Playwright Chromium for the browser tests: `pnpm --filter web exec playwright install chromium`

## Quickstart A — local development

```sh
pnpm install
cp deploy/.env.example deploy/.env      # both compose and pnpm dev read this file
# Point DATABASE_URL at a Postgres you own, e.g. a throwaway container:
docker run -d --name st-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=snapping_turtle -p 5432:5432 postgres:16-alpine
#   DATABASE_URL=postgres://app:devpassword@localhost:5432/snapping_turtle

pnpm --filter server db:migrate         # apply migrations
pnpm --filter server db:seed            # bootstrap admin from ADMIN_BOOTSTRAP_* (one-time)
pnpm dev                                # server on http://localhost:3000 + web/shared watch builds
```

`GET /healthz` reports database connectivity; `/` serves the Vite bundle.
Uploaded images land in `data/images/` (git-ignored; override with `IMAGES_DIR`).

## Smoke test: upload with curl

Until the extension exists (M2), exercise the whole path from a terminal:

1. Sign in at `http://localhost:3000/login` with the seeded admin (or enable
   signups first: `update settings set value = 'true' where key = 'registration_enabled';`
   — the admin toggle UI arrives in M5).
2. On `/account`, create an API token. It is shown **once**; the page also
   prints a ready-to-paste `curl` line for it.
3. Upload any PNG or JPEG:

   ```sh
   curl -sS -X POST http://localhost:3000/api/v1/captures \
     -H "Authorization: Bearer st_XXXXXXXXXXXXXXXXXXXXXXXXXXX" \
     -F "image=@screenshot.png" \
     -F "sourceUrl=https://example.com/page" \
     -F "title=Example page"
   # → {"pageUrl":"http://localhost:3000/s/<27-char id>","imageUrl":".../image.png"}
   ```

4. Open `pageUrl` in a browser: the image, an **Open original page** link, and
   copy buttons for the page and image links. `imageUrl` serves the re-encoded
   PNG (the flat render with annotations from M4 on, at the same URL).

Only the bearer token authenticates uploads — a browser session cookie is
deliberately not accepted there. Uploads are sniffed by magic bytes (PNG/JPEG
only), decoded under pixel and dimension caps, and re-encoded, so stored files
never contain the uploaded bytes or their metadata.

## Quickstart B — full stack (Caddy + app + Postgres)

```sh
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env                     # PUBLIC_HOST, POSTGRES_PASSWORD, SESSION_SECRET
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml run --rm app node dist/db/seed.js
```

With `PUBLIC_HOST=localhost` Caddy signs with its internal CA — no Let's Encrypt
needed. Details, LAN hostnames and CA trust: [deploy/README.md](deploy/README.md).

## Commands

| Command                                                  | What it does                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                                               | server watch + web/shared watch builds                               |
| `pnpm build`                                             | all packages (shared → server, web, extension)                       |
| `pnpm test`                                              | unit tests, one vitest project per package                           |
| `pnpm test:integration`                                  | server against a real Postgres (`DATABASE_URL`)                      |
| `pnpm test:parity`                                       | Playwright: page under production CSP; render parity goldens from M4 |
| `pnpm lint && pnpm typecheck`                            | must pass before commit                                              |
| `pnpm --filter extension build:chrome` / `build:firefox` | loadable zips in `extension/dist/`                                   |
| `pnpm --filter server db:generate`                       | new migration from `server/src/db/schema.ts`                         |
| `pnpm --filter server db:migrate` / `db:seed`            | apply migrations / bootstrap admin                                   |

## Loading the extension

- **Chrome:** `chrome://extensions` → Developer mode → _Load unpacked_ → `extension/dist/chrome/`
- **Firefox:** `about:debugging#/runtime/this-firefox` → _Load Temporary Add-on_ → pick `extension/dist/firefox/manifest.json`

The baked-in default server comes from `PUBLIC_ORIGIN` (or `https://$PUBLIC_HOST`)
in `deploy/.env` at build time.

## Layout

```
shared/     annotation schema (TypeBox), API types, constants — source of truth
server/     Fastify app, Drizzle + Postgres, migrations in server/drizzle/
web/        Vite bundle served by server/ at /
extension/  MV3 codebase → chrome + firefox builds from manifest.template.json
deploy/     docker-compose.yml, Caddyfile(s), Dockerfile, .env.example, README
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, build, unit, integration
and Playwright tests on every push and PR, and builds the Docker image.
