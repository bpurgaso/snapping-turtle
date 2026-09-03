# Extension manual test checklist (M2 + M6 + E1)

What automation covers and what a human must still do.

**Automated.** `pnpm test` (unit: origin validation, restricted-URL detection,
response handling, manifest, and since M6 the capture geometry — tile plan,
last-tile crop, height cap, dpr scaling, region crop — the stitch orchestrator
against fakes, the capture lock and the content protocol guards).
`pnpm --filter extension test:smoke` runs two Playwright projects: **browser**
mounts the region overlay and the full-page driver in plain fixture pages
(drag → rect, Esc, click-keeps-overlay, 2× dpr, pixel-identical page after
removal, hostile-CSS isolation in a closed shadow root, fixed/sticky finder
and hide/restore, quirks-mode and lazy-load measurement, restore when a
mid-capture step throws); **smoke** loads the built Chrome extension — popup
layout, options save round-trip, invalid origins, Test connection against a
stubbed and, with `ST_E2E_*`, a real server, and (M6) the content script
answering the driver protocol in a real content script, a region drag whose
result reaches the background, and a full-page request that injects, scrolls,
fails at the capture step, restores the page and reports on both channels.

**Not automatable.** Anything past the `activeTab` grant — the toolbar click
or keyboard shortcut — because Chrome's `captureVisibleTab` accepts only
`activeTab` or `<all_urls>`, not a specific host permission, and no synthetic
input produces that gesture. Every smoke test therefore stops exactly at the
first `captureVisibleTab`; the pixels of a real capture are checked below.
Firefox `captureTab` semantics were measured separately with a throwaway
probe (`docs/firefox-capturetab-probe.md`), not through the shipped extension.

Status column: what the 2026-08-30 session ran plus the human walk-through the
same day (M2 items), and what the 2026-08-31 session ran (M6 items).
**unverified** = nobody has run it yet; do not treat it as passing.

## 0. Build and load

```sh
# dev server on http://localhost:3000 (see README quickstart A), then:
PUBLIC_ORIGIN=http://localhost:3000 pnpm --filter extension build   # both targets
```

- Chrome: `chrome://extensions` → Developer mode → Load unpacked → `extension/dist/chrome/`
- Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `extension/dist/firefox/manifest.json`

| #   | Check                                                                                                           | Chrome                                 | Firefox                           |
| --- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| 0.1 | Loads with no manifest errors/warnings (Chrome "Errors" button absent; Firefox console clean)                   | verified (Playwright load, 2026-08-31) | unverified since M6 (M2: human)   |
| 0.2 | Toolbar icon shows the green turtle placeholder at 16/32 px                                                     | unverified                             | unverified                        |
| 0.3 | The zip in `extension/dist/` is identical in content to the unpacked dir (built from the template only)         | verified (build output inspected)      | verified (build output inspected) |
| 0.4 | M6: the built manifest declares three commands (`capture-visible/-region/-full`) and `content.js` is in the zip | verified (unit + build output)         | verified (build output)           |

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
| 2.1 | Popup shows Visible / Region / Full page, all enabled, each with a one-line hint (M6; the "coming in M6" hint is gone)                                                                                         | verified (Playwright, 2026-08-31)          | unverified                   |
| 2.2 | Click **Visible** → popup says "Capturing…" → a new tab opens next to the current one at `<server>/s/<27 chars>` showing the screenshot, the page title, and "Open original page" pointing at the captured URL | verified (human, 2026-08-30)               | verified (human, 2026-08-30) |
| 2.3 | The stored image matches the visible viewport (scrolled position, devicePixelRatio)                                                                                                                            | unverified                                 | unverified                   |
| 2.4 | Keyboard shortcut (default `Alt+Shift+S`; `chrome://extensions/shortcuts` / Firefox add-on manager → Manage Extension Shortcuts) does the same without the popup                                               | verified (human, 2026-08-30)               | verified (human, 2026-08-30) |
| 2.5 | Reopen the popup: the mode you used last carries the "last used" outline (`aria-current`) — try all three modes in turn, the outline follows                                                                   | unverified (storage write verified in e2e) | unverified                   |
| 2.6 | Owner attribution: on `/account` the token's last-used time updated; server log line `capture stored` carries `tokenId`, never the token                                                                       | unverified                                 | unverified                   |

## 3. Error paths

