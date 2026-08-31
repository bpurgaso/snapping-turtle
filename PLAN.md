# snapping-turtle — Implementation Plan (v0.5)

A self-hosted screenshot capture and sharing system: browser extensions (Chrome + Firefox) capture the current tab, upload it to a central server, and open an editor page at an unguessable URL. The owner can annotate with red/white arrows, rectangles, and text; anyone with the link can view the page, copy a flat rendered image link, and follow a link back to the original site. The server is designed defensively from day one: capability URLs with high entropy, aggressive anti-enumeration controls, attribution of every upload, admin audit logging, automated TLS, and a 30-day default retention policy.

This document is a working plan. Section 2 records the confirmed decisions; the only items still open are minor UX questions flagged at the end of that section. v0.4 records the M1 implementation notes (a `sessions` table, the exact auth/token routes, throttle keying, and what `image.png` serves before M4); v0.5 records the M2 extension notes (the `notifications` permission, Firefox 128 minimum, runtime host grants, the ping route, and why capture itself is manually tested).

---

## 1. Goals and non-goals

**In scope (v1):** visible-viewport, selected-region, and full-page capture from Chrome and Firefox; upload with attribution; secret shareable page per capture; owner-only annotation (rect / arrow / text, red with white outline, draggable and resizable); flat PNG rendering with a copyable direct link; link back to the capture's source page; accounts with an admin-controlled registration toggle; per-image retention (30-day default, owner-extendable, admin-indefinite); rate limiting + circuit breaker against URL enumeration; Docker deployment with automated Let's Encrypt TLS; single-variable domain migration.

**Explicit non-goals (v1):** video/GIF capture, teams/shared ownership, comments, mobile apps, multi-node scaling, S3/object storage, federation. These are listed in §17 as future options so nothing in v1 paints us into a corner.

## 2. Confirmed decisions

Everything below is settled (last updated 2026-08-30); the plan is written against these.

| Decision | Resolution |
|---|---|
| Capture modes | All three in v1 — visible viewport, region selection, full page (per-browser mechanics in §15) |
| Stack | TypeScript end-to-end (rationale in §4) |
| Uploads | Accounts only; the extension authenticates with a personal API token. The admin "registration enabled" toggle gates new signups, not whether auth is required — this is how "optional signups" and "every image attributable to a user" coexist |
| Scale | Single node for the admin plus a small circle of friends: local-disk storage, in-process guard counters, one Postgres |
| Max owner retention | Owners may extend to 365 days (admin-configurable ceiling); indefinite is admin-only |
| Password reset | Admin-assisted, one click from the admin panel via single-use set-password links — no email infrastructure (§11) |
| Extension distribution | Chrome Web Store (unlisted) + Firefox AMO self-distribution (signed .xpi) |
| Full-page size limits | ~32,000 physical px tall, 30 MB max upload (§15) |

Open questions that don't block the plan but should be decided during M1–M2: whether viewers need an abuse-report button, whether owners can hide the source-page link on sensitive captures (see §7), and whether Open Graph preview tags should be on secret pages (nicer sharing in chat apps, at the cost of preview bots fetching the URL the recipient pastes).

## 3. System architecture

Three deployable pieces plus a reverse proxy:

```
┌────────────────────┐   HTTPS    ┌─────────────────────────────────────────┐
│ Browser extension  │──upload──▶ │  Caddy (TLS, ACME, HTTP→HTTPS, limits)  │
│ (Chrome / Firefox) │            │        │ reverse_proxy                   │
└────────────────────┘            │        ▼                                 │
                                  │  app (Fastify, Node)                     │
┌────────────────────┐            │   ├── API (upload, annotations, auth,    │
│ Any viewer with a  │──view────▶ │   │    admin, retention)                 │
│ secret link        │            │   ├── Pages (viewer/editor, login,       │
└────────────────────┘            │   │    account, admin) — static Vite     │
                                  │   │    bundles + JSON API                │
                                  │   ├── Renderer (sharp: flat PNG)         │
                                  │   ├── Guard (bans, rate limits, breaker) │
                                  │   └── Jobs (retention purge, render GC)  │
                                  │        ▼                                 │
                                  │  PostgreSQL          image volume        │
                                  └─────────────────────────────────────────┘
```

