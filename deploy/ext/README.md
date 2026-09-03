# deploy/ext — self-distributed Firefox artifacts

The app serves this directory read-only at `https://$PUBLIC_HOST:$PUBLIC_PORT/ext/` (the port is part of every URL, PLAN.md §14)
(PLAN.md §15, M8): `updates.json` (the Firefox manifest's `update_url`) and
the signed `snapping-turtle-firefox-<version>.xpi` files it links to. Only
those two file shapes are reachable; there is no listing.

`pnpm --filter extension sign:firefox` writes here (override with
`EXT_PUBLISH_DIR`). Everything but this README is git-ignored: the .xpi files
are AMO-signed build output, not source. Nothing in here is secret — Firefox
verifies the signature and the sha256 recorded in `updates.json`.

Users install the extension once from the home page's **Install for
Firefox** button — `/ext/firefox-latest`, a redirect to the newest `.xpi`
named in `updates.json`, resolved on every request — and Firefox then checks
`updates.json` daily and installs newer versions on its own.
