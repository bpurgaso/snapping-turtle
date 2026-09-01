#!/usr/bin/env bash
# Prove the latest backup restores (PLAN.md §12): start a scratch Postgres on
# the compose-internal network, restore the newest dump into it, compare row
# counts with the manifest written at backup time, restore one image file
# (from the local snapshot, or from restic when RESTIC_REPOSITORY is set) and
# check its sha256 against the restored row. Nothing here touches the live
# database or volumes; the scratch container is removed on exit.
#
#   deploy/backup/verify-restore.sh            # after at least one backup ran
#   COMPOSE_FILES="-f deploy/docker-compose.yml -f deploy/docker-compose.local.yml" deploy/backup/verify-restore.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE_FILES=${COMPOSE_FILES:--f deploy/docker-compose.yml}
# shellcheck disable=SC2086
compose() { docker compose $COMPOSE_FILES "$@"; }

project=$(compose config --format json 2>/dev/null | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -1)
project=${project:-snapping-turtle}
network="${project}_internal"
scratch="st-restore-check-$$"

cleanup() { docker rm -f "$scratch" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "verify-restore: scratch postgres '$scratch' on network '$network'"
docker run -d --rm --name "$scratch" --network "$network" \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=scratch-only -e POSTGRES_DB=restore_check \
  --security-opt no-new-privileges:true --memory 512m \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$scratch" pg_isready -q -U app -d restore_check 2>/dev/null; then break; fi
  sleep 1
done
docker exec "$scratch" pg_isready -q -U app -d restore_check

# The backup image already has the backups + images volumes and the restic
# env; only the database target is redirected at the scratch container.
compose run --rm --no-deps \
  -e PGHOST="$scratch" -e PGUSER=app -e PGPASSWORD=scratch-only -e PGDATABASE=restore_check \
  backup verify-restore
