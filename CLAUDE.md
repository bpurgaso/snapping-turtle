# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

snapping-turtle: a self-hosted screenshot capture and sharing system. Browser extensions (Chrome + Firefox, MV3) capture a tab and upload to a Fastify server; each capture gets an unguessable URL where the owner annotates (red/white rectangles, arrows, text) and anyone with the link sees a flat render plus a link back to the source page. This service is security-sensitive by design: capability URLs, anti-enumeration guard, full upload attribution, admin audit logging.

**Read PLAN.md before non-trivial work.** It is the design authority; `§n` references below point into it. If implementation reality forces a deviation, update PLAN.md in the same PR and say so — the two must not drift.

## Status

M0 (scaffold), M1 (server core: auth, registration toggle, API tokens, hardened upload, view-only capture page, uniform 404), M2 (extension walking skeleton: popup, visible-viewport capture, options page, `GET /api/v1/ping`, Chrome + Firefox builds), M3 (annotation editor: Fabric.js rect/arrow/text, autosave with revisions, owner gating, retention selector + delete, tall-canvas perf spike in `docs/perf-tall-canvas.md`), M4 (flat renderer: SVG overlay + sharp composite behind `/s/:viewId/image.png` with per-capture cache, ETag/304, render gate, vendored Inter + fontconfig, `pnpm test:parity` pixel harness and server goldens), M5 (guard: per-IP windows + escalating persisted bans + breaker; DB-enforced append-only `audit_log` via the `st_app` role split; admin panel with one-time-link account lifecycle at `/admin`; `/reset/:token`; xcaddy rate-limit build), M6 (region-select overlay in a closed shadow root; full page via Firefox `captureTab` rect and Chrome scroll-and-stitch with pure, unit-tested geometry in `extension/src/lib/capture-geometry.ts`; Firefox `captureTab` semantics measured in `docs/firefox-capturetab-probe.md`) M7 (hourly retention purge with tombstones and hard delete after `TOMBSTONE_DAYS` in `server/src/jobs/purge.ts`; backup sidecar + `deploy/backup/verify-restore.sh`; the `sec.*` security-event taxonomy in `docs/security-events.md`; k6 guard scenarios under `loadtest/` with results in `docs/loadtest.md`; pnpm audit + Trivy + Dependabot in CI per `docs/supply-chain.md`) and M8 (audited `build:release`, Firefox AMO signing via `sign:firefox` + self-hosted updates from the public `/ext/` route, the Chrome submission kit in `extension/STORE_SUBMISSION.md`, the rehearsed domain-migration runbook in `docs/runbooks/`, the tag-triggered release workflow, README + `docs/README.md`) are done: v1 is complete. Post-v1 (2026-09-01) the TLS/network posture moved to ACME DNS-01 (Cloudflare) on a single published high port, `PUBLIC_PORT` = 28443, with nothing on 80/443 (PLAN.md §14 v0.12 notes; `deploy/README.md` "TLS"). E1 (2026-09-02) made annotation sizes a function of the capture width (`annotationSizes()` in `shared/`, PLAN.md §9 table; flat cache versioned by `RENDER_VERSION`, §10) — server + web only. E2 and E3 (2026-09-02, server + web only) gave the home page install cards — Firefox through the stable `GET /ext/firefox-latest` redirect resolved from `updates.json` per request, Chrome through the optional `CHROME_EXTENSION_URL` (§8, §14) — and put Open Graph / Twitter card tags on live capture pages with the uniform 404 and the guard untouched (§6, §7). What remains is human-gated — store submission (then set `CHROME_EXTENSION_URL`), the first AMO signing with the owner's accounts (`extension/STORE_SUBMISSION.md`), the first real DNS-01 issuance with the owner's Cloudflare token, and posting a capture link in a real Discord channel to see the unfurl. Future work is the deferred backlog in PLAN.md §17; milestones live in §16. The commands below are the contract and CI keeps them green. Capture needs a real browser gesture, so `extension/TESTING.md` holds the manual checklist for what automation cannot reach.

