# 11 — Phase Report & Status (2026-10-26)

## Phase status
| # | Phase | Status |
|---|---|---|
| 1 | Requirements & architecture | **Done** — PRD/MVP, architecture + ADRs, ERD, API spec (+OpenAPI), authz model, security assessment, plan, acceptance criteria, open decisions (docs 01–11) |
| 2 | Foundation | **Done** — migrations, auth (sessions, CSRF, lockout, TOTP MFA), RBAC + tenant isolation, audit, settings, job queue, health/metrics |
| 3 | Inventory | **Done for MVP** — ledger-guarded stock, counts/sales/write-offs/quarantine, batches & expiry, CSV import, barcode lookup, low-stock & expiry notifications, reconciliation |
| 4 | Supply chain | **Done for MVP** — relationships, POs with allocation, shipments, ETA history, receiving, discrepancies, incoming view, supplier metrics |
| 5 | Patient finder | **Done for MVP** — AR/EN catalog search, progressive radius search, freshness/ranking, distinct outcomes, incoming section, requests & holds, alerts |
| 6 | Notifications & analytics | **Partial** — in-app + dedupe + retries done; e-mail/SMS need real providers; analytics basic |
| 7 | Testing & security | **Partial** — 67 automated tests passing, audit clean; browser E2E, large-scale load test and penetration test pending |
| 8 | Pilot | Not started (needs real partners, legal review, hosting, providers) |
| 9 | Production readiness | Not started (Docker/CI execution, PITR, WAF, monitoring stack) |
| 10 | Advanced (forecasting, reorder AI, …) | Not started — evaluate after pilot data exists |

## Implemented functionality (all backed by PostgreSQL + real logic; no mock results)
- **Admin:** verification queue, approve/reject, suspend/reactivate (immediate removal from search), catalog CRUD with duplicate detection and recall/suspend, settings editor with validation, jobs/dead-letter retry, audit log, security events, integration health, ledger reconciliation, search analytics.
- **Pharmacy:** onboarding, inventory (add, count with optimistic concurrency, sale, external receipt, write-off, unavailable/restore, "still accurate"), movement history, CSV import, barcode lookup, supplier directory & relationships, PO create/submit/cancel/close, incoming view (ordered/confirmed/allocated/dispatched/received, ETA label, overdue), shipment receiving with discrepancies, patient requests & holds, integrations (signed webhooks), team management, dashboard + supplier comparison.
- **Warehouse:** inventory, customer approvals, order confirmation with atomic allocation / partial / reject, shipments (batch/expiry, carrier, ETA + confidence), dispatch, status, schedule changes with reasons, discrepancy resolution, dashboard.
- **Patient:** search without account or GPS, exact product selection, location by GPS / area / map pin, results with distance, verification, hours/open-now, availability + freshness + source, quantity bucket, directions/call, separate stale and incoming sections, confirmation requests (hold optional), alerts, notifications, Arabic (RTL, default) and English.

## Files / modules (main)
`apps/api/db/migrations/0001–0005*.sql` · `apps/api/src/common/**` (auth guard, sessions, permissions, errors, zod/OpenAPI, crypto, audit, settings, idempotency) · `apps/api/src/modules/{auth,organizations,catalog,inventory,supply,finder,patient,notifications,integrations,jobs,admin,analytics,health}` · `apps/api/src/database/{db,migrate,seed,create-admin,default-settings}.ts` · `apps/api/test/**` · `apps/web/app/**` (finder, login/register/business, account, notifications, org dashboard, admin) · `apps/web/components/**` · `apps/web/lib/{api,i18n,providers}` · `infra/docker-compose.yml`, `apps/*/Dockerfile`, `.github/workflows/ci.yml`, `.env.example`, `scripts/{dev-setup,reset-db,backup,restore}.sh`, `scripts/perf/*` · `docs/01–11`, `docs/openapi.json`.

## Tests executed & actual results
See docs/10. Summary: **67/67 automated tests pass** (5 suites, ≈13 s) including the full Section 28 acceptance workflow; finder p95 20 ms sequential / 134 ms at concurrency 10 on 3,000 synthetic pharmacies; backup/restore drill identical with 0 ledger mismatches; `npm audit --omit=dev` 0 vulnerabilities; production builds clean.

