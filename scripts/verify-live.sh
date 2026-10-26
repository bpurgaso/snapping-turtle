#!/usr/bin/env bash
# verify-live.sh — external, read-only posture probe for a snapping-turtle
# deployment (PLAN.md §6 link secrecy, §12 guard; E12 re-verification sweep).
#
#   scripts/verify-live.sh https://shots.example.com:28443
#   scripts/verify-live.sh https://shots.example.com:28443 https://shots.example.com:28443/s/<a-live-capture-you-own>
#   VERIFY_INSECURE=1 scripts/verify-live.sh https://localhost:28443      # local stack under Caddy's internal CA
#
# What it proves, from outside, against the posture the tests froze at merge time:
#   1. the uniform 404 — three invalid secret-route probes (two under /s/, one
#      under /reset/) return byte-identical bodies and identical headers (Date aside)
#   2. the secret-page header set on those /s/* responses (no-store, no-referrer,
#      noindex, CSP, nosniff, frame denial) — and on a live capture page if you pass one
#   3. the public pages carry the posture *the design gives them*: `/` is noindex +
#      no-store like everything else; `/privacy` is the one indexable, publicly
#      cacheable page; `/ext/updates.json` is publicly cacheable (or 404 before a
#      Firefox build is published — reported, not failed); `/robots.txt` is exactly
#      the text the server is meant to serve
#   4. TLS/HSTS sanity — the certificate verifies, TLS 1.1 and below are refused,
#      HSTS is sent on every response; ports 80 and 443 are reported (WARN if they
#      answer — this service must not be what answers there)
#
# ┌──────────────────────────────────────────────────────────────────────────────┐
# │ GUARD BUDGET — READ BEFORE RUNNING TWICE                                     │
# │ Every invalid secret-route lookup counts against the per-IP budget:         │
# │ RATE_INVALID_LOOKUP_BUDGET (default 5) misses per                            │
# │ RATE_INVALID_LOOKUP_WINDOW_MIN (default 10 minutes) → an escalating ban.    │
# │ This script makes EXACTLY 3 invalid probes (constant INVALID_PROBES below,  │
# │ asserted by the script itself), so one run stays under the default budget   │
# │ by construction. Running it TWICE within the window spends 6 > 5 and WILL   │
# │ BAN YOUR IP for 15 minutes (then 1 h, then 24 h on repeat) — every /s/*     │
# │ link, valid ones included, answers 429 from your address until then.        │
# │ Recovery: /admin → Guard → Unban your prefix (audited), or wait it out.     │
# │ Lower budgets (RATE_INVALID_LOOKUP_BUDGET < 3) make a single run a ban.     │
# └──────────────────────────────────────────────────────────────────────────────┘
#
# Read-only: GET and HEAD only, no credentials, nothing written anywhere but
# a temp dir. Output never prints a probe id in full (CLAUDE.md rule 3 — they
# are random, but the habit is the point) and never prints a capture URL you
# pass in beyond its origin. Exit 0 = every check PASS (WARNs allowed), 1 = a
# FAIL, 2 = usage.
set -euo pipefail

INVALID_PROBES=3          # ← the budget contract; the script refuses to drift from it
DEFAULT_BUDGET=5          # shared/GUARD_DEFAULTS.invalidLookupBudget, for the message only

