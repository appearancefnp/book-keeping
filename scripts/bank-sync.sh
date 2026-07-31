#!/usr/bin/env bash
# Daily bank-feed sync: calls the existing /api/cron/bank-sync route so linked GoCardless
# connections import new transactions. Runs on the host via a systemd timer (mirrors
# backup.sh's approach), not in a container, so it doesn't depend on `worker` being up.
#
# `npm run worker` does NOT drive this — it only drains the job queue (dunning, recurring
# invoices, chain reapers). syncAllClients (src/bankfeed/cron.ts) has no job handler and
# no caller besides this route, so without this script + timer nothing schedules bank
# sync on the VPS at all.
set -euo pipefail

: "${SITE_ADDRESS:?SITE_ADDRESS must be set (see /opt/bookkeeping/.env)}"
: "${CRON_SECRET:?CRON_SECRET must be set (see /opt/bookkeeping/.env) — the route 401s without it}"

# --fail turns a 401/5xx into a non-zero exit so the systemd unit shows failed, not
# active (exited); --show-error prints the reason even with --silent.
curl --fail --silent --show-error --max-time 280 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "https://${SITE_ADDRESS}/api/cron/bank-sync"
echo
echo "[bank-sync] sync request completed"