| #    | Check                                                                                                                                                                                                                                                                                                                | Chrome                                            | Firefox                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| 3.1  | No token saved → clicking any mode opens the options page and shows a notification "Add your server address and API token…"; popup shows the same text                                                                                                                                                               | verified (human, 2026-08-30; Visible only)        | verified (human, 2026-08-30; Visible only)        |
| 3.2  | Revoke the token on `/account`, capture again → notification "The server rejected the API token…" and the options page opens (401 path)                                                                                                                                                                              | verified (human, 2026-08-30)                      | verified (human, 2026-08-30)                      |
| 3.3  | Stop the server, capture → notification "Could not reach http://localhost:3000…"                                                                                                                                                                                                                                     | verified via popup (human, 2026-08-30) — see 3.3a | verified via popup (human, 2026-08-30) — see 3.3a |
| 3.3a | Shortcut path with OS notifications blocked (macOS Focus / browser muted): the failure still shows — a red `!` badge appears on the toolbar icon (hover shows the message); opening the popup shows "Last capture failed just now: …" once and clears the badge. A later successful capture also clears it           | verified (Playwright + human, 2026-08-30)         | verified (human, 2026-08-30)                      |
| 3.4  | Restricted pages: `chrome://extensions`, `about:debugging`, `about:blank`, `view-source:`, a `file://` page, `chromewebstore.google.com`, `addons.mozilla.org` → popup opens with "Can't capture this page: …" and **all** buttons disabled; the shortcut on those pages produces the same message as a notification | verified (human, 2026-08-30)                      | verified (human, 2026-08-30)                      |
| 3.5  | Neither the token nor a full `view_id` appears in any popup text, notification, or extension console output                                                                                                                                                                                                          | verified by inspection + unit tests               | unverified                                        |

## 4. Custom domain flow

Build with the default (`https://shots.example.com`) or any origin other than the one you will enter.

| #   | Check                                                                                                                                                                                                               | Chrome     | Firefox    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 4.1 | Enter a different **https** origin, Save → browser prompts for access to exactly that origin (not `<all_urls>`)                                                                                                     | unverified | unverified |
| 4.2 | Deny → "Access to … was not granted, so nothing was saved…"; reload shows the previous values                                                                                                                       | unverified | unverified |
| 4.3 | Allow → saved; Test connection and capture work against the new origin                                                                                                                                              | unverified | unverified |
| 4.4 | Enter a plain-http origin that is not the build default (e.g. `http://localhost:3000` on a default build) → Chrome refuses the runtime request; the message explains to rebuild with `PUBLIC_ORIGIN`; nothing saved | unverified | unverified |

## 5. Region capture (M6, needs a real gesture)

Open a normal https page with some visible structure (the server's `/login`
is fine). Default shortcut `Alt+Shift+R`.

| #   | Check                                                                                                                                                                                                                              | Chrome                                                     | Firefox    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------- |
| 5.1 | Click **Region** → popup closes at once; the page dims with a crosshair cursor and a top hint "Drag to select the area to capture · Esc to cancel"                                                                                 | overlay: verified (Playwright); via popup: unverified      | unverified |
| 5.2 | Drag → the dim lifts inside the rectangle, a `W × H` readout follows the corner; release → overlay disappears **before** the capture, a new tab opens with exactly the selected area (no dim, no outline, no readout in the image) | readout/removal: verified (Playwright); pixels: unverified | unverified |
| 5.3 | On a 2× display (or with browser zoom ≠ 100%) the stored image is `W×dpr` by `H×dpr` px and shows the same content as the selection (no offset, no half-size crop)                                                                 | dpr reported: verified (Playwright); pixels: unverified    | unverified |
| 5.4 | Esc before or during a drag → overlay gone, no upload, no notification, no `!` badge                                                                                                                                               | overlay: verified (Playwright); no-badge: unverified       | unverified |
| 5.5 | A plain click (no drag) keeps the overlay up; a second drag works                                                                                                                                                                  | verified (Playwright)                                      | unverified |
| 5.6 | Shortcut `Alt+Shift+R` does the same without the popup                                                                                                                                                                             | unverified                                                 | unverified |
| 5.7 | On a page with aggressive CSS (`* { display:none !important }`-style resets, huge z-indexes, `pointer-events: none`) the overlay still shows and drags; the page's own click handlers do not fire under it                         | verified (Playwright hostile-css fixture)                  | unverified |
| 5.8 | While a region selection is open, a second capture request (shortcut) is refused: notification "A region capture is already running…"; finishing or cancelling the selection frees it                                              | unverified                                                 | unverified |
| 5.9 | Chrome only: leave the overlay open for > 1 minute before dragging (the service worker may be recycled) → the capture still completes                                                                                              | unverified                                                 | n/a        |