usage() {
  echo "usage: $0 <origin> [live-capture-url]" >&2
  echo "       origin like https://shots.example.com:28443 (scheme + host + port, no path)" >&2
  exit 2
}
ORIGIN="${1:-}"
LIVE="${2:-}"
[[ -n "$ORIGIN" ]] || usage
[[ "$ORIGIN" =~ ^https://[^/[:space:]]+$ ]] || { echo "origin must be https://host[:port] with no path" >&2; usage; }
HOST_PORT="${ORIGIN#https://}"
HOST="${HOST_PORT%%:*}"

CURL=(curl -sS --max-time 20 -A "snapping-turtle-verify-live/1")
if [[ "${VERIFY_INSECURE:-0}" == "1" ]]; then
  CURL+=(--insecure)
  echo "note: VERIFY_INSECURE=1 — certificate verification is OFF (local internal CA); the TLS checks below are weaker"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0; warn=0
PASS() { echo "PASS  $*"; pass=$((pass+1)); }
FAIL() { echo "FAIL  $*"; fail=$((fail+1)); }
WARN() { echo "WARN  $*"; warn=$((warn+1)); }

# fetch <name> <url> [curl args…] → writes $TMP/<name>.{status,headers,body}
fetch() {
  local name="$1" url="$2"; shift 2
  local status
  status="$("${CURL[@]}" "$@" -o "$TMP/$name.body" -D "$TMP/$name.headers" -w '%{http_code}' "$url" 2>"$TMP/$name.err")" || status="000"
  echo "$status" > "$TMP/$name.status"
}
status_of() { cat "$TMP/$1.status"; }
# header <name> <field> → lowercase-trimmed value of the LAST occurrence ('' if absent)
header() { command grep -i "^$2:" "$TMP/$1.headers" | tail -1 | cut -d: -f2- | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr -d '\r'; }
# comparable headers: sorted, lowercased names, Date removed, status line removed
comparable() { command grep -iv '^date:' "$TMP/$1.headers" | command grep -v '^HTTP/' | tr -d '\r' | awk -F: '{n=tolower($1); $1=""; print n":"$0}' | sort; }
sha() { sha256sum "$TMP/$1.body" | cut -c1-64; }
# a random 27-char base64url id — well-formed, never existed; printed only as a prefix
rand_id() { head -c 20 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
prefix() { echo "${1:0:8}…"; }

echo "== snapping-turtle live posture probe against $ORIGIN"
echo "== budget: $INVALID_PROBES invalid secret-route probes this run (default budget $DEFAULT_BUDGET per 10 min)"
echo

# ---- 1. uniform 404: three probes, byte-identical ----------------------------
probes_made=0
a="$(rand_id)"; b="$(rand_id)"; c="$(rand_id)"
fetch p1 "$ORIGIN/s/$a";            probes_made=$((probes_made+1))
fetch p2 "$ORIGIN/s/$b/image.png";  probes_made=$((probes_made+1))
fetch p3 "$ORIGIN/reset/$c";        probes_made=$((probes_made+1))
if [[ "$probes_made" -ne "$INVALID_PROBES" ]]; then
  echo "internal error: made $probes_made invalid probes, contract says $INVALID_PROBES" >&2; exit 1
fi
echo "-- uniform 404 (probes $(prefix "$a") page, $(prefix "$b") image, $(prefix "$c") reset)"
for p in p1 p2 p3; do
  s="$(status_of $p)"
  if [[ "$s" == "404" ]]; then PASS "$p → 404"; elif [[ "$s" == "429" ]]; then FAIL "$p → 429: this IP is banned or the breaker is open — see the header comment; run again after the ban or unban at /admin"; else FAIL "$p → HTTP $s (expected 404)"; fi
done
if [[ "$(sha p1)" == "$(sha p2)" && "$(sha p2)" == "$(sha p3)" ]]; then
  PASS "bodies byte-identical across /s/ page, /s/ image and /reset/ (sha256 $(cut -c1-12 <<<"$(sha p1)"))"
else
  FAIL "bodies differ between the three misses"
fi
if [[ "$(comparable p1)" == "$(comparable p2)" && "$(comparable p2)" == "$(comparable p3)" ]]; then
  PASS "headers identical across the three misses (Date excluded)"
else
  FAIL "headers differ between the three misses:"; diff <(comparable p1) <(comparable p2) || true; diff <(comparable p2) <(comparable p3) || true
fi
if command grep -qi 'rotat\|expired\|deleted' "$TMP/p1.body"; then FAIL "404 body carries a distinguishing word"; else PASS "404 body is the generic text"; fi
if [[ -n "$(header p1 location)" ]]; then FAIL "404 carries a Location header"; else PASS "no redirect on a miss"; fi

# ---- 2. the secret-page header set ------------------------------------------
check_secret_headers() { # <name> <label>
  local n="$1" label="$2"
  [[ "$(header $n cache-control)" == "private, no-store" ]] && PASS "$label: Cache-Control private, no-store" || FAIL "$label: Cache-Control is '$(header $n cache-control)'"
  [[ "$(header $n referrer-policy)" == "no-referrer" ]] && PASS "$label: Referrer-Policy no-referrer" || FAIL "$label: Referrer-Policy is '$(header $n referrer-policy)'"
  [[ "$(header $n x-robots-tag)" == "noindex, nofollow" ]] && PASS "$label: X-Robots-Tag noindex, nofollow" || FAIL "$label: X-Robots-Tag is '$(header $n x-robots-tag)'"
  [[ "$(header $n content-security-policy)" == *"default-src 'self'"* && "$(header $n content-security-policy)" != *unsafe-* ]] && PASS "$label: strict CSP" || FAIL "$label: CSP is '$(header $n content-security-policy)'"
  [[ "$(header $n x-content-type-options)" == "nosniff" ]] && PASS "$label: nosniff" || FAIL "$label: X-Content-Type-Options is '$(header $n x-content-type-options)'"
  [[ "$(header $n x-frame-options)" == "DENY" || "$(header $n content-security-policy)" == *"frame-ancestors 'none'"* ]] && PASS "$label: framing denied" || FAIL "$label: framing not denied"
}
echo; echo "-- secret-page headers on /s/* (the 404 itself carries the full set)"
check_secret_headers p1 "/s/<miss>"
if [[ -n "$LIVE" ]]; then
  if [[ "$LIVE" != "$ORIGIN/s/"* ]]; then FAIL "live capture URL is not under $ORIGIN/s/ (not fetched)"; else
    fetch live "$LIVE"
    if [[ "$(status_of live)" == "200" ]]; then
      PASS "live capture page → 200 (checked anonymously; URL not printed)"
      check_secret_headers live "/s/<live>"
      command grep -q 'rel="noopener noreferrer"' "$TMP/live.body" && PASS "/s/<live>: source link carries rel=noopener noreferrer" || WARN "/s/<live>: no source link with noopener noreferrer (a desktop capture has none)"
      command grep -q 'name="referrer" content="no-referrer"' "$TMP/live.body" && PASS "/s/<live>: meta referrer no-referrer" || FAIL "/s/<live>: meta referrer missing"
      fetch liveimg "$LIVE/image.png"
      [[ "$(status_of liveimg)" == "200" && "$(header liveimg content-type)" == "image/png" ]] && PASS "/s/<live>/image.png → 200 image/png" || FAIL "/s/<live>/image.png → $(status_of liveimg) $(header liveimg content-type)"
      [[ "$(header liveimg cache-control)" == "private, no-cache" ]] && PASS "/s/<live>/image.png: Cache-Control private, no-cache (revalidated by ETag)" || FAIL "/s/<live>/image.png: Cache-Control is '$(header liveimg cache-control)'"
      [[ "$(header liveimg x-robots-tag)" == "noindex, nofollow" ]] && PASS "/s/<live>/image.png: noindex" || FAIL "/s/<live>/image.png: X-Robots-Tag is '$(header liveimg x-robots-tag)'"
    else
      FAIL "live capture page → HTTP $(status_of live) (expected 200; is the link current? a rotated or deleted one is the uniform 404 — and that probe counted against the budget)"
    fi
  fi
fi

# ---- 3. public pages: the posture the design gives each ----------------------
echo; echo "-- public pages"
fetch home "$ORIGIN/"
[[ "$(status_of home)" == "200" ]] && PASS "/ → 200" || FAIL "/ → $(status_of home)"
[[ "$(header home x-robots-tag)" == "noindex, nofollow" ]] && PASS "/: noindex (by design — only /privacy is indexable)" || FAIL "/: X-Robots-Tag is '$(header home x-robots-tag)'"
[[ "$(header home cache-control)" == "private, no-store" ]] && PASS "/: private, no-store" || FAIL "/: Cache-Control is '$(header home cache-control)'"
command grep -q '/s/[A-Za-z0-9_-]\{27\}' "$TMP/home.body" && FAIL "/: the home page names a capture URL" || PASS "/: no capture URL in the page (no discovery surface)"

fetch privacy "$ORIGIN/privacy"
[[ "$(status_of privacy)" == "200" ]] && PASS "/privacy → 200" || FAIL "/privacy → $(status_of privacy)"
[[ -z "$(header privacy x-robots-tag)" ]] && PASS "/privacy: no X-Robots-Tag (the one indexable page)" || FAIL "/privacy: X-Robots-Tag is '$(header privacy x-robots-tag)' (must be absent)"
[[ "$(header privacy cache-control)" == "public, max-age=300" ]] && PASS "/privacy: public, max-age=300" || FAIL "/privacy: Cache-Control is '$(header privacy cache-control)'"
[[ "$(header privacy referrer-policy)" == "no-referrer" ]] && PASS "/privacy: the app-wide headers stay on" || FAIL "/privacy: Referrer-Policy is '$(header privacy referrer-policy)'"

fetch updates "$ORIGIN/ext/updates.json"
case "$(status_of updates)" in
  200) [[ "$(header updates cache-control)" == "public, max-age=300" ]] && PASS "/ext/updates.json → 200, public, max-age=300" || FAIL "/ext/updates.json: Cache-Control is '$(header updates cache-control)'"
       [[ "$(header updates x-robots-tag)" == "noindex, nofollow" ]] && PASS "/ext/updates.json: noindex" || FAIL "/ext/updates.json: X-Robots-Tag is '$(header updates x-robots-tag)'"
       command grep -q '/s/[A-Za-z0-9_-]\{27\}' "$TMP/updates.body" && FAIL "/ext/updates.json names a capture URL" || PASS "/ext/updates.json: no capture URL";;
  404) WARN "/ext/updates.json → 404: no Firefox build published yet (expected before the first sign:firefox)";;
  *)   FAIL "/ext/updates.json → $(status_of updates)";;
