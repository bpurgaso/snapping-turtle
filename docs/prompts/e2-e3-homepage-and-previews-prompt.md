# snapping-turtle — Enhancement prompt E2 + E3: install links on the home page, link previews for capture pages

Paste everything below this line into Claude Code, started from the repo root. File under `docs/prompts/` per the E-series convention.

---

Read CLAUDE.md and PLAN.md before writing anything; PLAN.md wins on design, CLAUDE.md on process. First confirm the contract holds — run the full suite (`pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:parity`) and fix anything broken.

This session ships two small enhancements, both server + web only (no extension change — if you believe one is needed, stop and say why):

- **E2:** the home page offers the Firefox extension for download and points Chrome users at the store listing once one exists.
- **E3:** capture-page links unfurl with their annotated image in Discord-style link previews. This graduates the Open Graph question formally deferred to PLAN.md §17 — the recorded trade-off stands: preview bots fetch a URL only when someone who already has it posts it, which is the sharer's choice and consistent with the capability model.

## Definition of done — verify each item by running it, not by assertion

### E2 — home page

1. **The home page becomes real:** name, one-line description, an install section, and a login link — CSP-strict as always (no inline script or style).
2. **Firefox install is a stable link, not a versioned one:** add `GET /ext/firefox-latest` — a redirect to the current xpi resolved from `updates.json` at request time, so the home page never rots as versions ship. When `updates.json` doesn't exist yet (fresh deploy, nothing published), the route 404s and the home page degrades gracefully — the Firefox section shows "not yet published" instead of a dead button. Tests cover both states.
3. **Chrome is a configurable direct link, not "search the store":** the listing will be **unlisted**, which store search cannot find — so add optional `CHROME_EXTENSION_URL` to `.env.example` and the PLAN.md §14 table. Unset → the Chrome section reads "coming soon"; set → an install button linking it. One env var flips it the day the listing is approved.
4. **Both sections always render;** light client-side UA-based emphasis (highlight the visitor's browser) is welcome but optional, and must not hide either option.

### E3 — link previews

5. **Meta tags on valid `/s/` pages only:** `og:title` (the capture's title), `og:type`, `og:url` (the canonical absolute page URL), `og:image` pointing at the flat PNG's absolute URL with `og:image:width`/`height` from the DB row and `og:image:type`, a modest `og:description` (e.g. "Annotated screenshot"), and `twitter:card=summary_large_image` for the large layout Discord prefers. Every absolute URL derives from `PUBLIC_ORIGIN`, so the port inherits automatically — add a test asserting the ported origin appears in the rendered tags.
6. **Escaping is proven, not assumed (CLAUDE.md rule 5):** the capture title is user-influenced content landing in HTML attributes — add a hostile-title fixture (quotes, angle brackets, ampersands) with assertions on the raw rendered HTML.
7. **The uniform 404 is untouched:** no meta tags on any not-found state; the byte-identical equality test across all lifecycle states still passes unmodified.
8. **No guard special-casing for preview bots — explicitly forbidden:** user agents are spoofable, so allowlisting Discordbot/Slackbot through the rate limits or bans would be a CLAUDE.md rule 9 bypass wearing a costume. Preview fetches of valid links are ordinary anonymous traffic; a bot that somehow trips a ban recovers when it expires.
9. **Existing header posture coexists:** `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, and `Cache-Control: private, no-store` all remain on `/s/` pages — an integration test asserts the meta tags and these headers appear together. (Preview crawlers fetch fresh and don't need caching; noindex governs indexing, not unfurling.)

### Both

10. **PLAN.md updated in the same change:** the OG item leaves §17 with its resolution and rationale recorded in §6/§7; §14 gains `CHROME_EXTENSION_URL`; note a per-capture preview opt-out in §17 as a possible future refinement — do not build it now.
11. **The contract holds:** full suite green.

## Explicitly out of scope — do not start these

The hide-source-link toggle and abuse-report button (still §17); per-capture OG opt-out (noted, not built); publishing the Chrome listing (owner's task); any change to the guard, headers, or 404 behavior beyond the coexistence tests above.

## Working agreements for this session

- CLAUDE.md rules bind throughout — rules 5 and 9 are the ones this session brushes against, and both are called out above.
- Small, coherent commits; no new runtime dependencies are expected.
- Verification means running the command and showing output; anything unverifiable in this environment is marked unverified, not claimed.
- Finish with a closing summary: what changed, verification outputs, and the human handoff — deploy (compose rebuild), post a capture link in a real Discord channel to confirm the unfurl (this cannot be verified in-environment; note that Discord handles nonstandard ports, but other platforms' crawlers vary — Discord is the verified target), and set `CHROME_EXTENSION_URL` whenever the store listing goes live.
