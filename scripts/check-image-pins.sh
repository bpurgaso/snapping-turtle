#!/usr/bin/env bash
# One Postgres image pin, enforced.
#
# deploy/docker-compose.yml holds the authoritative `postgres:<tag>@sha256:<digest>`
# — the one Dependabot sees (docker-compose ecosystem in .github/dependabot.yml;
# it moves tag and digest together). Every other tracked file that names a
# postgres image tag (the CI service container, the backup sidecar's FROM,
# verify-restore's scratch container, the README quickstart) must carry the
# identical tag; the sites that *run in production* — the backup sidecar's
# FROM — must also carry the identical digest, and any site that names a
# digest must name that one. No variable indirection on purpose: Dependabot
# can only bump literals, and `${PG_VERSION}` would hide the pin from it. A
# Dependabot bump of the compose pin therefore fails this check until the
# other sites move in the same PR — drift is loud, never silent.
# Runbook: deploy/README.md "Upgrading Postgres across a major version".
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

AUTHORITY=deploy/docker-compose.yml
# Image references only: a digit must follow the colon, so postgres:// URLs
# (DATABASE_URL and friends) never match. The digest is optional in the
# pattern so tag-only sites are found (and checked) too.
IMAGE_RE='postgres:[0-9][A-Za-z0-9._-]*(@sha256:[0-9a-f]{64})?'
# Sites that must carry the pin; a site that stops naming it (e.g. someone
# switching CI to a variable) is as much drift as a wrong tag.
REQUIRED_SITES='.github/workflows/ci.yml
deploy/Dockerfile.backup
deploy/backup/verify-restore.sh
README.md'
# Sites that must carry the digest as well: images that run in production.
DIGEST_SITES='deploy/Dockerfile.backup'

pin=$(grep -E "^[[:space:]]*image:[[:space:]]*${IMAGE_RE}" "$AUTHORITY" | grep -oE "$IMAGE_RE" | sort -u || true)
count=$(printf '%s\n' "$pin" | grep -c . || true)
if [ "$count" -ne 1 ]; then
  echo "check-image-pins: expected exactly one 'image: postgres:<tag>@sha256:<digest>' in $AUTHORITY, found $count" >&2
  exit 2
fi
case "$pin" in
  *@sha256:*) ;;
  *) echo "check-image-pins: the authoritative pin $pin carries no digest (expected postgres:<tag>@sha256:<digest>)" >&2; exit 2 ;;
esac
pin_tag=${pin%%@*}
pin_digest=${pin#*@}
echo "check-image-pins: authoritative pin is $pin_tag ($AUTHORITY)"
echo "                  digest $pin_digest"

status=0
seen=""
# git grep -o -n prints file:line:match, one line per occurrence, tracked files only.
while IFS=: read -r file line match; do
  [ -z "$file" ] && continue
  [ "$file" = "$AUTHORITY" ] && continue
  seen="$seen
$file"
  tag=${match%%@*}
  digest=""
  case "$match" in *@*) digest=${match#*@} ;; esac
  if [ "$tag" != "$pin_tag" ]; then
    echo "  DRIFT  $file:$line  $tag  (expected $pin_tag)"
    status=1
  elif [ -n "$digest" ] && [ "$digest" != "$pin_digest" ]; then
    echo "  DRIFT  $file:$line  $tag@$digest  (expected digest $pin_digest)"
    status=1
  elif [ -z "$digest" ] && printf '%s\n' "$DIGEST_SITES" | grep -qx "$file"; then
    echo "  DRIFT  $file:$line  $tag names no digest (expected @$pin_digest)"
    status=1
  elif [ -n "$digest" ]; then
    echo "  ok     $file:$line  $tag@sha256:…${digest#sha256:}" | sed -E 's/(…)[0-9a-f]{52}([0-9a-f]{12})$/\1\2/'
  else
    echo "  ok     $file:$line  $tag"
  fi
done <<EOT
$(git grep -I -n -o -E "$IMAGE_RE" -- . ":(exclude)$AUTHORITY" || true)
EOT

while IFS= read -r site; do
  [ -z "$site" ] && continue
  if ! printf '%s\n' "$seen" | grep -qx "$site"; then
    echo "  MISSING $site names no postgres image tag (expected $pin_tag)"
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
echo "check-image-pins: OK — every site matches $pin_tag (digest where required)"
