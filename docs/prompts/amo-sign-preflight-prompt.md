# snapping-turtle — Utility prompt: AMO version preflight for `sign:firefox`

Paste everything below this line into Claude Code, started from the repo root. Utility class, like the triage playbook. Motivated by a real incident: a second dev machine attempted to re-sign an already-published version.

---

Read CLAUDE.md before writing anything. First confirm the contract holds — full suite including the `cargo --locked` checks — and fix anything broken.

This session adds a preflight to Firefox signing: before any upload, compare the local version against what AMO has actually published, and refuse unless the local version is strictly greater. While in there, convert the two silent failure modes of cross-machine signing into loud, deliberate gates.

## Definition of done — verify each item by running it, not by assertion

1. **The preflight script** (e.g., `extension/scripts/amo-preflight.mjs`): runs automatically as the first step of `sign:firefox` and standalone as `pnpm --filter extension version:check` (added to CLAUDE.md's commands). It reads the local version from `extension/package.json` — the single source of truth, never a built manifest — and queries AMO's authenticated versions endpoint for `EXTENSION_GECKO_ID` using the existing `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`. The JWT is hand-rolled with Node's `crypto` (HMAC-SHA256, short expiry) — **no new dependencies**, runtime or dev, for a fifteen-line token.
2. **The refusal UX:** when local ≤ latest published, refuse with one clear message: local version, latest on AMO, and exactly what to do ("bump `version` in extension/package.json and commit").
3. **The 404 is the gecko-id gate — this is the prompt's real payload.** If AMO reports no add-on for the id, that means either a genuine first signing *or* `EXTENSION_GECKO_ID` differs from the one that published — and a mismatched id silently creates a brand-new add-on that no installed Firefox will ever update to. So a 404 never proceeds by default: it requires an explicit `--first-signing` flag (or interactive confirmation when a TTY), with the message spelling out both possibilities and telling the user to compare the id against the AMO Developer Hub before confirming.
4. **Failure semantics are fail-closed, cheaply justified:** signing needs AMO reachable anyway, so auth errors and network failures refuse with distinct messages rather than guessing. A `--skip-version-preflight` escape hatch exists for genuine AMO API weirdness, and announces itself loudly when used.
5. **Two soft warnings, non-gating:** (a) if the server's live `/ext/updates.json` (fetched from `PUBLIC_ORIGIN`) already lists a version ≥ local, warn — the publish pipeline may be ahead of this checkout; (b) if the git tree is dirty or HEAD isn't on the remote, warn about provenance — the original incident involved a signed artifact whose source was never pushed, and "what source produced the xpi" should stay answerable. Warnings print and continue; they never block.
6. **The decision logic is a pure function** — `{localVersion, amoResult, flags, tty}` in, `{action, message}` out — unit-tested against mocked responses for every branch above (greater/equal/lesser, 404 with and without the flag, auth error, network error, skip flag). No network in CI, where signing never runs and credentials don't exist.
7. **Rule 3 crosses into this script:** credentials and JWTs never appear in output, logs, or error messages — including on failures, where the temptation lives.
8. **Docs:** the signing section of the extension docs gains the preflight behavior, the flags, and a short "switching dev machines" checklist (pull first; `EXTENSION_GECKO_ID` and `PUBLIC_ORIGIN` byte-identical to the originals; then `version:check` tells you where you stand).
9. **The contract holds:** full suite green; no dependency changes.

## Explicitly out of scope

Changing the release workflow's tag/version check (already exists); Chrome-side version checks (the Web Store console enforces increasing versions itself); any upload/publish behavior changes beyond the preflight gate; retry/backoff machinery around AMO.