**Capture flow:** the user picks a mode — visible, region, or full page — from the toolbar popup or a per-mode keyboard shortcut → the extension produces a PNG (per-mode mechanics in §15) → `POST /api/v1/captures` with bearer token, image blob, source URL, and page title → server validates, re-encodes, stores, creates DB row → returns `{ pageUrl }` → extension opens a new tab at `pageUrl`. The editor page is served by the server, not the extension, so the owner can return and edit from any signed-in browser.

**View flow:** `GET /s/{viewId}` renders the page. Non-owners get the current flat PNG plus the source link and copy buttons. The signed-in owner gets the interactive editor over the original image.

**Edit flow:** the editor mutates a local annotation document and autosaves via `PUT /api/v1/captures/{viewId}/annotations` (debounced ~800 ms, plus `sendBeacon` on unload). Each save bumps a revision counter, which invalidates the cached flat render.

## 4. Technology choices

**Server:** Node 22 + Fastify. Fastify gives schema-validated routes (TypeBox), sensible defaults, and mature plugins for cookies, CSRF, and static serving. **Database:** PostgreSQL 16 via Drizzle ORM (thin, SQL-transparent, easy to audit). SQLite would honestly survive this scale, but Postgres removes a class of write-concurrency questions around autosave and makes backup tooling boring. **Image processing:** `sharp` for ingest re-encoding and flat rendering. **Editor:** Fabric.js v6 — it ships selection handles, drag/scale transforms, and in-place text editing (`IText`), which covers "draggable, resizable, stretchable" with very little custom code. **Frontend build:** Vite, vanilla TypeScript (no framework needed for four pages). **Proxy/TLS:** Caddy 2 — automatic Let's Encrypt issuance and renewal with zero cron jobs, HSTS, and HTTP→HTTPS redirects in ~10 lines of config. **Passwords:** argon2id. **Logging:** pino structured JSON.

The extension, editor, and server share one package for the annotation schema and API types, which keeps the client renderer and the server-side flat renderer geometrically in lockstep (§9–10).

## 5. Data model

| Table | Key columns | Notes |
|---|---|---|
| `users` | id, username, password_hash, role (`user`/`admin`), disabled_at, created_at | First admin bootstrapped by a seed command reading env vars |
| `api_tokens` | id, user_id, name, token_hash (sha256), created_at, last_used_at, revoked_at | Plaintext shown once at creation; scoped to upload only |
| `captures` | id, view_id (unique, secret), owner_id, source_url, page_title, width, height, bytes, sha256, upload_ip, upload_token_id, created_at, retention_until (nullable = indefinite), deleted_at, annotations (jsonb), annotations_rev, flat_rev | `view_id` is the only public identifier; sha256 supports dedup checks and abuse tracking |
| `sessions` | token_hash (sha256, PK), user_id, created_at, expires_at, last_seen_at | Server-side browser sessions (added in M1): revocable on disable/reset; the cookie carries the random token, only its hash is stored |
| `settings` | key, value | e.g. `registration_enabled` — runtime-togglable by admin |
| `audit_log` | id, at, actor_user_id, action, target_type, target_id, detail (jsonb), ip | Append-only; the app role has no UPDATE/DELETE grant on it |
| `ip_bans` | ip_prefix, strikes, banned_until, reason, updated_at | Persisted so restarts don't amnesty an attacker |

Deleting a capture removes the image files immediately but leaves a tombstone row (owner, source_url, sha256, timestamps) for 90 days to support trust-and-safety follow-up; the purge job hard-deletes tombstones after that.

## 6. Identifiers and link secrecy

`view_id` is 20 bytes from a CSPRNG, base64url-encoded → 27 characters ≈ 160 bits of entropy. At an absurdly generous 10,000 guesses/second, expected time to find one valid ID among even a million stored images is ~10^30 years — enumeration is only feasible if we leak information, so the design focuses on not leaking:

- **Uniform not-found behavior.** Never-existed, expired, deleted, and taken-down IDs all return the identical generic 404 page, same headers, with small random latency jitter. No oracle distinguishes "expired" from "never existed."
- **No discovery surface.** No listing endpoints, no sitemap, `robots.txt` disallows `/s/`, and every secret route sends `X-Robots-Tag: noindex, nofollow`.
- **No referrer leakage.** Secret pages set `Referrer-Policy: no-referrer`, and the "open original page" link carries `rel="noopener noreferrer"` — otherwise clicking through to the source site would hand that site the secret URL.
- **No cache leakage.** Secret pages are `Cache-Control: private, no-store`; flat images are cacheable but only under their own secret path.

