# snapping-turtle — Dependency PR triage playbook (v2, reusable)

Paste everything below this line into Claude Code, started from the repo root. This is the recurring ritual for clearing `chore(deps)` batches — run it whenever they accumulate (the checklist says weekly). Commit this file over `docs/prompts/dependency-triage.md`; it supersedes the first edition, updated for the repo as it now is: polyglot (TS + Rust), pin-checked, golden-guarded, contract-pinned.

---

Read CLAUDE.md before acting; its invariants apply to CI changes too. Your task: investigate and resolve every currently open dependency PR — each on its own evidence, using `gh` (`pr list`, `pr view --json`, `pr checks`, `run view --log-failed`). Conclusions come from diffs, release notes, and logs — not from PR titles and not from this playbook's expectations.

## Hard rules — policy, not questions to investigate

- **Never merge a PR with failing checks**, and each PR must be green **post-rebase**, not merely at evaluation time — merging one PR forces rebases of the rest.
- **Never widen secret or token exposure to make Dependabot's context pass.** Its workflows run with a read-only token and no secrets by design; gate secret-dependent steps on the actor. No `pull_request_target` with a checkout of the PR head. No `continue-on-error`, no skipped jobs, no removed `-D warnings` — fixes that are concealment are forbidden.
- **A semver-major bump of stateful infrastructure is an operational migration, not a merge.** The Postgres ignore should prevent these appearing; if one slips through, close it citing the upgrade runbook (backup → restore into the new major → verify).
- **Contract surfaces don't move as side effects.** The TypeBox corpus and its pinned semantics (UTF-16 `maxLength`, sparse-array rejection) must reproduce exactly under any validation-adjacent bump — divergence is stop-and-report, per the 0.34→1.x migration precedent. Golden regeneration (parity or server goldens) is a deliberate act with the visual diff described in the PR — never a blind update to get green.
- **MSRV pressure moves the toolchain up, never the crate down:** if a cargo bump requires a newer rustc, bump `rust-toolchain.toml` deliberately in the PR branch. (Exception: the new crate version is itself broken — then the lockfile holds it and the note goes in the summary for next time.)
- Trivial accompanying config (a renamed input, a synced pin, a toolchain line) may be pushed to the PR branch. Anything larger becomes its own PR; dependency PRs don't smuggle refactors.

## Phase 1 — diagnose before touching anything

Is main green? If not, fix main first as its own small change — nothing else is interpretable until it is. Then map the batch: which PRs, which ecosystems, which checks fail. Batch-uniform failures indict the environment (main, or the Dependabot restricted context), not the bumps.

**Known patterns that look like failures but are the system working:**
- **A Postgres patch bump fails `check-image-pins` by design.** The compose pin is authoritative and Dependabot-visible; the check forces the other pinned sites (`ci.yml`'s service container, `verify-restore.sh`, and the rest it sweeps) to move in the same PR. Sync them on the PR branch, re-run, merge. Do not "fix" the check.
- **A cargo bump arriving without a lockfile change, or vice versa,** trips `--locked` — align `Cargo.toml`/`Cargo.lock` on the branch rather than loosening CI.

## Phase 2 — evaluate each PR on its merits

Read the diff and the embedded release notes (follow to upstream changelogs for anything major), then route by class:

- **CI actions** (grouped weekly): low risk once green. Config-coupling check stands: where an action reads a version also pinned in-repo, the in-repo pin (`packageManager`, `rust-toolchain.toml`) is authoritative — remove the duplicate from the workflow.
- **npm dev tooling:** low risk; full TS suite.
- **npm runtime dependencies** (server/web): highest TS scrutiny — dependencies are attack surface. Skim upstream changes for parsing, crypto, HTTP, or image handling; run the full suite including `test:integration`.
- **Render-adjacent** (sharp, Fabric, Playwright/Chromium, anything fontconfig- or librsvg-adjacent): additionally run `test:parity`. Rendering engines shift rasterization across versions — the repo has learned two platform-calibration lessons already (see CLAUDE.md gotchas) — so golden drift here is *plausible and legitimate*; regenerate deliberately per the hard rule, re-record tolerances, describe the diff.
- **Validation-adjacent** (TypeBox, the Fastify type provider, Ajv): the corpus reproduces exactly or it's stop-and-report.
- **Cargo** (`client-linux/`): `fmt --check`, `clippy -- -D warnings`, `test --locked`, plus the cross-component integration script for anything touching upload/TLS (reqwest, rustls) — and for portal/tray crates (ashpd, zbus, ksni, oo7), note plainly that desktop behavior can't be verified in CI: flag the relevant TESTING.md rows for the owner instead of claiming them.
- **Container images:** rebuild and Trivy-scan. The caddy image is a custom xcaddy build — bump via its Dockerfile pins and rescan (its last bump was Trivy-driven). Compose Postgres follows the Phase 1 pattern.
- **Audit-exception hygiene:** the documented exceptions (e.g., web-ext's) exist because fixes weren't available — a bump that fixes an excepted CVE must also *remove* the exception. The allowlist only shrinks or justifies itself; it never rots.
- **Security updates:** ungrouped and prompt by policy — take these first within the batch.

Merge sequentially, oldest first, `@dependabot rebase` the remainder after each merge, confirm green post-rebase before each merge.

## Phase 3 — keep future batches small

Verify `dependabot.yml` still matches reality: every ecosystem present in the repo is watched (github-actions, npm, docker, docker-compose, **cargo** — add it if the Rust workspace isn't covered yet), grouping is on for actions and dev-dependency minors, the Postgres ignores are intact (majors-only on docker-compose; docker ignores postgres entirely), and security updates remain ungrouped.

## Closing summary

One line per PR: number, ecosystem/class, key evidence consulted, action taken (merged / closed with reason / left open awaiting X), verification. Anything that resisted confident resolution stays open with a written note — an honest open PR beats a hopeful merge. Separately list: pushes to main, any golden or tolerance changes with their described diffs, any corpus interaction, any audit-exception removals, and any `dependabot.yml` changes. If the same manual sync (pins, toolchain) has now happened across multiple batches, propose the automation once rather than performing the ritual forever.
