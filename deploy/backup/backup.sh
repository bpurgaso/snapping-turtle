#!/bin/sh
# snapping-turtle backup runner (PLAN.md §12). Modes:
#   backup loop            nightly at BACKUP_TIME_UTC (compose default)
#   backup run             one backup now
#   backup verify-restore  restore the latest dump + one image into the
#                          scratch database named by PG* and check them
#                          (driven by deploy/backup/verify-restore.sh)
#
# Every run: pg_dump (custom format, ACLs kept, ownership dropped) into
# $BACKUP_ROOT/db plus a row-count manifest, a hardlinked rsync snapshot of
# the image volume into $BACKUP_ROOT/images, rotation by BACKUP_KEEP_DAYS,
# and — when RESTIC_REPOSITORY is set — a restic snapshot of the dump and
# the images to that repository with a keep-daily/weekly/monthly policy.
#
# Logging (CLAUDE.md rule 3): no connection strings, no repository URLs, no
# passwords; capture files are named by internal id only.
set -eu

BACKUP_ROOT=${BACKUP_ROOT:-/backups}
IMAGES_DIR=${IMAGES_DIR:-/data/images}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
BACKUP_TIME_UTC=${BACKUP_TIME_UTC:-03:30}
export PGHOST=${PGHOST:-postgres}
export PGPORT=${PGPORT:-5432}
export PGUSER=${PGUSER:-${POSTGRES_USER:-app}}
export PGDATABASE=${PGDATABASE:-${POSTGRES_DB:-snapping_turtle}}
export PGPASSWORD=${PGPASSWORD:-${POSTGRES_PASSWORD:-}}
[ -n "$PGPASSWORD" ] || { echo "POSTGRES_PASSWORD (or PGPASSWORD) is required" >&2; exit 2; }

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "sec.backup.failed $*"; exit 1; }

COUNT_TABLES="users captures audit_log api_tokens ip_bans account_links"

# Row counts, one "table count" line per table — the manifest a restore is checked against.
row_counts() {
  for t in $COUNT_TABLES; do
    printf '%s %s\n' "$t" "$(psql -X -At -c "select count(*) from \"$t\"")"
  done
}

restic_enabled() { [ -n "${RESTIC_REPOSITORY:-}" ]; }

restic_scheme() { printf '%s' "${RESTIC_REPOSITORY:-}" | sed -E 's#^([a-z0-9]+):.*#\1#; t; s#.*#local-path#'; }

run_backup() {
  started=$(date +%s)
  stamp=$(date -u +%Y%m%d-%H%M%S)
  mkdir -p "$BACKUP_ROOT/db" "$BACKUP_ROOT/images"

  # ---- database ------------------------------------------------------------
  dump="$BACKUP_ROOT/db/snapping_turtle-$stamp.dump"
  pg_dump -Fc --no-owner -f "$dump.part"
  mv "$dump.part" "$dump"
  row_counts > "$dump.counts"
  ln -sfn "$(basename "$dump")" "$BACKUP_ROOT/db/latest.dump"
  ln -sfn "$(basename "$dump").counts" "$BACKUP_ROOT/db/latest.counts"
  dump_bytes=$(stat -c %s "$dump")

  # ---- images: hardlinked snapshot (unchanged files cost no extra space) ---
  snap="$BACKUP_ROOT/images/$stamp"
  link_dest=""
  if [ -d "$BACKUP_ROOT/images/latest" ]; then
    link_dest="--link-dest=$(readlink -f "$BACKUP_ROOT/images/latest")"
  fi
  # shellcheck disable=SC2086
  rsync -a $link_dest "$IMAGES_DIR/" "$snap.part/"
  mv "$snap.part" "$snap"
  ln -sfn "$stamp" "$BACKUP_ROOT/images/latest"
  image_files=$(find "$snap" -type f | wc -l | tr -d ' ')

  # ---- rotation -------------------------------------------------------------
  find "$BACKUP_ROOT/db" -maxdepth 1 -type f -name 'snapping_turtle-*' -mtime +"$KEEP_DAYS" -delete
  find "$BACKUP_ROOT/images" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$KEEP_DAYS" -exec rm -rf {} +

  # ---- off-box (restic) -----------------------------------------------------
  restic_state=disabled
  if restic_enabled; then
    [ -n "${RESTIC_PASSWORD:-}${RESTIC_PASSWORD_FILE:-}" ] || fail "RESTIC_REPOSITORY is set but RESTIC_PASSWORD is not"
    if ! restic cat config >/dev/null 2>&1; then
      log "restic: initialising repository ($(restic_scheme))"
      restic init >/dev/null
    fi
    restic backup --quiet --tag snapping-turtle "$dump" "$dump.counts" "$IMAGES_DIR"
    restic forget --quiet --tag snapping-turtle --prune \
      --keep-daily "${RESTIC_KEEP_DAILY:-14}" \
      --keep-weekly "${RESTIC_KEEP_WEEKLY:-8}" \
      --keep-monthly "${RESTIC_KEEP_MONTHLY:-6}"
    restic_state="ok backend=$(restic_scheme)"
  else
    log "restic: RESTIC_REPOSITORY unset — backups stay on this host in the backups volume only (see deploy/README.md)"
  fi

  log "sec.backup.completed dump=$(basename "$dump") dump_bytes=$dump_bytes image_files=$image_files restic=$restic_state seconds=$(( $(date +%s) - started ))"
}

