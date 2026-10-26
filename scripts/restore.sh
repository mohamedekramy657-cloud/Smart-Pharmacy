#!/usr/bin/env bash
# Restores a backup into an EMPTY database that already has the postgis, pg_trgm and unaccent
# extensions (created by a superuser), then verifies ledger integrity.
# Usage: TARGET_DATABASE_URL=postgres://... scripts/restore.sh path/to/file.dump
set -euo pipefail
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
FILE="${1:?backup file required}"
[ -f "$FILE.sha256" ] && sha256sum --check --quiet "$FILE.sha256"
pg_restore --no-owner --no-privileges --exit-on-error --exclude-schema=tiger --exclude-schema=topology \
  --dbname="$TARGET_DATABASE_URL" --use-list=<(pg_restore --list "$FILE" | grep -v -E 'EXTENSION|spatial_ref_sys') "$FILE"
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "SELECT 'migrations=' || count(*) FROM schema_migrations"
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "SELECT 'ledger_mismatches=' || count(*) FROM sp_inventory_ledger_mismatches()"
echo "restore complete"
