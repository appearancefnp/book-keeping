#!/usr/bin/env bash
# Rotates the three non-owner role passwords off the defaults baked into
# migrations/000_bootstrap.sql, 039_jobs.sql and 041_supervisor_role.sql.
# Prints the connection strings to paste into .env. Idempotent: re-run any time.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/bookkeeping/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/opt/bookkeeping/.env}"
DB_HOST="${DB_HOST:-db}"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# head -c32 reads from a process substitution rather than a `|` pipe: with
# `set -o pipefail`, tr's SIGPIPE (it dies once head stops reading after 32
# bytes) would otherwise make the pipeline's exit status 141 and trip `set -e`.
gen() { LC_ALL=C head -c 32 < <(tr -dc 'A-Za-z0-9' < /dev/urandom); }

echo "# Paste these into $ENV_FILE, then: docker compose ... up -d --force-recreate"
for role in app worker supervisor; do
  pw="$(gen)"
  compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE bookkeeping_$role PASSWORD '$pw';" >/dev/null
  case "$role" in
    app)        var=DATABASE_URL ;;
    worker)     var=WORKER_DATABASE_URL ;;
    supervisor) var=SUPERVISOR_DATABASE_URL ;;
  esac
  echo "$var=postgres://bookkeeping_$role:$pw@$DB_HOST:5432/$POSTGRES_DB"
done
echo "# ADMIN_DATABASE_URL is unchanged — it uses the POSTGRES_USER superuser."
