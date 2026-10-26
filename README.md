# Smart Pharmacy Ecosystem · منظومة الصيدلية الذكية

A web platform connecting **patients**, **pharmacies** and **pharmaceutical warehouses** in Egypt (Arabic + English). Patients find the nearest verified pharmacy that reports their exact medicine in stock; pharmacies manage inventory and replenishment; warehouses manage orders, allocation, shipments and delivery schedules.

**Status:** MVP for phases 1–5 implemented and tested (67/67 automated tests, including the full Section 28 end-to-end workflow). Not yet piloted or production-deployed — see [docs/11-status-report.md](docs/11-status-report.md) for exact status, known limitations and open decisions.

## Architecture (short)
Modular monolith: **NestJS 11** REST API (raw SQL, zod validation, OpenAPI) + background worker (PostgreSQL job queue) · **PostgreSQL 17 + PostGIS** (ledger-guarded inventory, spatial search, trigram AR/EN search) · **Next.js 16 / React 19 / Tailwind 4** web app (RTL, mobile-first) proxying `/api/*` to the API. No Redis, no microservices — see ADRs in [docs/02-architecture.md](docs/02-architecture.md).

## Key guarantees
- Stock changes only through an append-only movement ledger (DB-enforced); `available = physical − reserved − unavailable` can never go negative; overselling, double allocation and partial receipts are prevented transactionally.
- Orders and dispatches never increase pharmacy stock — only verified receipt does; damaged/missing units become discrepancies.
- Progressive radius search 5→10→20→40 km (configurable) with source-aware freshness; stale or failing-integration data is never shown as confirmed; incoming stock is shown separately.
- Server-side authorization on every request with organization tenant isolation; CSRF, rate limiting, lockout, TOTP MFA for admins, audit logs.

## Quick start (local)
```bash
bash scripts/dev-setup.sh                      # Debian/Ubuntu: Postgres+PostGIS, deps, build, migrate, DEMO data
cd apps/api && node dist/src/main.js           # API http://127.0.0.1:4000/api
npm run build -w apps/web && npm run start -w apps/web   # Web http://localhost:3000 (or use the standalone server)
npm test -w apps/api                           # automated tests (needs pharma_test DB)
```
Demo logins (development data only, password `DemoPass#2026`): `admin@demo.local`, `ph1@demo.local`, `ph1.staff@demo.local`, `wh1@demo.local`, `patient@demo.local`. Everything named **[DEMO]** is test data, not real pharmacies or stock.

Containers: `cp .env.example .env` (set secrets) → `docker compose -f infra/docker-compose.yml up -d --build` (written, not yet executed — see docs/09).

## Repository layout
```
apps/api      NestJS API + worker, SQL migrations, tests
apps/web      Next.js web app (patient finder, pharmacy/warehouse dashboards, admin)
docs/         01 PRD & MVP · 02 architecture & ADRs · 03 data model/ERD · 04 API (+openapi.json) · 05 security & authz
              06 search & freshness · 07 supply chain · 08 integrations & notifications · 09 operations · 10 testing · 11 status
infra/        docker-compose          scripts/  setup, backup/restore, perf          .github/workflows/  CI
```

## Disclaimer
Availability information is reported by pharmacies and can change. This software does not provide medical advice, does not substitute medicines, and makes no claim of compliance with Egyptian regulations; legal review is required before production use.
