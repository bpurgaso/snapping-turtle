#!/usr/bin/env bash
# One Postgres image pin, enforced.
#
# deploy/docker-compose.yml holds the authoritative `postgres:<tag>` — the one
# Dependabot sees (docker-compose ecosystem in .github/dependabot.yml). Every
# other tracked file that names a postgres image tag (the CI service container,
# the backup sidecar's FROM, verify-restore's scratch container, the README
# quickstart) must carry the identical literal. No variable indirection on
# purpose: Dependabot can only bump literals, and `${PG_VERSION}` would hide the
# pin from it. A Dependabot bump of the compose pin therefore fails this check
# until the other sites move in the same PR — drift is loud, never silent.
# Runbook: deploy/README.md "Upgrading Postgres across a major version".
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

AUTHORITY=deploy/docker-compose.yml
# Image references only: a digit must follow the colon, so postgres:// URLs
# (DATABASE_URL and friends) never match.
IMAGE_RE='postgres:[0-9][A-Za-z0-9._-]*'
# Sites that must carry the pin; a site that stops naming it (e.g. someone
# switching CI to a variable) is as much drift as a wrong tag.
REQUIRED_SITES='.github/workflows/ci.yml
deploy/Dockerfile.backup
deploy/backup/verify-restore.sh
README.md'

pin=$(grep -E "^[[:space:]]*image:[[:space:]]*${IMAGE_RE}" "$AUTHORITY" | grep -oE "$IMAGE_RE" | sort -u || true)
count=$(printf '%s\n' "$pin" | grep -c . || true)
if [ "$count" -ne 1 ]; then
  echo "check-image-pins: expected exactly one 'image: postgres:<tag>' in $AUTHORITY, found $count" >&2
  exit 2
fi
echo "check-image-pins: authoritative pin is $pin ($AUTHORITY)"

status=0
seen=""
# git grep -o -n prints file:line:match, one line per occurrence, tracked files only.
while IFS=: read -r file line match; do
  [ -z "$file" ] && continue
  [ "$file" = "$AUTHORITY" ] && continue
  seen="$seen
$file"
  if [ "$match" = "$pin" ]; then
    echo "  ok     $file:$line  $match"
  else
    echo "  DRIFT  $file:$line  $match  (expected $pin)"
    status=1
  fi
done <<EOT
$(git grep -I -n -o -E "$IMAGE_RE" -- . ":(exclude)$AUTHORITY" || true)
EOT

while IFS= read -r site; do
  [ -z "$site" ] && continue
  if ! printf '%s\n' "$seen" | grep -qx "$site"; then
    echo "  MISSING $site names no postgres image tag (expected $pin)"
    status=1
  fi
done <<EOT
$REQUIRED_SITES
EOT

if [ "$status" -ne 0 ]; then
  echo "check-image-pins: FAILED — change the pin in $AUTHORITY and sync every site above in the same PR" >&2
  echo "  (deploy/README.md → 'Upgrading Postgres across a major version')" >&2
  exit 1
fi
echo "check-image-pins: OK — every site matches $pin"
