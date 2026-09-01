#!/usr/bin/env bash
# k6 guard load test (docs/loadtest.md). Brings up the dedicated loadtest
# compose project (fresh DB, TRUST_PROXY=true, short breaker cooldown), seeds
# the throwaway admin, runs the scenarios in the k6 container, and tears the
# project down with its volumes. k6 is never an npm dependency.
#
#   pnpm loadtest                 # ban, breaker, baseline
#   pnpm loadtest breaker         # one scenario
#   KEEP=1 pnpm loadtest ban      # leave the stack up for inspection
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.loadtest.yml)
scenarios=("$@")
[ ${#scenarios[@]} -gt 0 ] || scenarios=(ban breaker baseline)
mkdir -p loadtest/results

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1: loadtest stack left running (app on http://127.0.0.1:3100)"
  else
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "== loadtest: starting the dedicated compose project"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build --wait app postgres
"${COMPOSE[@]}" run --rm --no-deps app node dist/db/seed.js

echo "== loadtest: the app must have warned about permissive proxy trust"
# (grep without -q: with pipefail, an early exit would SIGPIPE `compose logs`.)
warning=$("${COMPOSE[@]}" logs --no-log-prefix app | grep '"tag":"sec.proxy.permissive_trust"' || true)
if [ -z "$warning" ]; then
  echo "expected sec.proxy.permissive_trust in the app log" >&2
  exit 1
fi
echo "$warning" | head -1

status=0
for s in "${scenarios[@]}"; do
  echo
  echo "== loadtest: scenario $s"
  if "${COMPOSE[@]}" run --rm k6 run "scenarios/$s.js" 2>&1 | tee "loadtest/results/$s.txt"; then
    echo "== $s: PASS"
  else
    echo "== $s: FAIL"
    status=1
  fi
  # Let the aggregate window drain between scenarios so they stay independent.
  sleep 5
done

echo
echo "== loadtest: security events emitted by the app during the run"
"${COMPOSE[@]}" logs --no-log-prefix app | grep -o '"tag":"sec\.[a-z_.]*"' | sort | uniq -c | sort -rn
exit $status