## Layout (pnpm workspaces)

```
shared/     Annotation schema, API types, cross-cutting constants (size caps, guard defaults). Source of truth.
server/     Fastify app: API, page serving, sharp flat renderer, guard (rate limits / bans / breaker), jobs (retention purge). Drizzle + Postgres.
web/        Vite bundles served by server/: home-page and capture-page scripts (those pages are server-rendered in server/src/html.ts), Fabric.js editor, auth pages, account, admin panel.
extension/  One MV3 codebase → Chrome (service worker) and Firefox (event page) builds via manifest templates; src/content/ is the on-demand content script (region overlay, page driver); scripts/ (build, audited release, AMO signing); TESTING.md manual checklist; STORE_SUBMISSION.md store handoff.
deploy/     docker-compose.yml (+ .local/.loadtest/.migration overrides), Caddyfile(s) + caddy.d/ (old-domain redirect), Dockerfiles (app, caddy = xcaddy build with caddy-dns/cloudflare + caddy-ratelimit, backup), backup/ (backup.sh, verify-restore.sh), ext/ (signed .xpi + updates.json served at /ext/), test-domain-migration.sh, .env.example, .trivyignore.
loadtest/   k6 guard scenarios (ban, breaker, baseline) + run.sh; k6 runs as a container, never as a dependency.
scripts/    check-image-pins.sh: the Postgres image tag in deploy/docker-compose.yml is authoritative; CI fails if any other site drifts.
docs/       README.md index; runbooks/domain-migration.md; security-events.md (sec.* taxonomy), loadtest.md, supply-chain.md, perf/probe notes.
data/       Local image store (git-ignored; IMAGES_DIR, compose mounts a volume at /data/images).
PLAN.md     Full design document.
```

## Commands

```
pnpm install                                  # bootstrap workspace
pnpm dev                                      # server watch + web dev build
pnpm build                                    # all packages
pnpm test                                     # unit (vitest)
pnpm test:integration                         # API, authz matrix, guard behavior
pnpm test:parity                              # editor <-> server render golden tests (Playwright)
pnpm lint && pnpm typecheck                   # must pass before commit
pnpm --filter extension build:chrome          # dev extension zip (also build:firefox)
pnpm --filter extension build:release         # audited production builds of both targets (PUBLIC_HOST + EXTENSION_GECKO_ID from deploy/.env)
pnpm --filter extension sign:firefox          # AMO signing with WEB_EXT_API_KEY/SECRET from the shell env only → deploy/ext/
pnpm --filter extension test:smoke            # Playwright: overlay/driver in fixture pages + built Chrome extension (run build:chrome first)
pnpm --filter server db:migrate               # migrations
pnpm --filter server db:seed                  # bootstrap admin + accounts via one-time links
docker compose -f deploy/docker-compose.yml up -d --build                                   # production: DNS-01 certs, publishes PUBLIC_PORT only
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up -d --build   # every local run (localhost included): internal CA, same port
docker compose -f deploy/docker-compose.yml run --rm backup run   # ad-hoc backup (nightly otherwise)
deploy/backup/verify-restore.sh               # prove the latest backup restores (scratch Postgres, sha256 check)
pnpm loadtest [ban|breaker|baseline]          # k6 guard scenarios against the dedicated loadtest compose project (not in CI)
deploy/test-domain-migration.sh               # rehearse the domain-migration runbook on a throwaway stack (not in CI)
scripts/check-image-pins.sh                   # every postgres image tag equals the deploy/docker-compose.yml pin (runs in CI)
```

## Security invariants — hard rules, never traded for convenience

