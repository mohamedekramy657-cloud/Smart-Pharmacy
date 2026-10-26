# 09 — Operations: Configuration, Deployment, Backup/Recovery, Monitoring

## Environment variables
All variables are documented in `.env.example`. The API validates them at startup (`config.ts`); with `NODE_ENV=production` it **refuses to start** with default secrets, insecure cookies, dev notification providers or the dev DB password.

## Local development (verified in the build sandbox, Debian 13)
```bash
bash scripts/dev-setup.sh          # PostgreSQL 17 + PostGIS 3.5, role/DBs/extensions, npm install, build, migrate, DEMO seed
cd apps/api && node dist/src/main.js                 # API on 127.0.0.1:4000 (worker included by default)
npm run build -w apps/web && node apps/web/.next/standalone/apps/web/server.js   # after copying .next/static (see Dockerfile)
npm test -w apps/api               # requires the pharma_test database
```
Demo accounts (DEV ONLY, password `DemoPass#2026` or `SEED_PASSWORD`): `admin@demo.local`, `ph1@demo.local` (pharmacy owner), `ph1.staff@demo.local`, `wh1@demo.local`, `patient@demo.local`. All demo organizations are named `[DEMO] …`.

## Deployment (pilot topology)
```
Internet → TLS/CDN/WAF → web (Next.js standalone, :3000) → api (NestJS, :4000, private) → PostgreSQL 17 + PostGIS (private)
                                                         ↘ worker (same image, worker.js)
```
- `infra/docker-compose.yml` + `apps/api/Dockerfile` + `apps/web/Dockerfile` (Node 22 LTS, non-root, healthchecks, one-shot `migrate` service before api/worker).
- **Status: written but NOT executed** — Docker is not available in the build sandbox. The CI workflow (`.github/workflows/ci.yml`) builds both images; first execution must happen in CI or on a Docker host.
- Database extensions (`postgis`, `pg_trgm`, `unaccent`) must be created by a superuser once (the postgis image does this for its default user; on managed services enable them in the console). Runtime role should not be superuser.
- Scaling: stateless API instances behind the web tier; run exactly one or more `worker` processes (safe concurrency via `SKIP LOCKED` + advisory locks); move rate limiting to a shared store before running >1 API instance.
- Super admin bootstrap: `ADMIN_EMAIL=… ADMIN_PASSWORD=… node apps/api/dist/src/database/create-admin.cli.js`, then enroll MFA.

## Backup & recovery (tested 2026-10-26 in the sandbox)
- Backup: `DATABASE_URL=… scripts/backup.sh /backups` → `pg_dump` custom format + SHA-256 file.
- Restore: create an empty DB with the three extensions, then `TARGET_DATABASE_URL=… scripts/restore.sh file.dump` → restores, prints `migrations=N` and `ledger_mismatches=0`.
- **Drill result:** `pharma_dev` backup (192 KB) restored into `pharma_restore_test`; identical counts (organizations 10, inventory items 25, movements 27, audit logs 89, search terms 55), 5 migrations, 0 ledger mismatches.
- Targets: pilot RPO ≤ 24 h (nightly dumps, 30-day retention, off-site copy, encrypted); production RPO ≤ 5 min via managed point-in-time recovery; RTO ≤ 4 h. Run a restore drill monthly and after major migrations.

## Monitoring
| Signal | Source | Alert when |
|---|---|---|
| Liveness / readiness | `GET /api/health/live`, `/api/health/ready` (DB + migrations) | readiness non-200 for 2 min |
| HTTP latency/errors | Prometheus `sp_http_request_duration_seconds` (`/api/metrics`, bearer `METRICS_TOKEN`) | p95 > 1 s or 5xx > 1 % for 5 min |
| Finder latency | `sp_finder_search_duration_seconds{outcome}` | p95 > 500 ms |
| Jobs | `sp_jobs_processed_total{outcome}`, admin overview `dead_jobs`, `delayed_jobs` | any DEAD job; delayed > 0 for 10 min |
| Auth abuse | `sp_auth_failures_total{reason}`, `security_events` (admin) | spike vs baseline |
| Integrations | admin overview `unhealthy_integrations` | any FAILING/STALE |
| Data integrity | `GET /api/v1/admin/ledger-check` (schedule daily) | `ok=false` |
| Logs | JSON (pino) with `X-Request-Id`; cookies/auth/CSRF/signatures redacted | error rate |

## Runbooks (abridged)
- **Integration STALE/FAILING:** check `integrations/:id/events` for errors; rotate secret if signature failures; patients already see unconfirmed data automatically.
- **Dead jobs:** inspect `last_error` in Admin → Jobs; fix cause; retry.
- **Ledger mismatch (should never happen):** freeze writes for the item (set `is_listed=false`), export movements, investigate; never "fix" by direct UPDATE — the guard trigger prevents it; correct through a documented `ADJUSTMENT` movement.
- **Suspected account compromise:** Admin → Users → suspend (revokes sessions); review audit logs by actor.
