#!/usr/bin/env bash
# Takes a fresh backup, restores it into a scratch database, and compares every table's row count with the live database.
# Also checks the ledger still balances in the restored copy. Drops the scratch database afterwards. Exit code 0 = usable.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/infrastructure/docker-compose.staging.yml" --env-file "$ROOT/infrastructure/.env.staging")
SCRATCH="verify_$(date +%s)"
OUT="$(mktemp -d)"
trap '"${COMPOSE[@]}" exec -T postgres sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists '"$SCRATCH"'" >/dev/null 2>&1 || true' EXIT

DUMP="$("$HERE/backup.sh" "$OUT" | tail -1)"
"$HERE/restore.sh" "$DUMP" "$SCRATCH" >/dev/null

counts() {  # <database> -> "table count" lines for every user table
  "${COMPOSE[@]}" exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d $1 -tA" <<'SQL'
SELECT format('SELECT %L, count(*) FROM %I.%I;', relname, schemaname, relname) FROM pg_stat_user_tables ORDER BY relname
SQL
}
q() { "${COMPOSE[@]}" exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d $1 -tA -F ' '"; }
LIVE_DB="$("${COMPOSE[@]}" exec -T postgres sh -c 'echo -n "$POSTGRES_DB"')"
gen() { counts "$1" | q "$1"; }
LIVE="$(gen "$LIVE_DB" | sort)"
COPY="$(gen "$SCRATCH" | sort)"
if [ "$LIVE" != "$COPY" ]; then echo "ROW COUNTS DIFFER between live and restored copy:" >&2; diff <(echo "$LIVE") <(echo "$COPY") >&2 || true; exit 1; fi

# The ledger invariant must hold in the copy: every journal's debits equal its credits.
UNBAL="$(echo "SELECT count(*) FROM (SELECT \"journalId\" FROM \"LedgerPosting\" GROUP BY 1 HAVING sum(CASE WHEN direction='DEBIT' THEN \"amountMinor\" ELSE -\"amountMinor\" END) <> 0) t;" | q "$SCRATCH")"
[ "$UNBAL" = "0" ] || { echo "restored ledger has $UNBAL unbalanced journals" >&2; exit 1; }
echo "backup verified: $(echo "$LIVE" | wc -l) tables match, ledger balanced"