Routes: `GET /s/{viewId}` (page) and `GET /s/{viewId}/image.png` (flat render). Both derive from the one secret; a future enhancement is a separately rotatable image-only token if owners want to share the picture without the page. The image URL is part of the link contract from M1: until the renderer lands in M4 it serves the re-encoded original, and M4 changes only what the same URL returns. The uniform-404 rule applies to *every* path under `/s/` — malformed ids and unknown sub-paths included — with a random delay (`RATE_NOT_FOUND_JITTER_*`, default 30–150 ms).

## 7. The capture page

Every capture page shows, for all visitors: the annotated image (flat render for non-owners, live canvas for the owner), a prominent **"Open original page"** link to `source_url`, and two copy buttons — **copy page link** and **copy image link** (the flat PNG URL). For the owner it additionally shows the editor toolbar, a retention selector (30/90/180/365 days), and delete. Admins viewing any capture also see the **"Keep indefinitely"** checkbox (writes `retention_until = NULL`, audit-logged).

One flag worth deciding early: captures of internal tools will embed internal URLs in `source_url`, visible to anyone with the link. The spec requires the link be present, so v1 always shows it, but an owner-side "hide source link" toggle is cheap and may be worth adding.

## 8. HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/v1/captures` | Bearer token | Upload; returns `{ pageUrl, imageUrl }` |
| `GET /s/:viewId` | none | Viewer/editor page |
| `GET /s/:viewId/image.png` | none | Flat render (cached) |
| `GET/PUT /api/v1/captures/:viewId/annotations` | session (owner) | Load/save annotation doc; PUT requires matching `rev` |
| `PATCH /api/v1/captures/:viewId` | session (owner/admin) | Retention changes, delete |
| `POST /api/v1/auth/signup` | none (if enabled) | Gated by `registration_enabled` |
| `POST /api/v1/auth/login`, `/logout`; `GET /api/v1/auth/me` | — / session | Session cookie `st_session`: HttpOnly, Secure (when the origin is https), SameSite=Lax, signed; `/me` returns username, role and the CSRF token |
| `GET /reset/:token` → `POST /api/v1/auth/set-password` | valid single-use token | Set-password page for admin-issued setup/reset links (§11) |
| `GET/POST /api/v1/tokens`, `DELETE /api/v1/tokens/:id` | session | Manage extension API tokens (revoke = set `revoked_at`; rows are kept for attribution) |
| `GET /api/v1/ping` | Bearer token | 204 with no body; the extension's "Test connection" target (M2). Bumps the token's `last_used_at`; invalid/revoked tokens and disabled users get the same 401 as upload |
| `GET/POST /api/v1/admin/*` | session (admin) | Settings toggle, user create/disable, set-password link issuance, capture search by user, audit log view — every mutation audit-logged |
| `GET /healthz` | internal only | Compose healthcheck |

All state-changing browser routes require a CSRF token (double-submit) on top of SameSite: the token is an HMAC of the session, delivered in a readable `st_csrf` cookie and by `/me`, and must be echoed in `x-csrf-token`. Token-authenticated upload is exempt (no cookie ambient authority) and, conversely, never accepts a cookie as authentication. Upload is `multipart/form-data` with fields `image`, `sourceUrl`, `title` (names in `shared/` `CAPTURE_UPLOAD_FIELDS`).

## 9. Annotation editor

Fabric.js canvas sized to the image's native pixels, scaled to fit the viewport. Toolbar: select / rectangle / arrow / text / delete / undo-redo (in-memory undo stack).