esac
fetch extdir "$ORIGIN/ext/"
[[ "$(status_of extdir)" == "404" ]] && PASS "/ext/ has no listing" || FAIL "/ext/ → $(status_of extdir) (expected 404, never a listing)"

fetch robots "$ORIGIN/robots.txt"
EXPECTED_ROBOTS=$'User-agent: *\nDisallow: /s/\nDisallow: /reset/\nDisallow: /api/\n'
if [[ "$(status_of robots)" == "200" && "$(cat "$TMP/robots.body")" == "$(printf '%s' "$EXPECTED_ROBOTS")" ]]; then
  PASS "/robots.txt is current (disallows /s/, /reset/, /api/)"
else
  FAIL "/robots.txt → $(status_of robots), content differs from server/src/robots.ts:"; cat "$TMP/robots.body" 2>/dev/null | sed 's/^/      /'
fi

# ---- 4. TLS / HSTS -------------------------------------------------------------
echo; echo "-- TLS and HSTS"
hsts="$(header home strict-transport-security)"
[[ "$hsts" == *"max-age=31536000"* ]] && PASS "HSTS: $hsts" || FAIL "HSTS header is '$hsts' (expected max-age=31536000)"
[[ "$(header p1 strict-transport-security)" == *"max-age="* ]] && PASS "HSTS present on the 404 too" || FAIL "HSTS missing on the uniform 404"
if [[ "${VERIFY_INSECURE:-0}" != "1" ]]; then
  if curl -sS --max-time 20 -o /dev/null "$ORIGIN/robots.txt" 2>"$TMP/tls.err"; then PASS "certificate verifies for $HOST"; else FAIL "certificate does not verify: $(head -1 "$TMP/tls.err")"; fi
fi
if curl -sS --max-time 20 --tls-max 1.1 -o /dev/null "${CURL[@]:1}" "$ORIGIN/robots.txt" 2>/dev/null; then
  FAIL "TLS 1.1 was accepted"
else
  PASS "TLS ≤ 1.1 refused"
fi
if curl -sS --max-time 20 --tlsv1.2 -o /dev/null "${CURL[@]:1}" "$ORIGIN/robots.txt" 2>/dev/null; then PASS "TLS ≥ 1.2 accepted"; else FAIL "TLS 1.2+ connection failed"; fi
for port in 80 443; do
  if curl -sS --max-time 4 -o /dev/null "http${port/443/s}://$HOST:$port/" 2>/dev/null || curl -sS --max-time 4 --insecure -o /dev/null "https://$HOST:$port/" 2>/dev/null; then
    WARN "port $port answers on $HOST — this service must not be what answers there (PLAN.md §14: one published port)"
  else
    PASS "port $port does not answer on $HOST"
  fi
done

echo
echo "== $pass passed, $fail failed, $warn warnings — $probes_made invalid probes spent against the budget; wait 10 minutes before running again"
[[ "$fail" -eq 0 ]]