1. **Secret tokens** (`view_id`, API tokens, reset tokens) are ≥20 bytes from `crypto.randomBytes`, base64url. Never `Math.random`, never sequential or derived values. API and reset tokens are stored hashed (sha256) and shown once; `view_id` is the public capability, stored as the lookup key but treated as a secret everywhere else (see rule 3).
2. **Uniform not-found on `/s/*`** (§6): never-existed, expired, deleted, and tombstoned IDs return a byte-identical generic 404 — same status, headers, and body, with latency jitter. Do not add distinguishing error messages, redirects, or caching differences, however helpful they seem.
3. **Never log full secrets.** `view_id`s, tokens, and reset links appear in logs and error messages only as an 8-char prefix. Audit log entries reference internal row ids, not `view_id`s. Committed test fixtures use obviously fake tokens.
4. **Upload pipeline** (§12): accept PNG/JPEG by magic bytes only; always decode and re-encode via sharp with `limitInputPixels` and the dimension caps from `shared/`; never persist user-supplied bytes verbatim; the server chooses all filenames and paths.
5. **Annotation text is data, never markup**: DOM via `textContent`, SVG via strict escaping. No `innerHTML` with user-influenced content anywhere in `web/`.
6. **CSP stays strict**: `default-src 'self'`, no `unsafe-inline`, no `unsafe-eval`. If a dependency or build change appears to require weakening it, stop and flag instead of weakening.
7. **Every admin mutation writes `audit_log` in the same transaction.** The app DB role has no UPDATE/DELETE grant on that table; don't add one.
8. **AuthZ is server-side on every mutating route**: owner-or-admin checks against the session, never client-supplied flags. Cookie-authenticated state changes require CSRF; bearer-token routes must not accept cookies as authentication. When in doubt in an authz path, deny.
9. **The guard** (per-IP limits, escalating bans, global breaker — §12) is config-driven and never disabled or special-cased in production code paths. Tests inject clocks and config; they do not add bypasses. `TRUST_PROXY=true` exists only for the loadtest compose override and makes the app log `sec.proxy.permissive_trust` at error level on boot.
10. **Secret-page headers stay on** (§6): `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: private, no-store`; outbound source links carry `rel="noopener noreferrer"`. Don't remove these while touching header code.
11. **Database access goes through Drizzle's query builder** — no string-concatenated SQL.
12. **No secrets in git**: `.env` is ignored; keep `deploy/.env.example` current whenever config is added. `CLOUDFLARE_API_TOKEN` is read by Caddy from its environment only — never into a Caddyfile, a log line, or a script's output.
13. **One published port, no 80/443**: compose publishes `${PUBLIC_PORT}` (TCP + UDP) and nothing else; the Caddyfiles keep `auto_https disable_redirects` and the DNS-01 `tls` block. Never add a listener on 80 or 443 "just in case" — and never describe the high port as a security measure in any doc: it is conflict avoidance and surface reduction; the capability URLs and the guard are the defenses.

## Engineering conventions

- TypeScript strict, ESM, Node 22 across the workspace. `shared/` contains no server-only or browser-only imports.
- `shared/` is the single source of truth for the annotation schema (versioned), API types, and constants (32,000 px height cap, `MAX_UPLOAD_MB`, capture tile pacing). Never re-declare a constant that exists there.
- **Renderer parity** (§10): any change to how a shape is drawn must touch both the Fabric renderer (`web/`) and the SVG renderer (`server/`) and update the golden fixtures — `pnpm test:parity` enforces this. Every drawing size comes from `annotationSizes(width)` in `shared/` (§9); a literal stroke or font size in either renderer fails `shared/test/style-literals.test.ts`.
- Dependencies are attack surface: prefer the stdlib and Fastify ecosystem; a new runtime dependency needs a one-line justification in the PR description.
- Security-relevant changes ship with negative-path tests (403 / 404 / 409 / 429), not just happy paths.
- Fastify routes declare TypeBox schemas; unvalidated `req.body`/`query` never reaches a handler.

## Gotchas