- **Rectangle:** click-drag to draw at any size; afterwards fully draggable and stretchable via corner/edge handles.
- **Arrow:** click-drag from tail to head; rendered as a line + head with endpoint handles so either end can be repositioned (a custom two-handle control rather than Fabric's default bounding-box scale, which distorts arrowheads).
- **Text:** click to place an `IText` box; double-click to edit; draggable and resizable (font size scales).

**Red-with-white-outline styling** is done by double-stroking: each shape is drawn once in white at `strokeWidth + 4` and once in red on top (Fabric group), and text uses white stroke under red fill with `paintFirst: 'stroke'`. The same trick is reproduced verbatim in the server renderer so both outputs match.

**Persistence format** is our own JSON (not Fabric's serialization, which would couple the server to a library version):

```json
{ "version": 1, "rev": 12, "shapes": [
  { "id": "a1", "type": "rect",  "x": 120, "y": 80, "w": 300, "h": 140 },
  { "id": "a2", "type": "arrow", "x1": 40, "y1": 400, "x2": 210, "y2": 260 },
  { "id": "a3", "type": "text",  "x": 500, "y": 60, "text": "look here", "fontSize": 28 }
] }
```

Server-side validation caps the document: ≤ 500 shapes, text ≤ 2,000 chars/shape, coordinates within image bounds ± margin, control characters stripped. `PUT` with a stale `rev` returns 409 and the editor reloads (last-writer-wins across the owner's own tabs is acceptable for v1). Text is treated strictly as data — rendered via `textContent` in the DOM and escaped into SVG on the server — never interpolated as markup.

Full-page captures make the canvas tall. A single Fabric canvas up to the ~32,000 px cap is workable on desktop, but M3 includes a performance spike on the tallest fixtures; if interaction lags, the fallback is windowed rendering — only the visible slice of the image is on canvas, while annotations live in image coordinates throughout, so nothing else changes.

## 10. Flat image rendering

`GET /s/:viewId/image.png` serves a cached composite when `flat_rev == annotations_rev`; otherwise it renders: build an SVG overlay from the annotation JSON (white-under-red double strokes; text via `<text>` with `paint-order: stroke`), then `sharp(original).composite([overlay]).png()` and cache to disk. The Docker image bundles `fontconfig` plus one pinned font (e.g. Inter) so librsvg text rendering is deterministic across rebuilds. A golden-file test renders a fixture annotation set on both the Fabric canvas (via Playwright) and the server path and diffs them within a pixel tolerance, guarding parity as either side is upgraded. Renders happen in a small worker queue (concurrency ~2) so a burst of viewers can't turn image rendering into a CPU-exhaustion vector.

## 11. Accounts, ownership, admin

Username + password (argon2id), session cookies, per-account login throttling with exponential backoff on failures (in-process, keyed by the *attempted* username whether or not it exists, so the throttle reveals nothing about which accounts are real; `LOGIN_THROTTLE_*` knobs, defaults in `shared/`). Signup page exists at `/signup` but returns "registration is closed" unless the admin has enabled it — the toggle lives in `settings`, changeable at runtime from the admin panel, and both states of the toggle are audit-logged. Users generate extension tokens on an account page; tokens are stored hashed, revocable, and record last-use. Every capture stores owner, token used, and upload IP, satisfying full attribution.

Because registration will usually stay disabled in a friends-only deployment, the admin panel covers the whole account lifecycle with one mechanism: **single-use links**. *Create user* takes a username and returns a one-time set-password URL the admin hands over any channel; *Reset password* on a user row issues the same kind of link for an existing account. Link tokens are 160-bit CSPRNG values stored hashed, expire after 24 hours, and are consumed on first use; completing a reset revokes the user's other sessions, and both issuance and completion land in the audit log. The admin never sees or chooses anyone's password, and `/reset/*` lookups count against the guard's invalid-lookup budget so the token space adds no enumeration surface. (Until the panel exists in M5, the bootstrap CLI creates accounts the same way.)

Admin panel capabilities, all writing to `audit_log`: registration toggle, list/disable/enable users, search captures by user, delete any capture, set per-capture indefinite retention, browse the audit log, and view current bans/breaker state. The audit table is append-only at the database-grant level, not just by convention.

## 12. Abuse resistance

Defense-in-depth, outermost first:

**Caddy layer:** request body limit (default 30 MB, matching `MAX_UPLOAD_MB` — sized for full-page retina captures), header/timeout limits, HSTS, TLS ≥ 1.2, and a coarse per-IP request rate cap to shed dumb floods before they reach Node.

**Application guard (the spec's rate limiter + circuit breaker):**

1. *Per-IP sliding windows* (keyed by IPv4 address or IPv6 /64): general unauthenticated cap (~60 req/min) and, separately, an **invalid-lookup budget** — more than 5 not-found hits on `/s/*` within 10 minutes trips a temporary ban.
2. *Escalating bans:* 15 min → 1 h → 24 h per strike, persisted in `ip_bans` so restarts don't reset them. A banned IP receives 429 for **all** `/s/*` routes — including valid links — for the duration, exactly per spec.
3. *Global circuit breaker:* if aggregate invalid-lookup rate across all IPs exceeds a threshold (e.g. 100/min — a distributed crawl signature), the breaker opens: anonymous `/s/*` traffic gets 429 + `Retry-After` for a cool-down, then half-open probes. Authenticated sessions keep working so real owners aren't collateral damage.
4. All trips and bans emit structured security events for the admin panel and logs.

**Upload pipeline hardening:** bearer-token required → magic-byte sniffing (PNG/JPEG only, never SVG) → decode with `sharp` under `limitInputPixels` plus explicit dimension caps (≈10,000 px wide, 32,000 px tall, ~150 MP total — decompression-bomb guard sized to admit the largest legitimate full-page capture, §15) → re-encode to PNG, which strips metadata and neutralizes polyglot files → write with server-chosen name. `source_url` must parse as `http(s)` and is length-capped; `page_title` is length-capped and escaped on output.

**Browser-facing hardening:** strict CSP (`default-src 'self'`; no `unsafe-inline`, no `unsafe-eval` — Vite is configured accordingly), `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and images served with correct `Content-Type` + `Content-Disposition: inline`. Re-encoding on ingest means stored images can't smuggle active content even if a browser mis-sniffed.

**Container hardening:** app image built distroless (or Alpine with no shell), runs non-root with `read_only: true` and a tmpfs for scratch; Postgres unexposed on an internal network; resource limits on every service; `no-new-privileges`; Trivy scan in CI. Secrets come from `.env` (never committed); session secret and DB password are generated at install.

**Operational:** nightly `pg_dump` + restic (or rsync) of the image volume to off-box storage; pino JSON logs with security events tagged for alerting; `npm audit`/Dependabot in CI.

## 13. Retention and lifecycle

`retention_until = created_at + RETENTION_DEFAULT_DAYS (30)` on upload. Owners can raise it up to `RETENTION_MAX_DAYS_USER (365)` from the capture page; admins can clear it (indefinite) via the checkbox. An hourly job deletes expired originals and flat renders, tombstones the rows (§5), and hard-deletes tombstones after 90 days. Expired links fall into the uniform-404 behavior of §6.

## 14. Deployment, TLS, configuration

`docker-compose.yml` with three services — `caddy` (ports 80/443; volumes for ACME state), `app`, `postgres` — plus named volumes for images and DB data, healthchecks, and `restart: unless-stopped`. Caddy's site block is literally `{$PUBLIC_HOST} { reverse_proxy app:3000 }`, which gives automatic Let's Encrypt issuance and renewal (port 80 stays open for HTTP-01 and redirects).

Key configuration (single `deploy/.env`, read by both compose and local `pnpm dev`; template in `deploy/.env.example`). Caddy's site address takes a bare hostname, so the file holds `PUBLIC_HOST` and everything else derives from it — that keeps domain migration a one-variable change (§15). When `PUBLIC_HOST` is `localhost` Caddy uses its internal CA automatically; `deploy/docker-compose.local.yml` forces `tls internal` for any other non-public name (M0 decision, see `deploy/README.md`):

| Variable | Default | Used by |
|---|---|---|
| `PUBLIC_HOST` | `shots.example.com` | The single domain knob: Caddy vhost/cert directly; compose derives `PUBLIC_ORIGIN=https://$PUBLIC_HOST` for the app, and the extension build reads `PUBLIC_ORIGIN` or falls back to `https://$PUBLIC_HOST` |
| `PUBLIC_ORIGIN` | derived | App absolute URLs, extension build default. Set explicitly only for local `pnpm dev` (e.g. `http://localhost:3000`) |
| `RETENTION_DEFAULT_DAYS` / `RETENTION_MAX_DAYS_USER` | 30 / 365 | app |
| `MAX_UPLOAD_MB` | 30 | Caddy + app |
| `RATE_*` knobs (windows, budgets, breaker threshold, not-found jitter) | sane defaults | guard |
| `SESSION_TTL_DAYS`, `LOGIN_THROTTLE_*` | 30; 5 free / 5 s base / 1 h cap | app (§11) |
| `IMAGES_DIR` | `<repo>/data/images`; compose sets `/data/images` | app image store (§12) |
| `DATABASE_URL`, `SESSION_SECRET` | generated at install | app |
| `ADMIN_BOOTSTRAP_USER` / `..._PASSWORD` | — | one-time seed command (`pnpm --filter server db:seed`, or `docker compose run --rm app node dist/db/seed.js`) |
| `TRUST_PROXY`, `LOG_LEVEL`, `HOST` / `PORT` | compose sets `TRUST_PROXY=true`; `info`; `0.0.0.0:3000` | app |

## 15. Extension design (Chrome + Firefox)

One TypeScript codebase, Manifest V3 on both browsers, built with Vite + `webextension-polyfill`. Chrome uses a background service worker; Firefox uses a non-persistent event page — a build step emits `manifest.chrome.json` / `manifest.firefox.json` from a shared template, which is the only per-browser difference.

**Permissions (deliberately minimal):** `activeTab` (grants capture and injection rights on the invoked tab without `<all_urls>`), `scripting` (injects the region-select overlay and the full-page scroll driver), `storage`, `notifications` (the only way to report an upload failure once the popup has closed or when the trigger was a shortcut — added in M2), plus a `host_permissions` entry for the build-time default server and `optional_host_permissions: ["https://*/*"]` so pointing the extension at a new domain triggers a one-time permission prompt for just that origin. Restricted pages (`chrome://`, `about:`, extension pages, the extension stores, and anything without an http(s) address, which the server would refuse as `source_url` anyway) can't be captured or injected; the popup detects this up front, disables capture and says why.

*M2 findings that shape the above:* Chrome's `captureVisibleTab` accepts only `activeTab` or `<all_urls>` — a specific host permission is not sufficient — so capture always rides on the toolbar/shortcut gesture and cannot be driven by automation without one (see `extension/TESTING.md`). Firefox treats every MV3 host permission as optional (not granted at install), and supports `optional_host_permissions` only from Firefox 128, which is therefore the minimum version; the options page requests the host permission for exactly the entered origin on Save and Test connection (Chrome grants the built-in default silently, Firefox prompts once, custom domains prompt on both). A denied request leaves the settings untouched. Because runtime grants are limited to `https://*/*`, a plain-http server can only ever be the build-time default (`PUBLIC_ORIGIN=http://localhost:3000` for local development). Firefox additionally ignores ports in match patterns (bugs 1362809/1468162 — the pattern is accepted, `permissions.request` succeeds, but nothing ever matches), so the Firefox manifest and its runtime permission requests use port-less host patterns (`http://localhost/*`), which in Firefox match every port on that host; Chrome keeps the exact origin with its port.

**Mode selection:** the toolbar button opens a three-button popup — Visible / Region / Full page — and each mode also gets its own configurable keyboard command. The popup highlights the last-used mode (`storage.local`). M2 ships the layout with Region and Full page disabled ("coming in M6") and declares only the `capture-visible` command (default `Alt+Shift+S`); M6 enables the buttons and adds the other two commands without changing the layout.

**Visible viewport:** `captureVisibleTab({format:"png"})` → blob → upload. This is the M2 walking skeleton. The flow runs in the background (service worker / event page), not the popup, so closing the popup never aborts an upload; the popup just relays the result while it is open.

**Region selection:** a content-script overlay dims the page and lets the user drag a rectangle (Esc cancels). The overlay returns the rect in CSS pixels plus `devicePixelRatio`; the background captures the visible tab once and crops via `createImageBitmap` + `OffscreenCanvas` (available in Chrome's service worker; Firefox event pages have a DOM canvas), so the stored image is exactly the selection.

**Full page — two strategies, because the browsers differ:**

- *Firefox:* `tabs.captureTab(tabId, { rect })` accepts page coordinates beyond the viewport, so the whole document is captured natively in one call — no scrolling, no stitching, no artifacts.
- *Chrome:* has no equivalent short of the `debugger` API (scary permission, store-review friction, an on-screen "being debugged" banner), so Chrome scroll-and-stitches: a content script measures the document, scrolls in viewport-height steps, and the background captures each tile onto an `OffscreenCanvas`. Known hazards and their mitigations: Chrome throttles `captureVisibleTab` to roughly 2 calls/sec, so tiles are paced ~600 ms apart, which also gives lazy-loaded content time to settle; `position: fixed`/`sticky` elements would repeat in every tile, so after the first tile the driver temporarily sets them `visibility: hidden` and restores them afterward; all geometry is scaled by `devicePixelRatio`.
- *Both:* capture height is capped at ~32,000 physical px (browser canvas limits and editor sanity — §9); a longer page yields the top slice plus a notice. Scroll position and any hidden-element tweaks are restored even on error, via a `finally` path in the driver.

**Upload + errors:** the produced PNG posts to `${server}/api/v1/captures` (multipart, fields from `shared/` `CAPTURE_UPLOAD_FIELDS`) with the bearer token and `{sourceUrl: tab.url, title: tab.title}`, `credentials: 'omit'` and no redirect following; the returned `pageUrl` (accepted only if it is an http(s) URL) opens in a new tab next to the source. Failures surface two ways, because a notification alone proved insufficient in M2 testing (macOS Focus / muted browser notifications swallow it silently, and on the keyboard-shortcut path there is no popup to fall back on): a browser notification, plus a red `!` badge on the toolbar icon with the message as its tooltip and the message stored as `lastError` in `storage.local`; the popup shows that stored error once on next open and clears badge and store, and a successful capture clears both as well (no extra permission — `action.setBadgeText`/`setTitle`). A 401 — or no token configured yet — additionally opens the options page. The token is read from `storage.local` for the request and never logged or echoed in any message.

**Options page:** server origin (pre-filled from `PUBLIC_ORIGIN` at build time; validation fails closed — bare http(s) origin only, https required except for `localhost` / `127.0.0.1` / `[::1]`), API token (stored in `storage.local`, deliberately *not* `storage.sync`, so the secret never transits sync infrastructure), and a "Test connection" button that calls `GET /api/v1/ping` (§8) with the bearer token: 204 → connected, 401 → token rejected, otherwise the transport error, never the token.

**Domain migration** is therefore: change `PUBLIC_ORIGIN` in `.env` → `docker compose up -d` (Caddy obtains the new cert) → rebuild/republish the extension (new baked-in default). Keep the old domain in Caddy as a `redir 308` block for at least one retention window so previously shared links keep resolving; users who overrode the server in options just update one field.

## 16. Milestones

Rough sizes assume one experienced developer; store review time for the extensions is external to these estimates. Advanced capture is deliberately sequenced after the core loop is solid — visible-viewport capture unblocks everything else end-to-end.

| Phase | Deliverable | Size |
|---|---|---|
| M0 | Repo scaffold (pnpm workspaces: `server`, `web`, `extension`, `shared`), compose + Caddy TLS up, CI skeleton | 1–2 d |
| M1 | Server core: auth, registration toggle, API tokens, upload endpoint with hardened ingest, capture page (view-only), source link, retention default | 3–5 d |
| M2 | Extension walking skeleton: popup, visible-viewport capture, options page, working on both browsers | 2–3 d |
| M3 | Editor: rect/arrow/text with red/white styling, drag/stretch/resize, autosave with revisions, owner gating, tall-canvas perf spike | 4–6 d |
| M4 | Flat renderer + cache, copy-link UI, render parity test | 2–3 d |
| M5 | Guard layer (per-IP limits, escalating bans, global breaker), uniform 404s, security headers/CSP, audit log, admin panel incl. account lifecycle (create/reset one-time links) | 4–6 d |
| M6 | Advanced capture: region-select overlay; full page via Firefox `captureTab` rect and Chrome scroll-and-stitch (pacing, sticky handling, height caps) | 4–6 d |
| M7 | Retention purge + tombstones, backups, structured security logging, guard load test (k6) | 2–3 d |
| M8 | Store packaging (Web Store + AMO-signed xpi; addons-linter now requires `gecko.data_collection_permissions` for new listings), domain-migration runbook, README | 2–3 d |

**Testing throughout:** unit tests for ID entropy/encoding, annotation schema validation, and retention math; integration tests for the authorization matrix (non-owner PUT → 403, banned IP valid-link → 429, expired vs never-existed → identical bytes); the render parity golden test; and a k6 enumeration simulation proving the breaker trips and recovers.

## 17. Future considerations (deliberately deferred)

S3/object storage and Redis-backed guard state for multi-node; abuse-report button and takedown workflow; owner toggle to hide the source link; separately rotatable image-only tokens; invite codes; email + password reset; WebAuthn/2FA for admins; optional Open Graph previews.
