#!/usr/bin/env bash
# Rehearse docs/runbooks/domain-migration.md end to end, locally, and prove
# the founding requirement: a domain migration is one variable, and every
# previously shared link keeps resolving through the old-domain redirect.
#
# The script brings up a dedicated compose project (fresh volumes, no
# published ports, Caddy's internal CA, both hostnames as container aliases
# so "DNS" for old and new point at one proxy), then:
#
#   1. deploys as OLD_HOST, seeds an admin, mints an API token and uploads a
#      capture — a real https://OLD_HOST/s/<id> link exists;
#   2. migrates exactly as the runbook says: add the old-domain redir 308
#      block, change PUBLIC_HOST, `docker compose up -d`;
#   3. asserts that the old link, with a query string, is answered with a 308
#      whose Location is the same path and query on NEW_HOST byte-for-byte,
#      that following it serves the capture, that the app now mints links on
#      the new host, and that both certificates are live;
#   4. rolls back (remove the block, restore PUBLIC_HOST, up -d) and asserts
#      the old host serves the capture directly again;
#   5. tears the project down with its volumes (KEEP=1 to leave it running).
#
#   deploy/test-domain-migration.sh            # reuse built images
#   REBUILD=1 deploy/test-domain-migration.sh  # rebuild app + caddy first
set -euo pipefail
cd "$(dirname "$0")/.."

OLD_HOST=${OLD_HOST:-old.shots.test}
NEW_HOST=${NEW_HOST:-new.shots.test}
PROJECT=snapping-turtle-migration
CURL_IMAGE=curlimages/curl:8.21.0
WORK=$(mktemp -d "${TMPDIR:-/tmp}/st-migration.XXXXXX")
mkdir -p "$WORK/sites.d"
ADMIN_USER=migration-admin
ADMIN_PASSWORD=migration-admin-password-not-secret

COMPOSE=(docker compose -p "$PROJECT" --env-file "$WORK/.env"
  -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml -f deploy/docker-compose.migration.yml)

pass=0
fail=0
ok() { echo "  PASS  $*"; pass=$((pass + 1)); }
ko() { echo "  FAIL  $*" >&2; fail=$((fail + 1)); }
assert_eq() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else ko "$1: expected [$2], got [$3]"; fi
}

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1: project $PROJECT left running; scratch dir $WORK kept"
  else
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# curl inside the project's web network, trusting the rehearsal CA.
# The scratch dir is mounted at /w (cookie jar, capture, CA).
curl_in() {
  docker run --rm --network "${PROJECT}_web" -v "$WORK:/w" "$CURL_IMAGE" \
    -sS --cacert /w/root.crt "$@"
}
json_field() { # field  (flat string fields only)
  sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

write_env() { # public_host
  cat >"$WORK/.env" <<EOF
PUBLIC_HOST=$1
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_DB_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -base64 48)
ADMIN_BOOTSTRAP_USER=$ADMIN_USER
ADMIN_BOOTSTRAP_PASSWORD=$ADMIN_PASSWORD
MIGRATION_OLD_HOST=$OLD_HOST
MIGRATION_NEW_HOST=$NEW_HOST
MIGRATION_SITES_DIR=$WORK/sites.d
EOF
}
set_public_host() { # public_host — the runbook's one-variable change
  sed -i.bak "s/^PUBLIC_HOST=.*/PUBLIC_HOST=$1/" "$WORK/.env" && rm -f "$WORK/.env.bak"
}

echo "== 0. dedicated project up as $OLD_HOST (fresh volumes)"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
write_env "$OLD_HOST"
up_args=(up -d --wait caddy app postgres)
[ "${REBUILD:-0}" = "1" ] && up_args=(up -d --build --wait caddy app postgres)
"${COMPOSE[@]}" "${up_args[@]}"
"${COMPOSE[@]}" run --rm --no-deps app node dist/db/seed.js >/dev/null
"${COMPOSE[@]}" cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/root.crt" >/dev/null
docker pull -q "$CURL_IMAGE" >/dev/null