- Chrome throttles `captureVisibleTab` to ~2 calls/sec — the full-page tile pacing (~600 ms) is a shared constant; don't "optimize" it away (§15).
- Full-page capture is intentionally two code paths: Firefox `tabs.captureTab({ rect })` natively, Chrome scroll-and-stitch (§15).
- Extension manifests are generated from templates in `extension/`; never hand-edit build output.
- Flat-render text resolves through fontconfig to the one font vendored at `shared/fonts/Inter-Regular.ttf` (`server/fontconfig/fonts.conf`, `FONTCONFIG_PATH`, and `PANGOCAIRO_BACKEND=fontconfig` — sharp's macOS pango otherwise uses CoreText and ignores fontconfig entirely). Removing any of these silently changes or breaks text in flat renders (§10).
- The 32,000 px height cap is shared between extension capture, server ingest validation, and the editor; changing it means revisiting browser canvas limits (§9, §15).
- Anything that changes what an *unchanged* annotation document looks like — a retune of `ANNOTATION_SIZE_CURVE`, a color, the font, a geometry fix — must bump `RENDER_VERSION` in `shared/src/annotations.ts` (the flat cache and the image ETag are keyed on it; old flats then re-render lazily) and regenerate the goldens with `UPDATE_GOLDENS=1 pnpm --filter server test`. Stored `fontSize` is absolute pixels; only the default for new text is width-derived — do not store relative units without a schema version bump (§9).
- The home page and every capture page are server-rendered (`server/src/html.ts`); `web/` ships only their scripts and styles. Anything user-influenced or configured that lands in either page goes through the escaping `html` template — never string concatenation. The uniform 404 body (`NOT_FOUND_HTML`) carries no preview tags and must stay a fixed string.
- Preview crawlers (Discordbot and friends) are ordinary anonymous traffic: never allowlist a user agent through the guard (rule 9); a bot that trips a ban waits it out like anyone else.
- Security-relevant log lines go through `logSecurityEvent()` with a `sec.*` tag; adding a tag without a row in `docs/security-events.md` fails a unit test. Purge, backup and guard logs name captures by internal id only.
- Roles are not in a `pg_dump`: any restore creates `st_app` before `pg_restore` (the dump keeps its grants) — `deploy/backup/verify-restore.sh` does exactly this and is the template.
- The extension imports only `@snapping-turtle/shared/constants`, never the barrel: the schema modules build TypeBox objects at import time, which bundles all of TypeBox into every extension script and fails the release audit (`http://example.com` in its format code). Put cross-cutting constants in `shared/src/constants.ts`.
- `EXTENSION_GECKO_ID` is pinned in `deploy/.env` and never changes — AMO ties every signed version to it; changing it orphans every installed Firefox copy. `build:release` refuses to run without it.
- `strict_min_version` (Firefox 140 / Android 142) is the floor for `data_collection_permissions`; lowering it makes addons-linter fail the release build.
- `PUBLIC_ORIGIN` must carry the explicit port (`https://host:28443`); compose derives it from `PUBLIC_HOST` + `PUBLIC_PORT`, and the app refuses to boot when `PUBLIC_PORT` disagrees with the origin's effective port. Any override (loadtest, local dev) that sets `PUBLIC_ORIGIN` must set a matching `PUBLIC_PORT` or none. The extension build derives the same origin (`extension/scripts/lib/env.ts`); host patterns need no port handling (Chrome keeps it, Firefox ignores ports, the port-less optional pattern matches every port).
- The production Caddyfile's explicit DNS-01 issuer overrides Caddy's internal-CA default for `localhost`, so every local compose run needs `docker-compose.local.yml`. Real DNS-01 issuance needs a real zone and token; rehearsals and local runs use the internal CA on the same port.

## Maintaining this file

Keep the commands and layout here accurate — update them in the same PR that changes them. Keep this file short; design detail belongs in PLAN.md.
