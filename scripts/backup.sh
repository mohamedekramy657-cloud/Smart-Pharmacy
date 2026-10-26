#!/usr/bin/env bash
# Logical backup of the platform database (custom format, compressed). Run from cron / a scheduler.
# Usage: DATABASE_URL=postgres://... scripts/backup.sh [output_dir]
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/smart-pharmacy-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"
sha256sum "$FILE" > "$FILE.sha256"
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
