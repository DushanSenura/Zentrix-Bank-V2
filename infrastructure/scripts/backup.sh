#!/usr/bin/env bash
# Logical backup of the staging database (pg_dump custom format) plus uploaded files, with a checksum and retention.
#   infrastructure/scripts/backup.sh [output-dir]        (default: infrastructure/backups)
# Environment: COMPOSE_FILE_ARGS to override the compose command (default targets the staging stack).
# Restore with restore.sh; PROVE a backup is usable with verify-backup.sh. A backup that was never restored is not a backup.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$ROOT/infrastructure/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
COMPOSE=(docker compose -f "$ROOT/infrastructure/docker-compose.staging.yml" --env-file "$ROOT/infrastructure/.env.staging")
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
umask 077   # backups contain customer data (fictional here, but treat them as real)

DB_FILE="$OUT/zentrix-$STAMP.dump"
"${COMPOSE[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$DB_FILE"
[ -s "$DB_FILE" ] || { echo "backup is empty, aborting" >&2; exit 1; }

UPLOADS_FILE="$OUT/uploads-$STAMP.tar.gz"
"${COMPOSE[@]}" exec -T api tar -czf - -C /data/uploads . > "$UPLOADS_FILE" 2>/dev/null || true

( cd "$OUT" && sha256sum "$(basename "$DB_FILE")" "$(basename "$UPLOADS_FILE")" > "zentrix-$STAMP.sha256" )
find "$OUT" -maxdepth 1 -type f \( -name 'zentrix-*.dump' -o -name 'uploads-*.tar.gz' -o -name 'zentrix-*.sha256' \) -mtime +"$KEEP_DAYS" -delete

echo "backup written: $DB_FILE ($(wc -c < "$DB_FILE") bytes)"
echo "$DB_FILE"
