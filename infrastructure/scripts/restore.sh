#!/usr/bin/env bash
# Restore a backup made by backup.sh into a database inside the staging Postgres container.
#   infrastructure/scripts/restore.sh <backup.dump> <target-database>
# The target database is created fresh; the script refuses to touch an existing one, so it can never overwrite live data.
# To replace the live database, restore to a new name, check it, then switch POSTGRES_DB and restart (see docs/deployment).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DUMP="${1:?usage: restore.sh <backup.dump> <target-database>}"
TARGET="${2:?usage: restore.sh <backup.dump> <target-database>}"
[[ "$TARGET" =~ ^[a-z][a-z0-9_]{2,40}$ ]] || { echo "target database name must be lowercase letters, digits, underscore" >&2; exit 2; }
COMPOSE=(docker compose -f "$ROOT/infrastructure/docker-compose.staging.yml" --env-file "$ROOT/infrastructure/.env.staging")

SUM="${DUMP%.dump}.sha256"
if [ -f "$SUM" ]; then ( cd "$(dirname "$DUMP")" && grep "$(basename "$DUMP")" "$(basename "$SUM")" | sha256sum -c - ) || { echo "checksum mismatch, refusing to restore" >&2; exit 1; }; fi

EXISTS="$("${COMPOSE[@]}" exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='$TARGET'\"")"
[ -z "$EXISTS" ] || { echo "database $TARGET already exists; choose a new name" >&2; exit 1; }
"${COMPOSE[@]}" exec -T postgres sh -c "createdb -U \"\$POSTGRES_USER\" $TARGET"
"${COMPOSE[@]}" exec -T postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d $TARGET --no-owner --exit-on-error" < "$DUMP"
echo "restored into database $TARGET"
