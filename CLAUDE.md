# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

snapping-turtle: a self-hosted screenshot capture and sharing system. Browser extensions (Chrome + Firefox, MV3) capture a tab and upload to a Fastify server; each capture gets an unguessable URL where the owner annotates (red/white rectangles, arrows, text) and anyone with the link sees a flat render plus a link back to the source page. This service is security-sensitive by design: capability URLs, anti-enumeration guard, full upload attribution, admin audit logging.

**Read PLAN.md before non-trivial work.** It is the design authority; `§n` references below point into it. If implementation reality forces a deviation, update PLAN.md in the same PR and say so — the two must not drift.

## Status

M0 (scaffold), M1 (server core: auth, registration toggle, API tokens, hardened upload, view-only capture page, uniform 404), M2 (extension walking skeleton: popup, visible-viewport capture, options page, `GET /api/v1/ping`, Chrome + Firefox builds), M3 (annotation editor: Fabric.js rect/arrow/text, autosave with revisions, owner gating, retention selector + delete, tall-canvas perf spike in `docs/perf-tall-canvas.md`), M4 (flat renderer: SVG overlay + sharp composite behind `/s/:viewId/image.png` with per-capture cache, ETag/304, render gate, vendored Inter + fontconfig, `pnpm test:parity` pixel harness and server goldens), M5 (guard: per-IP windows + escalating persisted bans + breaker; DB-enforced append-only `audit_log` via the `st_app` role split; admin panel with one-time-link account lifecycle at `/admin`; `/reset/:token`; xcaddy rate-limit build), M6 (region-select overlay in a closed shadow root; full page via Firefox `captureTab` rect and Chrome scroll-and-stitch with pure, unit-tested geometry in `extension/src/lib/capture-geometry.ts`; Firefox `captureTab` semantics measured in `docs/firefox-capturetab-probe.md`) and M7 (hourly retention purge with tombstones and hard delete after `TOMBSTONE_DAYS` in `server/src/jobs/purge.ts`; backup sidecar + `deploy/backup/verify-restore.sh`; the `sec.*` security-event taxonomy in `docs/security-events.md`; k6 guard scenarios under `loadtest/` with results in `docs/loadtest.md`; pnpm audit + Trivy + Dependabot in CI per `docs/supply-chain.md`) are done. Next is M8 (store packaging, domain-migration runbook, README). Milestones live in PLAN.md §16. The commands below are the contract and CI keeps them green. Capture needs a real browser gesture, so `extension/TESTING.md` holds the manual checklist for what automation cannot reach.

## Layout (pnpm workspaces)

```
shared/     Annotation schema, API types, cross-cutting constants (size caps, guard defaults). Source of truth.
server/     Fastify app: API, page serving, sharp flat renderer, guard (rate limits / bans / breaker), jobs (retention purge). Drizzle + Postgres.
web/        Vite bundles served by server/: capture page + Fabric.js editor, auth pages, account, admin panel.
extension/  One MV3 codebase → Chrome (service worker) and Firefox (event page) builds via manifest templates; src/content/ is the on-demand content script (region overlay, page driver); TESTING.md manual checklist.
deploy/     docker-compose.yml (+ .loadtest.yml override), Caddyfile, Dockerfiles (app, caddy, backup), backup/ (backup.sh, verify-restore.sh), .env.example, .trivyignore.
loadtest/   k6 guard scenarios (ban, breaker, baseline) + run.sh; k6 runs as a container, never as a dependency.
scripts/    check-image-pins.sh: the Postgres image tag in deploy/docker-compose.yml is authoritative; CI fails if any other site drifts.
docs/       security-events.md (sec.* taxonomy), loadtest.md, supply-chain.md, perf/probe notes.
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
pnpm --filter extension build:chrome          # extension zip (also build:firefox)
pnpm --filter extension test:smoke            # Playwright: overlay/driver in fixture pages + built Chrome extension (run build:chrome first)
pnpm --filter server db:migrate               # migrations
pnpm --filter server db:seed                  # bootstrap admin + accounts via one-time links
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml run --rm backup run   # ad-hoc backup (nightly otherwise)
deploy/backup/verify-restore.sh               # prove the latest backup restores (scratch Postgres, sha256 check)
pnpm loadtest [ban|breaker|baseline]          # k6 guard scenarios against the dedicated loadtest compose project (not in CI)
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
12. **No secrets in git**: `.env` is ignored; keep `deploy/.env.example` current whenever config is added.

## Engineering conventions

- TypeScript strict, ESM, Node 22 across the workspace. `shared/` contains no server-only or browser-only imports.
- `shared/` is the single source of truth for the annotation schema (versioned), API types, and constants (32,000 px height cap, `MAX_UPLOAD_MB`, capture tile pacing). Never re-declare a constant that exists there.
- **Renderer parity** (§10): any change to how a shape is drawn must touch both the Fabric renderer (`web/`) and the SVG renderer (`server/`) and update the golden fixtures — `pnpm test:parity` enforces this.
- Dependencies are attack surface: prefer the stdlib and Fastify ecosystem; a new runtime dependency needs a one-line justification in the PR description.
- Security-relevant changes ship with negative-path tests (403 / 404 / 409 / 429), not just happy paths.
- Fastify routes declare TypeBox schemas; unvalidated `req.body`/`query` never reaches a handler.

## Gotchas

- Chrome throttles `captureVisibleTab` to ~2 calls/sec — the full-page tile pacing (~600 ms) is a shared constant; don't "optimize" it away (§15).
- Full-page capture is intentionally two code paths: Firefox `tabs.captureTab({ rect })` natively, Chrome scroll-and-stitch (§15).
- Extension manifests are generated from templates in `extension/`; never hand-edit build output.
- Flat-render text resolves through fontconfig to the one font vendored at `shared/fonts/Inter-Regular.ttf` (`server/fontconfig/fonts.conf`, `FONTCONFIG_PATH`, and `PANGOCAIRO_BACKEND=fontconfig` — sharp's macOS pango otherwise uses CoreText and ignores fontconfig entirely). Removing any of these silently changes or breaks text in flat renders (§10).
- The 32,000 px height cap is shared between extension capture, server ingest validation, and the editor; changing it means revisiting browser canvas limits (§9, §15).
- Security-relevant log lines go through `logSecurityEvent()` with a `sec.*` tag; adding a tag without a row in `docs/security-events.md` fails a unit test. Purge, backup and guard logs name captures by internal id only.
- Roles are not in a `pg_dump`: any restore creates `st_app` before `pg_restore` (the dump keeps its grants) — `deploy/backup/verify-restore.sh` does exactly this and is the template.

## Maintaining this file

Keep the commands and layout here accurate — update them in the same PR that changes them. Keep this file short; design detail belongs in PLAN.md.
