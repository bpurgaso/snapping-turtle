#!/usr/bin/env bash
# Cross-component integration (M9, PLAN.md §15a): boot the real server from
# the repo harness, run the client binary's upload path against it with the
# fixture PNG, and assert the capture row exists (no source_url) and its page
# renders — the M2 "match the implemented contract" discipline, enforced
# here on a client written in a different language. Runs in CI and locally:
#
#   DATABASE_URL=postgres://app:pw@127.0.0.1:5433/throwaway client-linux/scripts/integration.sh
#
# Needs: the workspace installed (pnpm install), cargo, node. Uses a debug
# build unless CLIENT_BIN points at a binary.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
: "${DATABASE_URL:?DATABASE_URL (a throwaway Postgres) is required}"
port=${CLIENT_TEST_PORT:-3119}
bin=${CLIENT_BIN:-$repo/client-linux/target/debug/snapping-turtle}
fixture=$repo/client-linux/tests/fixtures/fixture.png

if [ ! -x "$bin" ]; then (cd "$repo/client-linux" && cargo build --locked); fi

work=$(mktemp -d)
server_pid=
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "client-linux integration: FAIL — $*" >&2; echo "--- server stderr ---" >&2; cat "$work/serve.err" >&2 || true; exit 1; }

export NODE_ENV=test HOST=127.0.0.1 PORT=$port PUBLIC_ORIGIN="http://127.0.0.1:$port" LOG_LEVEL=warn \
  SESSION_SECRET=client-integration-secret-not-real-0123456789 IMAGES_DIR="$work/images" WEB_DIST_DIR="${WEB_DIST_DIR:-$repo/web/dist}"
mkdir -p "$IMAGES_DIR"
harness="pnpm --filter @snapping-turtle/server exec tsx test/helpers/client-harness.ts"

(cd "$repo" && pnpm --filter @snapping-turtle/shared build >/dev/null)
(cd "$repo" && $harness serve >"$work/serve.out" 2>"$work/serve.err") &
server_pid=$!
for _ in $(seq 1 240); do [ -s "$work/serve.out" ] && break; kill -0 "$server_pid" 2>/dev/null || fail "server exited early"; sleep 0.5; done
[ -s "$work/serve.out" ] || fail "server did not print its origin/token line"
origin=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).origin)' "$work/serve.out")
token=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).token)' "$work/serve.out")
[ "$origin" = "$PUBLIC_ORIGIN" ] || fail "harness origin $origin != $PUBLIC_ORIGIN"
prefix=${token:0:8}

# The client keeps its config under XDG_CONFIG_HOME; a fresh one per run.
export XDG_CONFIG_HOME="$work/xdg"

echo "== configure: a wrong token is refused (401) and nothing is saved"
if printf 'st_not-the-real-token-00000000000000\n' | timeout 60 "$bin" --configure --origin "$origin" --token-stdin --token-store file --autostart no >"$work/bad.out" 2>&1; then
  fail "configure accepted a bad token"
fi
grep -q "401" "$work/bad.out" || fail "bad-token configure did not report 401: $(cat "$work/bad.out")"
[ ! -e "$XDG_CONFIG_HOME/snapping-turtle/config.json" ] || fail "config written despite the rejected token"

echo "== configure: the minted token passes the ping and lands in a 0600 file"
printf '%s\n' "$token" | timeout 60 "$bin" --configure --origin "$origin" --token-stdin --token-store file --autostart no >"$work/cfg.out" 2>&1 || fail "configure failed: $(cat "$work/cfg.out")"
grep -q "Testing connection to $origin … ok" "$work/cfg.out" || fail "ping not reported ok: $(cat "$work/cfg.out")"
cfg="$XDG_CONFIG_HOME/snapping-turtle/config.json"
[ -f "$cfg" ] || fail "no config file"
! grep -q "$token" "$cfg" || fail "the token leaked into config.json"
tokfile="$XDG_CONFIG_HOME/snapping-turtle/token"
[ "$(stat -c %a "$tokfile")" = "600" ] || fail "token file mode is $(stat -c %a "$tokfile"), not 600"
[ "$(stat -c %a "$XDG_CONFIG_HOME/snapping-turtle")" = "700" ] || fail "config dir is not 0700"
! grep -q "$token" "$work/cfg.out" || fail "configure echoed the full token"
grep -q "$prefix…" "$work/cfg.out" || fail "configure did not show the 8-char prefix"

echo "== upload: the fixture goes through POST /api/v1/captures with the bearer token and no sourceUrl"
timeout 120 "$bin" -v --upload-file "$fixture" --title "client-linux integration" --no-open >"$work/up.out" 2>"$work/up.err" || fail "upload failed: $(cat "$work/up.out" "$work/up.err")"
row=$(cd "$repo" && $harness check 2>>"$work/serve.err")
[ "$row" != "null" ] || fail "no capture row after the upload"
view_id=$(node -e 'const r=JSON.parse(process.argv[1]); if (r.sourceUrl!==null) throw new Error("sourceUrl is "+JSON.stringify(r.sourceUrl)+", expected null"); if (r.pageTitle!=="client-linux integration") throw new Error("title "+r.pageTitle); if (r.width!==320||r.height!==200) throw new Error("dims "+r.width+"x"+r.height); if (!r.uploadTokenId) throw new Error("no upload_token_id"); process.stdout.write(r.viewId)' "$row") || fail "capture row mismatch: $row"

echo "== secrets: neither the token nor the full capability id appears in the client's output"
! grep -q "$token" "$work/up.out" "$work/up.err" || fail "token in client output"
! grep -q "$view_id" "$work/up.out" "$work/up.err" || fail "full view id in client output"
grep -q "uploaded: $origin/s/${view_id:0:8}…" "$work/up.out" || fail "expected the redacted page URL on stdout: $(cat "$work/up.out")"

echo "== page: renders live, without the source link, with preview tags; the image serves as PNG"
page=$(curl -fsS "$origin/s/$view_id") || fail "GET /s/<id> failed"
grep -q '<meta property="og:title" content="client-linux integration" />' <<<"$page" || fail "og:title missing"
! grep -q "Open original page" <<<"$page" || fail "source link rendered for a source-less capture"
! grep -q 'class="source"' <<<"$page" || fail "source anchor rendered"
grep -q "data-copy=\"$origin/s/$view_id\"" <<<"$page" || fail "copy target missing"
ctype=$(curl -fsSI "$origin/s/$view_id/image.png" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
[ "$ctype" = "image/png" ] || fail "image content-type is $ctype"

echo "== --print-url: the full URL only when asked, and only on stdout"
timeout 120 "$bin" --upload-file "$fixture" --title "second" --no-open --print-url >"$work/up2.out" 2>"$work/up2.err" || fail "second upload failed"
grep -q "^$origin/s/[A-Za-z0-9_-]\{27\}$" "$work/up2.out" || fail "print-url did not print the page URL: $(cat "$work/up2.out")"
! grep -q "$(cat "$work/up2.out")" "$work/up2.err" || fail "full URL leaked to stderr"

echo "client-linux integration: OK (capture $(printf %s "$view_id" | cut -c1-8)…, page and image render, no source link)"