## Review loop — defects found and fixed during this phase
| Area | Finding | Fix |
|---|---|---|
| Admin | SQL used non-existent columns (`created_at`, `review_notes`) on verification/security tables — caught by the E2E test (HTTP 500) | corrected to `submitted_at`, `decision_notes`, `occurred_at` |
| API consistency | org profile returned snake_case nested JSON; public pharmacy read wrong keys | explicit camelCase `json_build_object` |
| Error handling | oversized bodies returned 500 | body-parser errors mapped to 413/400 |
| Catalog | `x` not folded, Ceftriaxone ≠ سيفترياكسون | skeleton maps `x→ks` (re-verified) |
| Auth | TOTP counter could go negative near epoch | clamped (+ test) |
| Supply chain dependencies | 2 high / 2 moderate advisories (multer, js-yaml) | scoped npm `overrides` to patched versions; audit clean; tests re-run |
| Performance method | synthetic generator gave all pharmacies the same 30 products (uncorrelated LATERAL) | correlated generator; re-measured |
| Ops | logs included every response header | serializer trimmed to status code |
| Deployment | preview iframe drops `SameSite=Lax` cookies | `COOKIE_SAMESITE`/`COOKIE_PARTITIONED` configurable; prod default stays `lax` |

## Known defects & limitations (disclosed)
1. **No automated browser/UI tests**; UI verified by production build, type-checking and HTTP smoke tests only — no visual QA was performed by the build agent.
2. Web UI gaps where the **API exists but no screen yet**: organization profile & opening-hours editing, price setting, manual batch editing, public pharmacy profile page, finder result pagination beyond the first page, admin user management screen.
3. Staff dashboards show some status codes as English enums; patient-facing text is fully bilingual.
4. No e-mail verification / password reset; no real e-mail/SMS provider (dev provider records `SKIPPED`, never "sent").
5. No free-text address geocoding (GPS, map pin, city/district only) — avoids sending addresses to third parties until a provider is chosen.
6. POS-specific connectors not built (generic signed-webhook contract only).
7. Docker images, compose stack and CI workflow are **written but not executed** (no Docker/CI runner in the sandbox).
8. Rate limiting is per-instance memory; must move to a shared store before horizontal scaling.
9. Stock unit = whole package (strip-level dispensing not modelled, D1).
10. Dev seed catalog entries are illustrative (`DEV_SEED`) and not verified against the EDA registry; area centroids approximate.
11. Build sandbox runs Node 20 (EOL); targets Node 22 LTS.

## Security concerns open
Pen test not done; WAF/CDN not configured; legal review pending (privacy notice, PDPL, controlled-substance display, liability); manual pharmacy verification depends on admin diligence; preview mode uses `SameSite=None`.

## Unresolved business decisions (safe defaults applied, all configurable)
D1–D10 in docs/01 (stock unit, prices, controlled medicines, freshness windows, radii, QC hold, warehouse disclosure, hold authority, regulatory basis, map provider), plus:
- **D11** — production notification providers (e-mail service, Egyptian SMS gateway) and message content approval.
- **D12** — pharmacy verification evidence (document uploads, regulator registry lookup) and re-verification cadence.
- **D13** — hosting region and data residency for patient data.

## Next actions (recommended order)
1. Run CI + Docker builds on a real runner; fix anything environment-specific.
2. Choose providers (D10 tiles, D11 messaging) and implement password reset + e-mail verification.
3. Complete the UI gaps listed above; add Playwright tests for the Section 28 flow in the browser.
4. Legal review (D9) and pilot agreement with 5–10 Ismailia pharmacies + 1 warehouse; import a verified catalog subset (EDA data) replacing DEV_SEED entries.
5. Pilot instrumentation: measure real freshness, confirmation response times and search outcomes; tune D4/D5.
6. Production readiness: managed PostgreSQL with PITR, shared rate-limit store, WAF, alerting on the metrics in docs/09.
7. Roadmap after pilot data: reorder suggestions from sales velocity (transparent rules first), supplier scorecards, demand signals from unmet searches, optional AI query normalization (non-authoritative, catalog-constrained).
