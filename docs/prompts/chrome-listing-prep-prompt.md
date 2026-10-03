# snapping-turtle — Prep prompt: live privacy page + Chrome listing screenshots

Paste everything below this line into Claude Code, started from the repo root. A utility session (like the triage playbook, not an E-number): everything the Chrome Web Store console will ask for that doesn't exist yet.

---

Read CLAUDE.md and PLAN.md before writing anything. First confirm the contract holds — full suite including the `cargo --locked` checks — and fix anything broken.

Two deliverables: the privacy policy becomes a live page at `/privacy`, and the store listing screenshots become generated, reproducible assets. No extension code changes; server + web plus scripts only.

## Item 1 — the privacy policy goes live, single-sourced

The drafted policy text currently lives inside `extension/STORE_SUBMISSION.md`. Once it's also a web page, two copies will drift — so single-source it:

1. **One canonical file** (e.g., `web/content/privacy.md`) holds the policy. The server renders it at `GET /privacy` — static, public, CSP-strict, standard headers (this is an ordinary public page, not a secret one: no `noindex`, no `no-store`; confirm the secret-page headers are scoped to `/s/*` and don't bleed here). STORE_SUBMISSION.md stops duplicating the text and instead references the live URL and the canonical file.
2. **Wording check, with owner sign-off:** the draft was written Chrome-first, but this is the *product's* policy — verify it honestly covers every client (both extensions and the Linux desktop client) by describing the system generically: captures, page titles, and source URLs go only to the user's own configured server; no third parties, no analytics. Any wording change is a **diff presented prominently in the closing summary for the owner's approval** — the owner certifies this text to Google, so no silent edits to it, ever.
3. **Linked where people look:** the E2 home page gains a footer link to `/privacy`.
4. **Migration dependency recorded:** the privacy URL embeds the domain and port, which makes store listings a domain-migration dependency — add "update the privacy-policy URL (and any origin-bearing fields) in the Chrome and AMO listings" as a step in `docs/runbooks/domain-migration.md`.
5. Tests: the route serves the rendered canonical content; a doc-rot-style check that the URL in STORE_SUBMISSION.md matches what the server actually serves.

## Item 2 — listing screenshots, generated not hand-made

Chrome requires at least one 1280×800 (or 640×400) screenshot before submission. Make them a build artifact, not a one-off:

6. **A scripted Playwright flow** (e.g., `pnpm --filter extension listing-shots` or a `scripts/` entry) that boots the dev server, seeds a demo capture from bundled fixture content, applies a few annotations through the API (an arrow, a rect, a text label — the red/white look is the product), and produces **at least two, ideally three** exact-1280×800 PNGs: the capture page as a viewer sees it; the editor mid-annotation with the toolbar visible; and the popup staged on a neutral backdrop. Demo content comes only from fixtures — nothing resembling real personal pages, names, or URLs.
7. **Committed and regenerable:** assets land in `extension/store-assets/` alongside the script, so every future listing update (E6's ship note already anticipates one) regenerates matching screenshots instead of screenshotting whatever was on someone's screen.
8. **The kit absorbs both items:** STORE_SUBMISSION.md's steps point at the assets directory, and its submission-record table gains rows for the privacy URL and the screenshot set used.

## Definition of done

Everything above, plus: full suite green; the closing summary contains the policy diff (or "no wording changes") for sign-off, the generated screenshots listed, and the deployment note — server + web compose rebuild puts `/privacy` live, after which the owner verifies `https://<host>:<port>/privacy` loads from outside the network before pasting it into the console.

## Explicitly out of scope

Rewriting policy substance beyond the all-clients generalization (owner's document); listing copy changes; promotional tiles and marquee images (optional in the console — note their specs in the kit, don't produce them); any extension code or manifest change.
