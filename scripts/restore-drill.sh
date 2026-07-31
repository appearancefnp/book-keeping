#!/usr/bin/env bash
# Restores the newest dump into a throwaway container and asserts it is usable.
# Exits non-zero if the backup is not restorable — the only test that matters.
set -euo pipefail

# Registered before anything that can fail, including the no-dump-found check below,
# so the cleanup trap is live for the entire script — not just from the point the
# container is created. Harmless before the container exists (docker rm -f on a
# not-yet-created name just no-ops via the `|| true`), and it means the claim "the
# trap fires on every exit path" is actually true rather than true-except-one-line.
CONTAINER="bk-restore-drill-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DUMP="$(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1)"
[ -n "$DUMP" ] || { echo "no dump found in $BACKUP_DIR" >&2; exit 1; }
echo "[drill] restoring $DUMP"

docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=bookkeeping \
  postgres:16 >/dev/null

# pg_isready alone is not enough: the official postgres image does an internal
# initdb-then-restart on first boot, and pg_isready can catch the short-lived
# temporary server in between, right before it shuts down — verified empirically
# ("FATAL: the database system is shutting down" on the very next command). Require
# a real query to succeed too, so we only proceed once the final server is up.
#
# Bounded: an unattended nightly job that hangs forever (degraded docker daemon,
# container that starts but whose postgres never comes up) is worse than one that
# exits non-zero, because a systemd oneshot stuck "activating" isn't flagged by
# exit-code monitoring the way a failed unit is. Cap the wait and fail loudly.
READY_TIMEOUT_SECS="${READY_TIMEOUT_SECS:-60}"
waited=0
until docker exec "$CONTAINER" pg_isready -U admin -d bookkeeping >/dev/null 2>&1 \
  && docker exec "$CONTAINER" psql -U admin -d bookkeeping -tAc 'select 1' >/dev/null 2>&1; do
  if [ "$waited" -ge "$READY_TIMEOUT_SECS" ]; then
    echo "[drill] FAIL: $CONTAINER did not become ready within ${READY_TIMEOUT_SECS}s" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
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

# journal_entries is the ledger: if it restores with rows, the backup is proven
# usable. einvoices is deliberately NOT checked here — VID/Peppol sends don't leave
# the building yet (see CLAUDE.md) and inbound e-invoices still route through
# StubAccessPoint, so a live pilot's einvoices table can legitimately stay empty for
# an extended stretch. Asserting on it would fail every nightly drill regardless of
# backup soundness — the same "trains the operator to ignore every alert" failure
# mode as the pg_restore role issue above, just moved from the tooling into the
# assertion set.
count="$(docker exec "$CONTAINER" psql -U admin -d bookkeeping -tAc "select count(*) from journal_entries")"
echo "[drill] journal_entries: $count rows"
[ "$count" -gt 0 ] || { echo "[drill] FAIL: journal_entries is empty" >&2; exit 1; }

echo "[drill] PASS — $DUMP is restorable and populated"
