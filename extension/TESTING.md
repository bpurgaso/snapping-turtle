# Extension manual test checklist (M2)

What automation covers and what a human must still do. Automated: `pnpm test`
(unit: origin validation, restricted-URL detection, response handling, manifest)
and `pnpm --filter extension test:smoke` (Playwright: built Chrome extension —
popup layout, options save round-trip, invalid origins, Test connection against
a stubbed and, with `ST_E2E_*`, a real server). Not automatable: anything that
needs the `activeTab` grant — the toolbar click or keyboard shortcut — because
Chrome's `captureVisibleTab` accepts only `activeTab` or `<all_urls>`, not a
specific host permission, and no synthetic input produces that gesture.

Status column: what the 2026-08-30 session ran, plus the human walk-through
the same day (both extensions connected via Test connection; a visible capture
uploaded and its page opened at the returned URL). **unverified** = nobody has
run it yet; do not treat it as passing.

## 0. Build and load

```sh
# dev server on http://localhost:3000 (see README quickstart A), then:
PUBLIC_ORIGIN=http://localhost:3000 pnpm --filter extension build   # both targets
```

- Chrome: `chrome://extensions` → Developer mode → Load unpacked → `extension/dist/chrome/`
- Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `extension/dist/firefox/manifest.json`

| #   | Check                                                                                                   | Chrome                                 | Firefox                           |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| 0.1 | Loads with no manifest errors/warnings (Chrome "Errors" button absent; Firefox console clean)           | verified (Playwright load, 2026-08-30) | verified (human, 2026-08-30)      |
| 0.2 | Toolbar icon shows the green turtle placeholder at 16/32 px                                             | unverified                             | unverified                        |
| 0.3 | The zip in `extension/dist/` is identical in content to the unpacked dir (built from the template only) | verified (build output inspected)      | verified (build output inspected) |

## 1. Options page

Open via popup → Settings, or the browser's extension settings. Get a token
from `<server>/account`.

| #    | Check                                                                                                                                                                                                                                        | Chrome                                   | Firefox                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| 1.1  | Server address is pre-filled with the build-time `PUBLIC_ORIGIN`; hint names it                                                                                                                                                              | verified (Playwright)                    | unverified                            |
| 1.2  | `http://shots.example.com` → rejected "must use https"; `shots.example.com` → "Not a valid URL"; `https://host/path` → "bare origin"; empty → prompt. Nothing saved (reload shows old values)                                                | verified (Playwright)                    | unverified                            |
| 1.3  | `http://localhost:3000` / `http://127.0.0.1:3000` accepted                                                                                                                                                                                   | verified (unit + e2e)                    | unverified                            |
| 1.3a | Firefox only: `dist/firefox/manifest.json` has `host_permissions: ["http://localhost/*"]` — no port. Firefox ignores ports in match patterns; with the port the grant silently matches nothing and every request fails as "Could not reach…" | n/a                                      | verified (found and fixed 2026-08-30) |
| 1.4  | Save with a valid token → "Saved. Captures will upload to …". Token survives reload; `about:debugging`/DevTools shows it under `storage.local` only, `storage.sync` empty                                                                    | verified (Playwright, storage inspected) | verified (human, 2026-08-30)          |
| 1.5  | Firefox only: first Save/Test for the **default** origin prompts for host permission once (MV3 host permissions are optional in Firefox); Chrome does not prompt for the default                                                             | n/a (verified no prompt)                 | verified (human, 2026-08-30)          |
| 1.6  | Test connection with a live token → "Connected: the server accepted this token." and `last_used_at` moves on `/account`                                                                                                                      | verified (real server e2e + human)       | verified (human, 2026-08-30)          |
| 1.7  | Test connection with a revoked/garbled token → "The server rejected this token…"                                                                                                                                                             | verified (real server e2e)               | unverified                            |
| 1.8  | Test connection with the server stopped → "Could not reach …" (no token in the message)                                                                                                                                                      | unverified                               | unverified                            |
| 1.9  | "Show token" toggles the field between password and text                                                                                                                                                                                     | unverified                               | unverified                            |

## 2. Visible capture (needs a real gesture)