## 6. Full-page capture (M6, needs a real gesture)

Default shortcut `Alt+Shift+F`. Firefox captures the whole document natively
in one call; Chrome scrolls and stitches with ~600 ms between tiles, so a
long page takes a visible while and the toolbar badge shows a percentage.

Suggested pages: a very long article (e.g. a long Wikipedia entry, ≥ 10
screens); a page with a **sticky/fixed header** (most news sites, GitHub);
an **infinite-scroll / lazy-loading** page (a social feed, an image-heavy
blog); the server's own `/s/<id>` page of a previous tall capture.

| #    | Check                                                                                                                                                                                                                                                                                                  | Chrome                                                                                      | Firefox                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 6.1  | **Long page** (≥ 10 screens): click **Full page** → popup closes; Chrome: page scrolls to the top and steps down, badge counts `3%…100%`; then a tab opens with the whole page, no gaps, no repeated bands, no duplicated strip at the bottom                                                          | stitch geometry: verified (unit); pipeline to gesture: verified (smoke); pixels: unverified | unverified                                                                           |
| 6.2  | Afterwards the page is scrolled back to where it was                                                                                                                                                                                                                                                   | verified (Playwright driver + smoke)                                                        | n/a (no scrolling)                                                                   |
| 6.3  | **Sticky/fixed header page**: the header appears **once** at the top of the image, not in every tile; after capture the header is visible again on the page                                                                                                                                            | hide/restore: verified (Playwright); pixels: unverified                                     | unverified — Firefox renders fixed elements once at scroll 0 (`resetScrollPosition`) |
| 6.4  | **Lazy-loading page**: content that was loaded when you started is captured; content that only loads as you scroll may appear blank/placeholder at the bottom — the tile pacing gives it ~600 ms to settle. Scroll to the bottom first for a complete capture                                          | measurement: verified (Playwright); pixels: unverified                                      | unverified                                                                           |
| 6.5  | **Zoomed page** (Ctrl/Cmd + a few times, or a 2× display): image width is `clientWidth × dpr`, no right-edge scrollbar stripe, no seams between tiles                                                                                                                                                  | scale derivation: verified (unit); pixels: unverified                                       | unverified                                                                           |
| 6.6  | **Cancel mid-capture** (Chrome): press Esc on the page during the scroll → capture stops, notification "Full-page capture cancelled.", `!` badge, page scrolled back, header visible                                                                                                                   | cancel path: verified (unit); live: unverified                                              | n/a                                                                                  |
| 6.7  | **Tab switch mid-capture** (Chrome): switch tabs during the scroll → notification "Capture stopped: the tab was switched away mid-capture.", original tab restored                                                                                                                                     | abort path: verified (unit); live: unverified                                               | n/a                                                                                  |
| 6.8  | **Height cap**: a page taller than 32,000 physical px (16,000 CSS px on a 2× display — e.g. a very long changelog) → the capture page opens with the top slice **and** a notification "This page is taller than the 32,000 px limit, so the top 32,000 px were captured."                              | cap: verified (unit + Firefox probe); live: unverified                                      | unverified                                                                           |
| 6.9  | **Oversize warning**: a capture whose PNG exceeds `MAX_UPLOAD_MB` (30 MB — a 2× display at the height cap on a photo-heavy page gets there) → no upload attempt; notification "The capture is N MB, more than the 30 MB the server accepts. Capture a region of the part you need instead."; `!` badge | message: verified (unit); live: unverified                                                  | unverified                                                                           |
| 6.10 | **Busy lock**: trigger `Alt+Shift+F` twice quickly → the second is refused with "A full page capture is already running…"; the first completes normally, uncorrupted                                                                                                                                   | lock: verified (unit + smoke release); live: unverified                                     | unverified                                                                           |
| 6.11 | Shortcut `Alt+Shift+F` does the same without the popup                                                                                                                                                                                                                                                 | unverified                                                                                  | unverified                                                                           |
| 6.12 | Firefox only: `about:debugging` → Inspect → console shows no "captureTab rendered at …×" line (would mean the browser ignored `scale`; the capture is then cropped to the cap, not wrong, but tell PLAN.md)                                                                                            | n/a                                                                                         | unverified (probe: scale honoured on 154)                                            |
| 6.13 | A short page (shorter than the viewport) → full page equals a visible capture cropped to the document height                                                                                                                                                                                           | plan: verified (unit); pixels: unverified                                                   | unverified                                                                           |

