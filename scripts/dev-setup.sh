#!/usr/bin/env bash
# Local development bootstrap for Debian/Ubuntu (sudo required). Idempotent.
# Installs PostgreSQL 17 + PostGIS, creates role/databases/extensions, installs npm deps,
# builds the API, runs migrations and loads clearly-labelled DEMO data into pharma_dev.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-17 postgresql-17-postgis-3 postgresql-contrib
fi
sudo pg_ctlcluster 17 main start 2>/dev/null || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pharma') THEN
    CREATE ROLE pharma LOGIN PASSWORD 'pharma_dev_password' CREATEDB;  -- DEV ONLY credentials
  END IF;
END $$;
SQL
for db in pharma_dev pharma_test; do
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || sudo -u postgres createdb -O pharma "$db"
  sudo -u postgres psql -q -d "$db" -c "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;"
done
# Low-memory machines: add swap for the Next.js build if none exists.
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 3000 ]; then
  sudo fallocate -l 3G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile || true
fi
npm install --no-audit --no-fund
npm run build -w apps/api
DATABASE_URL=postgres://pharma:pharma_dev_password@127.0.0.1:5432/pharma_dev node apps/api/dist/src/database/migrate.cli.js
DATABASE_URL=postgres://pharma:pharma_dev_password@127.0.0.1:5432/pharma_dev node apps/api/dist/src/database/seed.cli.js
echo "Done. Start: (1) cd apps/api && node dist/src/main.js   (2) npm run build -w apps/web && npm run start -w apps/web"
