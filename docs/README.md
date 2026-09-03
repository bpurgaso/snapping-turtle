# Documentation index

Where each document lives and which milestone produced it. PLAN.md is the
design authority; everything below is either a runbook, a measurement that
shaped a design decision, or a contract the code is held to.

## Start here

| Document                  | What it is                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md) | What snapping-turtle is; fresh deploy from DNS to first capture; onboarding; day-2 operations; commands                                       |
| [PLAN.md](../PLAN.md)     | The design document (v0.11): decisions, architecture, data model, security design, per-milestone implementation notes, deferred backlog (§17) |
| [CLAUDE.md](../CLAUDE.md) | Working rules for changes: security invariants, conventions, gotchas                                                                          |

## Operating a deployment

| Document                                                     | Milestone      | What it covers                                                                                                                                                                               |
| ------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [deploy/README.md](../deploy/README.md)                      | M0, M5, M7, M8, v0.12, E2 | Production and local (internal CA) deployment; TLS via ACME DNS-01 on the single published port (least-privilege Cloudflare token, grey-cloud record, renewal, provider swap, what the port is not); backups and verified restore; restoring for real; the Postgres image pin and major-version upgrades; extension distribution (`/ext/firefox-latest`, `CHROME_EXTENSION_URL`) |
| [runbooks/domain-migration.md](runbooks/domain-migration.md) | M8, v0.12      | Moving to a new hostname: DNS + token precondition, old-domain 308 on the same port, the one-variable change, extension rebuild/re-sign, redirect lifetime, rollback — rehearsed by `deploy/test-domain-migration.sh` |
| [security-events.md](security-events.md)                     | M7             | The `sec.*` log taxonomy: every security-relevant event the app emits, its level and fields (a unit test holds the code to this table)                                                       |
| [loadtest.md](loadtest.md)                                   | M7             | k6 guard scenarios (single-IP ban, distributed breaker + recovery, viewer baseline) and their measured results                                                                               |
| [supply-chain.md](supply-chain.md)                           | M7, M8         | `pnpm audit` gate and reviewed exceptions, Trivy image scans (app, backup, the xcaddy Caddy build), Dependabot grouping and ignore policy, pins                                                                                    |
| [deploy/caddy.d/README.md](../deploy/caddy.d/README.md)      | M8             | Extra Caddy site blocks (the old-domain redirect)                                                                                                                                            |
| [deploy/ext/README.md](../deploy/ext/README.md)              | M8, E2         | The `/ext/` directory: signed Firefox `.xpi` + `updates.json`, the stable `firefox-latest` redirect                                                                                                                              |

## Shipping the extension

| Document                                                          | Milestone | What it covers                                                                                                                                                          |
| ----------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [extension/STORE_SUBMISSION.md](../extension/STORE_SUBMISSION.md) | M8, E2    | Chrome Web Store unlisted listing (copy, permission justifications, data-use disclosure, privacy policy text) and AMO signing + self-distribution, as a human checklist |
| [extension/TESTING.md](../extension/TESTING.md)                   | M2, M6    | What automation covers and the manual checklist for what needs a real browser gesture (capture), per browser                                                            |
| [firefox-capturetab-probe.md](firefox-capturetab-probe.md)        | M6        | Measured `tabs.captureTab({ rect, scale })` semantics that the Firefox full-page path is built on                                                                       |

## Measurements behind design decisions

| Document                                                   | Milestone | Question answered                                                                                                                         |
| ---------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [perf-tall-canvas.md](perf-tall-canvas.md)                 | M3        | Is one Fabric.js canvas usable at the 32,000 px height cap, or is windowed rendering needed? (Usable; windowed stays a designed fallback) |
| [firefox-capturetab-probe.md](firefox-capturetab-probe.md) | M6        | How does Firefox scale and clamp `captureTab` rects? (Output = rect × scale; no clamp; we enforce the cap)                                |
| [loadtest.md](loadtest.md)                                 | M7        | Do the guard defaults trip and recover as designed under a real enumeration load? (Yes; no tuning needed)                                 |

## Contracts enforced by tests

- Annotation schema and validation outcomes: `shared/test/fixtures/annotation-corpus.ts` (105 documents, snapshotted across the TypeBox 1.x migration).
- Renderer parity: `pnpm test:parity` goldens under `web/test/` and `server/test/golden/` (PLAN.md §10 tolerances).
- Uniform 404 on `/s/*`: `server/test/unit/secret-404.test.ts` and the lifecycle equality test in `server/test/integration/purge.test.ts`.
- Security-event taxonomy ↔ `docs/security-events.md`: `server/test/unit/security-events.test.ts`.
- Postgres image pin: `scripts/check-image-pins.sh` (CI).
- Extension release hygiene: `extension/test/release-audit.test.ts` (the rules `build:release` applies) and the domain-migration rehearsal script.
- `PUBLIC_ORIGIN` carries the published port everywhere: `server/test/unit/config.test.ts` (the `PUBLIC_PORT` drift check), `server/test/integration/ported-origin.test.ts` (page, image, admin links), `server/test/integration/link-previews.test.ts` (E3: `og:url`/`og:image` with the port, hostile title escaped, headers coexisting, tagless uniform 404, no guard special-casing for a bot user agent), `extension/test/env.test.ts` + `firefox-updates.test.ts` + `manifest.test.ts` (baked default, `updates.json`, `update_url`).
