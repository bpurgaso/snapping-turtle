# Runbook: moving snapping-turtle to a new domain

PLAN.md §14–15 made "one variable" a founding requirement: the whole
deployment derives from `PUBLIC_HOST`. This runbook is the full procedure
around that one change — DNS, the old-domain redirect, the extension — and
`deploy/test-domain-migration.sh` rehearses every step below against a
throwaway stack (run it before a real migration; it takes about two
minutes and proves the redirect preserves `/s/<id>?query` byte-for-byte).

Throughout: **OLD** is the current hostname (`PUBLIC_HOST` today), **NEW**
the one you are moving to. Nothing here touches the database or the image
volume — captures are keyed by `view_id`, not by hostname.

## 0. Preconditions

- **DNS:** an A/AAAA record for **NEW** pointing at the same box, already
  propagated (`dig +short NEW` returns the server's address from outside).
  Keep **OLD**'s record pointing here too — the redirect only works while it
  does.
- Ports 80 and 443 reachable from the internet for **NEW** as well: Caddy
  needs HTTP-01/TLS-ALPN to issue the new certificate.
- A fresh backup that restores: `docker compose -f deploy/docker-compose.yml run --rm backup run && deploy/backup/verify-restore.sh`.
- The extension's release inputs are pinned in `deploy/.env`: `EXTENSION_GECKO_ID`
  must **not** change (AMO ties the Firefox add-on to it; a new id is a new
  add-on that no installed copy would update to).
- Tell your users a maintenance window is coming: everyone is signed out (§5).

## 1. Add the old-domain redirect

```sh
cp deploy/caddy.d/old-domain.caddy.example deploy/caddy.d/old-domain.caddy
$EDITOR deploy/caddy.d/old-domain.caddy      # replace the hostname with OLD
```

The block is

```caddyfile
OLD {
	redir https://{$PUBLIC_HOST}{uri} 308
}
```

`{uri}` is path + query, so `https://OLD/s/<id>?x=1` becomes
`https://NEW/s/<id>?x=1`; `308` keeps the method for API clients (an
extension still pointed at OLD gets a 308 on upload rather than a silent
success on the wrong host). Caddy keeps **both** certificates live for as long
as the block exists.

## 2. Change the one variable and apply

```sh
sed -i.bak 's/^PUBLIC_HOST=.*/PUBLIC_HOST=NEW/' deploy/.env && rm deploy/.env.bak
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps        # wait for app: healthy
```

`up -d` recreates `caddy` (new `PUBLIC_HOST`, new `sites.d` file) and `app`
(new `PUBLIC_ORIGIN=https://NEW`). Caddy obtains the certificate for NEW on
first request; issuance takes a few seconds.

## 3. Verify

```sh
# new host serves; old host redirects, path and query intact
curl -sS -o /dev/null -w '%{http_code}\n' https://NEW/login                       # 200
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' 'https://OLD/s/<any id>?x=1'
#   → 308 https://NEW/s/<any id>?x=1
# a previously shared link resolves end to end
curl -sSL -o /dev/null -w '%{http_code} %{url_effective}\n' https://OLD/s/<a real id>
#   → 200 https://NEW/s/<a real id>
# the app mints new links on NEW (log in, upload, or check any new capture's URL)
docker compose -f deploy/docker-compose.yml logs --no-log-prefix app | grep -c permissive_trust   # 0
```

## 4. Rebuild, re-sign and republish the extension

The default server is baked into the extension at build time, so the shipped
builds still point at OLD (their uploads now get a 308, which the extension
does not follow — captures fail with a clear error until it is updated).

```sh
pnpm --filter extension build:release          # bakes https://NEW; audits for remnants
# Chrome: upload extension/dist/snapping-turtle-chrome-<version>.zip as a new
#         version in the Web Store developer dashboard (extension/STORE_SUBMISSION.md);
#         the store pushes it to installed copies.
# Firefox: bump extension/package.json version first (AMO refuses a re-used version),
WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… pnpm --filter extension sign:firefox
#         → deploy/ext/ gets the new .xpi and updates.json; installed copies
#           pick it up from https://NEW/ext/updates.json (the old build's
#           update_url is https://OLD/ext/updates.json — served through the
#           redirect, so the update still reaches them while the redirect lives).
curl -sS https://NEW/ext/updates.json | grep '"version"'
```

Users who never changed the server in the extension's options get the new
default with the update. Users who **did** set a custom origin keep it: they
open the extension options, enter `https://NEW`, and get the one-time host
permission prompt for the new origin (PLAN.md §15). Their API tokens are
unchanged — tokens belong to accounts, not hosts.

## 5. What users see

- **Everyone is signed out.** Session cookies are scoped to OLD; the browser
  will not send them to NEW (the rehearsal asserts `/api/v1/auth/me` on NEW
  is 401 with the old jar). Signing in on NEW creates a new session; nothing
  else changes.
- Shared `https://OLD/s/…` links keep working through the redirect — for as
  long as the redirect lives (next section).
- Bookmarked admin/account pages redirect too.

## 6. How long to keep the redirect — the owner's call

Shared links only survive while three things hold: the DNS record for OLD
still points here, you still control the OLD domain, and the block in
`deploy/caddy.d/` is still present. Remove any one and every link that was
ever shared under OLD dies, with the uniform 404 of a never-existed id — the
recipient cannot tell the difference, by design (§6).

- The floor is `RETENTION_MAX_DAYS_USER` (365 by default): any capture that
  was live at migration time may legitimately be viewed until it expires, so
  the redirect should outlive the longest retention a user could have set.
- Indefinite-retention captures (admin-only, `retention_until = NULL`) never
  expire. If any exist, either keep the redirect (and the OLD domain)
  **permanently**, or accept that those links break on the date you drop it —
  there is no third option, because the secret in the link is the only key
  and nothing can rewrite links that are already in other people's chat logs.
  `SELECT count(*) FROM captures WHERE retention_until IS NULL AND deleted_at IS NULL`
  tells you how many are at stake.

Write the decision and the planned date down where the next operator finds
them (this file, or `deploy/caddy.d/old-domain.caddy` itself). When the day
comes: delete the block, `docker compose up -d`, and let the OLD domain lapse.

## 7. Rollback

Reverse the two changes; nothing else was touched.

```sh
rm deploy/caddy.d/old-domain.caddy
sed -i.bak 's/^PUBLIC_HOST=.*/PUBLIC_HOST=OLD/' deploy/.env && rm deploy/.env.bak
docker compose -f deploy/docker-compose.yml up -d
curl -sS -o /dev/null -w '%{http_code}\n' https://OLD/login                        # 200
```

OLD's certificate is still in Caddy's storage, so there is no re-issuance
delay. Sessions created on NEW are lost (users sign in again on OLD). If an
extension build for NEW already shipped, ship one for OLD the same way —
or, if NEW's DNS is going away, leave a redirect block for NEW → OLD in
`deploy/caddy.d/` for the users who already updated.

## What the rehearsal proves

`deploy/test-domain-migration.sh` runs steps 1–3 and 7 against a dedicated
compose project (Caddy's internal CA, both names as container aliases, no
published ports), uploads a real capture on OLD first, and asserts: the
`308` Location for `/s/<id>?query` equals the new-host URL byte-for-byte;
following it serves the capture; the image route redirects likewise; both
TLS handshakes succeed; a bearer API call to OLD gets a 308; a new upload is
minted on NEW; the OLD session cookie is not accepted on NEW; and the
rollback serves the capture on OLD directly again. What it cannot rehearse
is public DNS and Let's Encrypt issuance — those are the preconditions in
step 0.