# Seconds until the next BACKUP_TIME_UTC, from pure arithmetic (busybox date -d is not portable).
seconds_until_next() {
  hh=${BACKUP_TIME_UTC%%:*}; mm=${BACKUP_TIME_UTC##*:}
  now=$(date -u +%s)
  midnight=$(( now - ( $(date -u +%-H) * 3600 + $(date -u +%-M) * 60 + $(date -u +%-S) ) ))
  target=$(( midnight + ${hh#0} * 3600 + ${mm#0} * 60 ))
  [ "$target" -gt "$now" ] || target=$(( target + 86400 ))
  echo $(( target - now ))
}

run_loop() {
  log "scheduler: nightly at ${BACKUP_TIME_UTC} UTC, keep ${KEEP_DAYS} days locally, restic $(restic_enabled && echo "enabled ($(restic_scheme))" || echo disabled)"
  if [ "${BACKUP_ON_START:-false}" = "true" ]; then
    run_backup || log "sec.backup.failed on-start run"
  fi
  while :; do
    wait=$(seconds_until_next)
    log "next run in ${wait}s"
    sleep "$wait"
    run_backup || log "sec.backup.failed scheduled run"
    sleep 61   # never double-fire on the same minute
  done
}

# Restore the latest dump into the (empty) database PG* points at, compare
# row counts with the manifest, restore one image and verify its sha256
# against the restored row. Prints PASS/FAIL lines; exits non-zero on FAIL.
verify_restore() {
  status=0
  dump=$(readlink -f "$BACKUP_ROOT/db/latest.dump") || fail "no dump under $BACKUP_ROOT/db"
  counts="$BACKUP_ROOT/db/latest.counts"
  [ -f "$dump" ] && [ -f "$counts" ] || fail "latest dump or manifest missing"
  log "verify: dump=$(basename "$dump") into scratch database"

  # The runtime role is cluster-level (not in a database dump): create it so
  # the dump's GRANTs apply, then prove the append-only rule survived.
  psql -X -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'st_app') THEN CREATE ROLE st_app LOGIN; END IF; END \$\$;"
  pg_restore --no-owner --exit-on-error -d "$PGDATABASE" "$dump"
  log "verify: pg_restore ok"

  while read -r table expected; do
    actual=$(psql -X -At -c "select count(*) from \"$table\"")
    if [ "$actual" = "$expected" ]; then
      log "PASS rows $table=$actual"
    else
      log "FAIL rows $table expected=$expected actual=$actual"; status=1
    fi
  done < "$counts"

  writable=$(psql -X -At -c "select has_table_privilege('st_app','audit_log','UPDATE') or has_table_privilege('st_app','audit_log','DELETE')")
  if [ "$writable" = "f" ]; then log "PASS audit_log append-only for st_app"; else log "FAIL st_app can rewrite audit_log"; status=1; fi

  row=$(psql -X -At -c "select id || ' ' || sha256 from captures where deleted_at is null order by id desc limit 1")
  if [ -z "$row" ]; then
    log "SKIP image check: no live capture in the dump"
  else
    id=${row%% *}; want=${row##* }
    rel="$(printf '%02x' $(( id % 256 )))/$id.png"
    target="/tmp/verify-restore-$$"
    mkdir -p "$target"
    if restic_enabled; then
      restic restore --quiet latest --tag snapping-turtle --target "$target" --include "$IMAGES_DIR/$rel"
      file="$target$IMAGES_DIR/$rel"
      source="restic latest snapshot"
    else
      cp "$BACKUP_ROOT/images/latest/$rel" "$target/" 2>/dev/null || true
      file="$target/$id.png"
      source="local snapshot $(readlink "$BACKUP_ROOT/images/latest")"
    fi
    if [ ! -f "$file" ]; then
      log "FAIL image capture_id=$id missing from $source"; status=1
    else
      got=$(sha256sum "$file" | cut -d' ' -f1)
      if [ "$got" = "$want" ]; then
        log "PASS image capture_id=$id sha256 matches restored row (from $source)"
      else
        log "FAIL image capture_id=$id sha256 mismatch"; status=1
      fi
    fi
    rm -rf "$target"
  fi

  if [ "$status" -eq 0 ]; then log "verify-restore PASS"; else log "verify-restore FAIL"; fi
  return $status
}

case "${1:-loop}" in
  loop) run_loop ;;
  run) run_backup ;;
  verify-restore) verify_restore ;;
  *) echo "usage: backup [loop|run|verify-restore]" >&2; exit 2 ;;
esac
