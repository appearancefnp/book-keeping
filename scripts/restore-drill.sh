#!/usr/bin/env bash
# Restores the newest dump into a throwaway container and asserts it is usable.
# Exits non-zero if the backup is not restorable — the only test that matters.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DUMP="$(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1)"
[ -n "$DUMP" ] || { echo "no dump found in $BACKUP_DIR" >&2; exit 1; }
echo "[drill] restoring $DUMP"

CONTAINER="bk-restore-drill-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=bookkeeping \
  postgres:16 >/dev/null

# pg_isready alone is not enough: the official postgres image does an internal
# initdb-then-restart on first boot, and pg_isready can catch the short-lived
# temporary server in between, right before it shuts down — verified empirically
# ("FATAL: the database system is shutting down" on the very next command). Require
# a real query to succeed too, so we only proceed once the final server is up.
until docker exec "$CONTAINER" pg_isready -U admin -d bookkeeping >/dev/null 2>&1 \
  && docker exec "$CONTAINER" psql -U admin -d bookkeeping -tAc 'select 1' >/dev/null 2>&1; do
  sleep 1
done

# The dump's GRANT/CREATE POLICY statements target the app's own roles
# (bookkeeping_app/worker/supervisor from migrations/000_bootstrap.sql), which a
# vanilla postgres:16 image doesn't have. Without these, pg_restore exits non-zero
# on every run regardless of data content — verified empirically — which would
# make the drill fail unconditionally and train the operator to ignore it.
docker exec "$CONTAINER" psql -U admin -d bookkeeping -c \
  "CREATE ROLE bookkeeping_app; CREATE ROLE bookkeeping_worker; CREATE ROLE bookkeeping_supervisor;" \
  >/dev/null

docker exec -i "$CONTAINER" pg_restore -U admin -d bookkeeping --no-owner < "$DUMP"

for table in journal_entries einvoices; do
  count="$(docker exec "$CONTAINER" psql -U admin -d bookkeeping -tAc "select count(*) from $table")"
  echo "[drill] $table: $count rows"
  [ "$count" -gt 0 ] || { echo "[drill] FAIL: $table is empty" >&2; exit 1; }
done

echo "[drill] PASS — $DUMP is restorable and populated"
