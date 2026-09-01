# Supply-chain checks

Dependencies are attack surface (CLAUDE.md conventions; PLAN.md §12
"Operational"). Three checks run in CI on every push and pull request; none
of them can be skipped by a code path, only by a reviewed exception recorded
in the repo.

## 1. `pnpm audit --audit-level=high`

Fails the `checks` job on any HIGH or CRITICAL advisory in the lockfile,
development dependencies included (they run on developer machines and in the
image build). Two ways to clear a finding, in order of preference:

1. **Fix the graph.** Bump the dependency, or for a transitive one add a
   `pnpm.overrides` entry in the root `package.json`. Removing an optional
   subtree that we never exercise is also a fix — `"canvas": "-"` drops
   jsdom's optional `canvas` binding (and with it `node-pre-gyp` → an old
   `tar`), which nothing in this repo uses.
2. **Ignore with a reason.** `pnpm.auditConfig.ignoreCves` in the root
   `package.json`, and a row in the table below. Only when the vulnerable
   code path is provably unreachable here.

| CVE                                                                       | Package                                        | Why it is ignored                                                                                                                                                                                                                                                                                                               | Revisit                                                                                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CVE-2026-27013 (GHSA-hfvx-25r5-qc3w)                                      | fabric 6.9.1                                   | Stored XSS through `loadFromJSON()` → `toSVG()`. The editor never deserialises Fabric JSON (documents are our own validated schema, PLAN §9) and never calls `toSVG()`; rule 5 forbids `innerHTML` in `web/`, and CSP has no `unsafe-inline`.                                                                                   | Fabric 7 upgrade — a major with renderer-parity implications (PLAN §10), scheduled deliberately, not by Dependabot (`.github/dependabot.yml` ignores it) |
| CVE-2026-44311 (GHSA-w22m-hvvm-xmwx)                                      | fabric 6.9.1                                   | Same export path, `Gradient` colour stops; the editor uses no gradients.                                                                                                                                                                                                                                                        | Same as above                                                                                                                                            |
| CVE-2025-71329, CVE-2025-71330 (GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr) | image-size 2.0.2 (via web-ext → addons-linter) | Infinite loops on crafted ICNS/JXL/HEIF input. No patched release exists (2.0.2 is the latest). addons-linter only measures the icons in `extension/icons/` — files in this repo — during `build:release` / `sign:firefox`; nothing user-supplied ever reaches it, and it is never part of the server or the shipped extension. | An image-size release above 2.0.2, or addons-linter dropping it; re-check when Dependabot bumps web-ext                                                  |

Below-threshold advisories are reported but do not fail the build; at the
time of writing the only one is esbuild 0.18 inside `drizzle-kit`'s bundled
loader (development-server CORS, never run here).

## 2. Trivy image scans

The `docker` job builds the app, backup and Caddy images and scans each with
Trivy (`--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`, OS packages
and application dependencies). Findings without an upstream fix are
reported, not fatal — there is nothing to do about them but watch. Findings
_with_ a fix fail the build, because the fix is almost always mechanical:

- the Dockerfiles run `apt-get upgrade` / `apk upgrade` at build time, so a
  rebuild picks up base-OS fixes without waiting for a new base tag;
- the app runtime image drops npm/corepack/yarn (never used at runtime), the
  backup image drops `gosu` — both were pure CVE surface;
- Go-binary findings (Caddy) mean bumping `CADDY_VERSION` in
  `deploy/Dockerfile.caddy` to the next patch release.

Exceptions go in `deploy/.trivyignore`, one CVE per line with a dated reason
and a revisit condition. It is empty at the time of writing.

Run the same scan locally (no install needed):

```sh
docker compose -f deploy/docker-compose.yml build
for i in app backup caddy; do
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    aquasec/trivy:0.66.0 image --scanners vuln --severity HIGH,CRITICAL \
    --ignore-unfixed --ignorefile /dev/null "snapping-turtle/$i:local"
done
```

## 3. Dependabot

`.github/dependabot.yml`: weekly grouped PRs for npm (dev tooling in one
group, runtime minor/patch in another), GitHub Actions and the Dockerfiles'
base images. Every PR runs the full CI contract. Major upgrades of Fabric.js,
sharp, argon2 and Fastify are excluded from automation — each is a deliberate
change with its own verification (renderer parity, native binaries, the HTTP
surface).

## Pins

- Caddy is built from an exact patch release with the rate-limit plugin
  pinned to a commit (`deploy/Dockerfile.caddy`): the TLS terminator is the
  most exposed piece and must not float.
- Every action in `ci.yml` is pinned to a tag; Dependabot proposes bumps.
- k6 and Trivy run as containers at exact versions; neither is an npm
  dependency.
