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
| CVE-2026-85393 (GHSA-86w9-cpqp-85rv)                                      | node-forge 1.4.0 (via web-ext → @devicefarmer/adbkit) | RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements. No patched release exists (1.4.0 is the latest; web-ext 10.7.0 still depends on adbkit 3.3.9 → node-forge ^1.3.1). adbkit is web-ext's Android device bridge, used only by `web-ext run --target firefox-android`, which nothing in this repo runs; web-ext is a dev dependency for `lint`/`sign:firefox` and is never part of the server image or the shipped extension, and no untrusted signature is ever verified through it. Recorded 2026-10-03 when the advisory turned the gate red on main (run 92). | A node-forge release above 1.4.0, or adbkit/web-ext dropping it; re-check when Dependabot bumps web-ext |

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
  rebuild picks up base-OS fixes without waiting for a new base tag. That
  only holds if the layer actually runs: every image's final stage is named
  `runtime` and `ci.yml` lists it in `no-cache-filters`, so the GitHub
  Actions build cache never serves the upgrade layer (a cached layer froze
  curl and util-linux at their pre-fix versions and kept main red from
  2026-09-06 until the filter was added). Locally, `docker compose build
  --no-cache` is the equivalent;
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

`.github/dependabot.yml`: weekly grouped PRs for npm (dev-tooling
minor/patch in one group, runtime minor/patch in another; majors arrive on
their own), GitHub Actions, the Dockerfiles' base images, the compose
images, and the Linux client's Cargo crates (minor/patch grouped). Every PR
runs the full CI contract. Major upgrades of Fabric.js,
sharp, argon2 and Fastify are excluded from automation — each is a deliberate
change with its own verification (renderer parity, native binaries, the HTTP
surface).

## Pins

- Caddy is built from an exact patch release with the rate-limit plugin
  pinned to a commit and the DNS-01 provider (`caddy-dns/cloudflare`)
  pinned to a tag (`deploy/Dockerfile.caddy`): the TLS terminator holds the
  zone API token and is the most exposed piece; neither module may float.
  The scanned image is that xcaddy build.
- Every action in `ci.yml` is pinned to a tag; Dependabot proposes bumps.
- k6 and Trivy run as containers at exact versions; neither is an npm
  dependency.
