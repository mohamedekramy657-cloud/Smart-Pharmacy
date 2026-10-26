#!/usr/bin/env bash
# DEVELOPMENT ONLY: drops and recreates a local database with required extensions.
# Usage: scripts/reset-db.sh pharma_dev
set -euo pipefail
DB="${1:?database name required}"
case "$DB" in *prod*) echo "refusing to reset a production-looking database"; exit 1;; esac
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DROP DATABASE IF EXISTS ${DB} WITH (FORCE);
CREATE DATABASE ${DB} OWNER pharma;
\c ${DB}
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
SQL
echo "database ${DB} reset"
