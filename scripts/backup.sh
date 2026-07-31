#!/usr/bin/env bash
# Nightly backup: Postgres custom-format dump + the blob volume, then offsite via restic.
# Runs on the host (not in a container) so it survives an application failure.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/bookkeeping/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/opt/bookkeeping/.env}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

mkdir -p "$BACKUP_DIR"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

compose exec -T db pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  > "$BACKUP_DIR/db-$STAMP.dump"

compose exec -T web tar -czf - -C /app/.blob-store . \
  > "$BACKUP_DIR/blobs-$STAMP.tar.gz"

echo "[backup] wrote db-$STAMP.dump ($(du -h "$BACKUP_DIR/db-$STAMP.dump" | cut -f1)) and blobs-$STAMP.tar.gz ($(du -h "$BACKUP_DIR/blobs-$STAMP.tar.gz" | cut -f1))"

# Fail loudly (non-zero exit -> systemd shows `failed`, not `active (exited)`) before the
# prune below ever runs, unless local-only is an explicit, deliberate opt-in. Local dumps
# alone are one disk failure away from total loss, and the local retention below would
# otherwise happily prune the only copies while everything still looked green.
if [ -z "${RESTIC_REPOSITORY:-}" ] && [ "${ALLOW_LOCAL_ONLY:-}" != "1" ]; then
  echo "[backup] RESTIC_REPOSITORY unset and ALLOW_LOCAL_ONLY!=1 — refusing to treat this as a successful backup (dumps were written to $BACKUP_DIR but are LOCAL ONLY). Set RESTIC_REPOSITORY, or set ALLOW_LOCAL_ONLY=1 to explicitly accept local-only backups." >&2
  exit 1
fi

# Local retention: 8 days of dailies on disk; restic holds the long tail offsite.
find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.dump' -mtime +8 -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'blobs-*.tar.gz' -mtime +8 -delete

if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  restic backup --tag bookkeeping "$BACKUP_DIR"
  restic forget --tag bookkeeping --keep-daily 7 --keep-weekly 4 --prune
  echo "[backup] pushed offsite to $RESTIC_REPOSITORY"
else
  echo "[backup] RESTIC_REPOSITORY unset — LOCAL ONLY, no offsite copy (explicitly allowed via ALLOW_LOCAL_ONLY=1)" >&2
fi