Open any normal https page (e.g. the server's own `/login`).

| #   | Check                                                                                                                                                                                                          | Chrome                                     | Firefox                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------- |
| 2.1 | Popup shows Visible / Region / Full page; Region and Full page disabled with "coming in M6"; Visible enabled                                                                                                   | verified (Playwright)                      | unverified                   |
| 2.2 | Click **Visible** → popup says "Capturing…" → a new tab opens next to the current one at `<server>/s/<27 chars>` showing the screenshot, the page title, and "Open original page" pointing at the captured URL | verified (human, 2026-08-30)               | verified (human, 2026-08-30) |
| 2.3 | The stored image matches the visible viewport (scrolled position, devicePixelRatio)                                                                                                                            | unverified                                 | unverified                   |
| 2.4 | Keyboard shortcut (default `Alt+Shift+S`; `chrome://extensions/shortcuts` / Firefox add-on manager → Manage Extension Shortcuts) does the same without the popup                                               | verified (human, 2026-08-30)               | verified (human, 2026-08-30) |
| 2.5 | Reopen the popup: **Visible** carries the "last used" outline (`aria-current`)                                                                                                                                 | unverified (storage write verified in e2e) | unverified                   |
| 2.6 | Owner attribution: on `/account` the token's last-used time updated; server log line `capture stored` carries `tokenId`, never the token                                                                       | unverified                                 | unverified                   |

## 3. Error paths

| #    | Check                                                                                                                                                                                                                                                                                                                                                      | Chrome                                            | Firefox                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| 3.1  | No token saved → clicking Visible opens the options page and shows a notification "Add your server address and API token…"; popup shows the same text                                                                                                                                                                                                      | verified (human, 2026-08-30)                      | verified (human, 2026-08-30)                      |
| 3.2  | Revoke the token on `/account`, capture again → notification "The server rejected the API token…" and the options page opens (401 path)                                                                                                                                                                                                                    | verified (human, 2026-08-30)                      | verified (human, 2026-08-30)                      |
| 3.3  | Stop the server, capture → notification "Could not reach http://localhost:3000…"                                                                                                                                                                                                                                                                           | verified via popup (human, 2026-08-30) — see 3.3a | verified via popup (human, 2026-08-30) — see 3.3a |
| 3.3a | **Known gap:** the same failure triggered by the keyboard shortcut is silent when the OS blocks the browser's notifications (macOS notification settings) — the shortcut path has no other channel; the popup path still shows the message inline. Candidate fix: badge `!` on the toolbar icon plus "last error" shown in the popup (no extra permission) | observed (human, 2026-08-30)                      | observed (human, 2026-08-30)                      |
| 3.4  | Restricted pages: `chrome://extensions`, `about:debugging`, `about:blank`, `view-source:`, a `file://` page, `chromewebstore.google.com`, `addons.mozilla.org` → popup opens with "Can't capture this page: …" and **all** buttons disabled; the shortcut on those pages produces the same message as a notification                                       | verified (human, 2026-08-30)                      | verified (human, 2026-08-30)                      |
| 3.5  | Neither the token nor a full `view_id` appears in any popup text, notification, or extension console output                                                                                                                                                                                                                                                | verified by inspection + unit tests               | unverified                                        |

## 4. Custom domain flow

Build with the default (`https://shots.example.com`) or any origin other than the one you will enter.

| #   | Check                                                                                                                                                                                                               | Chrome     | Firefox    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 4.1 | Enter a different **https** origin, Save → browser prompts for access to exactly that origin (not `<all_urls>`)                                                                                                     | unverified | unverified |
| 4.2 | Deny → "Access to … was not granted, so nothing was saved…"; reload shows the previous values                                                                                                                       | unverified | unverified |
| 4.3 | Allow → saved; Test connection and capture work against the new origin                                                                                                                                              | unverified | unverified |
| 4.4 | Enter a plain-http origin that is not the build default (e.g. `http://localhost:3000` on a default build) → Chrome refuses the runtime request; the message explains to rebuild with `PUBLIC_ORIGIN`; nothing saved | unverified | unverified |

## Running the live-server Playwright checks yourself

```sh
PUBLIC_ORIGIN=http://localhost:3000 pnpm --filter extension build:chrome
ST_E2E_ORIGIN=http://localhost:3000 ST_E2E_TOKEN=st_… pnpm --filter extension test:smoke
```

Then rebuild without `PUBLIC_ORIGIN` before committing anything that depends on
`dist/` (it is git-ignored, so normally nothing does).
