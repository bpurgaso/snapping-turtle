# snapping-turtle — Enhancement prompt E9: link rotation + anti-enumeration hardening audit

Paste everything below this line into Claude Code, started from the repo root. File under `docs/prompts/`. Assumes E7/E8 are merged and main is green.

---

Read CLAUDE.md and PLAN.md before writing anything; PLAN.md wins on design, CLAUDE.md on process. First confirm the contract holds — full suite including the `cargo --locked` checks — and fix anything broken.

This session closes the residual gaps in the link-secrecy story. Context, decided: 160-bit capability URLs make guessing mathematically dead, so the live risks are **leakage** (a link that traveled) and **drift** (a new route or header change quietly weakening the posture the tests froze at merge time). Three work items answer those: a rotate-link feature (the missing remedy when a link leaks), an alerting hook on guard events (so enumeration attempts are heard, not discovered), and a re-verification sweep plus one-time route audit (so the posture is periodically re-proven against the live deployment). All server + web; no clients or extensions change.

## Item 1 — rotate link (the feature)

The owner regenerates a capture's `view_id`; the old URL dies into the uniform 404; annotations, crop, redactions, retention, and attribution are untouched. Decisions, made: **owner-only** (admins delete; they don't manage links — consistent with the annotation rule); **no redirect from old to new, ever** — the old link being dead *is* the feature; the new id comes from the same 20-byte CSPRNG path as the original.

1. **API + UI:** `POST /api/v1/captures/:viewId/rotate` (session, owner-only, CSRF) returns the new `pageUrl`/`imageUrl`; the capture page gains a "Rotate link" action with a confirm step that states plainly what it does ("everyone with the current link loses access — including anywhere you've already posted it") and surfaces the new link with a copy button on success.
2. **The old id joins the uniform 404, provably:** extend the lifecycle equality test with the rotated-away state — byte-identical to never-existed on both the page and image routes. Rotated-away lookups count against the guard's invalid-lookup budget like any other miss (no special case).
3. **No stale artifact survives at the old id:** audit how the flat-render cache and any other on-disk or in-memory artifact is keyed — if anything is keyed by `view_id`, rotation must move or invalidate it so the old path serves nothing and the new path doesn't re-render needlessly. Test: annotate → cache a flat → rotate → old image URL is the uniform 404, new image URL serves the identical bytes without a re-render (or with one, if re-keying is the cleaner implementation — say which).
4. **Authz matrix:** anonymous, non-owner, and admin all refused per the existing posture; stale-`rev` concerns don't apply (rotation doesn't touch the annotation document), but a concurrent editor session on the old URL should fail safe — document what happens (autosave 404s → editor surfaces "link was rotated," or the minimal honest equivalent).
5. **Docs:** PLAN.md §6 gains rotation (and the §6 "separately rotatable image-only token" future note stays in §17 — this is page+image rotation as one unit); §7 the page action; README's sharing section gains one line: "if a link leaked, rotate it."

## Item 2 — guard alerting (hear the attack)

The `sec.*` event taxonomy exists in the pino stream; at friends-scale there's deliberately no monitoring stack, so the alert channel is a **configurable outbound webhook** — `ALERT_WEBHOOK_URL` in `.env.example` (a Discord webhook is the expected shape; unset = feature off, the default).

6. **Fires on the loud events only** — `sec.ban.created`, `sec.breaker.opened` (and `closed`, for the all-clear) — never on routine throttles, with its own rate limit (e.g., at most one message per event class per 10 minutes, coalescing counts) so an attack can't turn the alerter into an outbound flood.
7. **Payload is minimal and secret-free:** event class, counts, timestamps, and at most a truncated IP prefix — the webhook endpoint is a third party, so rule 3 applies to it with extra force; a unit test asserts the payload against a deny-list (no full IPs, no tokens, no view_ids). Webhook failures are logged and never block or delay the guard itself — alerting is an observer, not a dependency.
8. **Admin panel note:** the guard status view mentions whether alerting is configured, so the owner can tell at a glance.

## Item 3 — re-verification sweep + one-time route audit

9. **`scripts/verify-live.sh` — an external, read-only posture probe** runnable against the production origin: asserts the uniform-404 equality from outside (two invalid `/s/` ids, byte-identical bodies and headers modulo `Date`), the secret-page header set on `/s/*`, the *absence* of those headers on the public pages (`/`, `/privacy`, `/ext/updates.json`), `robots.txt` current, and TLS/HSTS sanity. **Design constraint: the script must stay under the guard's invalid-lookup budget by construction** (≤3 invalid probes, counted in a comment against the configured budget) — and its header text warns that running it twice within the window can ban your IP, with the admin unban as the recovery. Verified in this session against the local compose stack.
10. **One-time audit, this session:** sweep every route added since M5 — home page, `/ext/*`, `/privacy`, `/reset/*`, the OG-tagged `/s/` pages, `/ext/firefox-latest` — against the §6 posture: correct header scoping, no new discovery surface (nothing lists, links, or patterns toward secret URLs), robots coverage, and no secret-bearing URL ever appearing in a log at full length. Findings and fixes (or "clean") go in the closing summary.
11. **The habit lands in the docs:** the deployment checklist's quarterly item becomes concrete — run `verify-live.sh` against production and the k6 enumeration scenarios against the loadtest profile; `docs/security-events.md` gains the webhook behavior; PLAN.md §12 records the leakage-over-guessing threat framing in a short paragraph so future features are evaluated against the right risk.

## Explicitly out of scope — do not start these

Separately rotatable image-only tokens, password-protected captures, per-viewer disclosure (§17); any monitoring/alerting stack beyond the webhook; proof-of-work or CAPTCHA on `/s/*`; changing guard thresholds (the k6 numbers own that conversation); any client or extension change.

## Working agreements for this session

- CLAUDE.md rules bind throughout — rule 2 (the rotated state must not create a new oracle) and rule 3 (the webhook payload, the verify script's output) are this session's pressure points, each with its test named above.
- Small, coherent commits; no new runtime dependencies are expected (the webhook is a bare fetch).
- Verification means running the command and showing output; what needs the live deployment (the first real `verify-live.sh` run, the webhook pointed at a real Discord channel) lands in the human handoff, never claimed.
- Finish with a closing summary: what was built, the route-audit findings table, verification outputs, and the handoff — deploy (compose rebuild), set `ALERT_WEBHOOK_URL` if desired, run `verify-live.sh` once from outside the network, and note the quarterly cadence now written into the checklist.