# A small but real PNG for the upload (the server re-encodes it anyway).
python3 - "$WORK/capture.png" <<'PY'
import struct, sys, zlib
w, h = 120, 80
raw = b''.join(b'\x00' + bytes([200, 40 + (y % 200), 40]) * w for y in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
PY

echo "== 1. a capture shared from the old domain"
login=$(curl_in -c /w/jar -H 'content-type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" "https://$OLD_HOST/api/v1/auth/login")
csrf=$(printf '%s' "$login" | json_field csrfToken)
[ -n "$csrf" ] || { echo "login failed: $login" >&2; exit 1; }
token=$(curl_in -b /w/jar -H "x-csrf-token: $csrf" -H 'content-type: application/json' \
  -d '{"name":"migration-rehearsal"}' "https://$OLD_HOST/api/v1/tokens" | json_field token)
[ -n "$token" ] || { echo "token creation failed" >&2; exit 1; }
upload=$(curl_in -H "Authorization: Bearer $token" -F image=@/w/capture.png \
  -F sourceUrl=https://example.org/page -F title=Rehearsal "https://$OLD_HOST/api/v1/captures")
page_url=$(printf '%s' "$upload" | json_field pageUrl)
view_path=${page_url#https://$OLD_HOST}
case "$view_path" in /s/*) ;; *) echo "unexpected pageUrl: $upload" >&2; exit 1 ;; esac
echo "  shared link: https://$OLD_HOST${view_path:0:11}… (id truncated in output, CLAUDE.md rule 3)"
assert_eq "old link serves 200 before migration" 200 "$(curl_in -o /dev/null -w '%{http_code}' "$page_url")"
assert_eq "old image link serves image/png" image/png "$(curl_in -o /dev/null -w '%{content_type}' "$page_url/image.png")"

echo "== 2. migrate per the runbook: redirect block + PUBLIC_HOST + up -d"
cat >"$WORK/sites.d/old-domain.caddy" <<EOF
$OLD_HOST {
	tls internal
	redir https://{\$PUBLIC_HOST}{uri} 308
}
EOF
set_public_host "$NEW_HOST"
"${COMPOSE[@]}" up -d --wait caddy app postgres

echo "== 3. assertions"
query='?from=chat&x=1%202&y=%2Fz'
code_and_location=$(curl_in -o /dev/null -w '%{http_code} %{redirect_url}' "$page_url$query")
assert_eq "old /s/<id>?query → 308 to the identical path+query on the new host" \
  "308 https://$NEW_HOST$view_path$query" "$code_and_location"
assert_eq "old /s/<id>/image.png → 308 to the new host" \
  "308 https://$NEW_HOST$view_path/image.png" \
  "$(curl_in -o /dev/null -w '%{http_code} %{redirect_url}' "$page_url/image.png")"
assert_eq "following the redirect serves the capture page on the new host" \
  "200 https://$NEW_HOST$view_path" \
  "$(curl_in -L -o /dev/null -w '%{http_code} %{url_effective}' "$page_url")"
assert_eq "new host serves the image directly" image/png \
  "$(curl_in -o /dev/null -w '%{content_type}' "https://$NEW_HOST$view_path/image.png")"
assert_eq "a never-existed id still 404s uniformly on the new host" 404 \
  "$(curl_in -o /dev/null -w '%{http_code}' "https://$NEW_HOST/s/AAAAAAAAAAAAAAAAAAAAAAAAAAA")"
assert_eq "certificates are live for both names (TLS handshake ok)" "200 308" \
  "$(curl_in -o /dev/null -w '%{http_code} ' "https://$NEW_HOST/login")$(curl_in -o /dev/null -w '%{http_code}' "https://$OLD_HOST/login")"
assert_eq "API calls to the old host redirect too (extensions must be rebuilt for the new default)" 308 \
  "$(curl_in -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "https://$OLD_HOST/api/v1/ping")"
new_upload=$(curl_in -H "Authorization: Bearer $token" -F image=@/w/capture.png \
  -F sourceUrl=https://example.org/page2 -F title=After "https://$NEW_HOST/api/v1/captures")
new_page=$(printf '%s' "$new_upload" | json_field pageUrl)
assert_eq "the app mints new links on the new host (PUBLIC_ORIGIN followed PUBLIC_HOST)" \
  "https://$NEW_HOST/s/" "${new_page:0:$((${#NEW_HOST} + 11))}"
assert_eq "the old session cookie is not sent cross-host: /me on the new host is 401 until re-login" 401 \
  "$(curl_in -b /w/jar -o /dev/null -w '%{http_code}' "https://$NEW_HOST/api/v1/auth/me")"

echo "== 4. rollback: remove the block, restore PUBLIC_HOST, up -d"
rm "$WORK/sites.d/old-domain.caddy"
set_public_host "$OLD_HOST"
"${COMPOSE[@]}" up -d --wait caddy app postgres
assert_eq "old host serves the capture directly again" 200 \
  "$(curl_in -o /dev/null -w '%{http_code}' "$page_url")"
rolled_back=$(curl_in -H "Authorization: Bearer $token" -F image=@/w/capture.png \
  -F sourceUrl=https://example.org/page3 -F title=Rollback "https://$OLD_HOST/api/v1/captures" | json_field pageUrl)
assert_eq "links are minted on the old host again" "https://$OLD_HOST/s/" "${rolled_back:0:$((${#OLD_HOST} + 11))}"

echo
echo "== domain migration rehearsal: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