## 7. Known limitations (documented, not bugs to file)

- **Inner scroll containers.** Only the window's scrolling element is driven.
  Pages whose scrollable content lives in an inner `overflow: auto` container
  (`html, body { height: 100%; overflow: hidden }` app shells, many SPAs)
  measure as one viewport and capture exactly that. Use Region or Visible on
  those pages. Scroll-container-aware stitching is deliberately out of M6.
- **Sticky elements below the first viewport** (Chrome stitch) are hidden from
  tile 2 onwards along with headers, so a sticky sidebar that first appears
  in section 5 is absent from the composite. Fixed/sticky elements inside
  **closed** shadow roots cannot be found and will repeat.
- **Lazy content** that loads only on scroll is captured at whatever state it
  reaches within the tile interval; infinite feeds capture the height measured
  when the run started.
- **Capture-phase page listeners** on `window`/`document` still observe pointer
  events under the region overlay (platform behaviour); bubble-phase listeners
  and element handlers do not.
- **Hostile pages** can still defeat the overlay with `html { transform }` or
  by moving `<html>` — nothing above the root can be protected against.
- **Chrome badge progress** is global to the toolbar icon, not per window.
- **Firefox floors (M8).** The manifest requires Firefox 140 (the 2025 ESR) and
  Firefox for Android 142 — the first releases that understand
  `data_collection_permissions`, which AMO requires. Android is declared
  compatible but nothing in this checklist has been run there: **unverified**.
- **Release builds** (`pnpm --filter extension build:release`) differ from the
  dev builds above only in inputs and audit: a real https origin baked in, a
  pinned `EXTENSION_GECKO_ID`, and a Firefox `update_url` pointing at the
  server's `/ext/updates.json`. Load them the same way for a final check
  before submitting (`extension/STORE_SUBMISSION.md`).

## 8. Annotation legibility across capture sizes (E1, needs a real gesture)

Annotation sizes scale with the capture's width (PLAN.md §9): a full-page
retina capture and a small region crop should both read comfortably. This
exercises server + web only; the extension is unchanged and simply produces
the two captures.

| #   | Check                                                                                                                                                                                                                                                                                   | Chrome     | Firefox    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 8.1 | **Full page**: on a 2× display capture a long page full-page (`Alt+Shift+F`; ≥ 2,500 px wide image). In the editor draw a rectangle, an arrow and a text; strokes look about as thick on screen as they do on an ordinary visible capture, and the default text is readable without zooming | unverified | unverified |
| 8.2 | **Region crop**: on the same page capture a ~300 px-wide region (`Alt+Shift+R`). Draw the same three shapes; strokes are thin (3 px) but crisp and the default text (21 px) fits the crop                                                                                                | unverified | unverified |
| 8.3 | **Logged-out view**: open both links in a private window. The full page shows fit-to-width and the annotations are legible at that zoom; the crop shows at natural size and the annotations are legible there. The flat image matches what the editor showed (same thickness, same text size) | unverified | unverified |
| 8.4 | Resize a text on the full-page capture with its corner handle, then reload as the owner and logged-out: the resized size is what was saved (absolute pixels), not the default                                                                                                          | unverified | unverified |
| 8.5 | Select an arrow on the full-page capture: the endpoint handles are the usual small circles on screen, not scaled with the image                                                                                                                                                      | unverified | unverified |

## Running the live-server Playwright checks yourself

```sh
PUBLIC_ORIGIN=http://localhost:3000 pnpm --filter extension build:chrome
ST_E2E_ORIGIN=http://localhost:3000 ST_E2E_TOKEN=st_… pnpm --filter extension test:smoke
```

Then rebuild without `PUBLIC_ORIGIN` before committing anything that depends on
`dist/` (it is git-ignored, so normally nothing does).
