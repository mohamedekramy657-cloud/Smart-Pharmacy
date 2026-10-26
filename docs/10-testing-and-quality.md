# 10 — Testing & Quality (actual results)

All numbers below were produced in the build sandbox (2 vCPU, 1.9 GiB RAM + 3 GiB swap, Debian 13, Node 20.20.2, PostgreSQL 17.11 + PostGIS 3.5.2) on 2026-10-26.

## Automated test suites (`npm test -w apps/api`, Jest + SWC, real PostgreSQL `pharma_test`)
| Suite | Tests | Covers |
|---|---:|---|
| `test/unit/business-rules.spec.ts` | 19 | freshness windows & integration caps, availability classification, rank groups, quantity buckets, PO/shipment state machines, delivery-date labels, permission matrix, TOTP RFC 6238 vectors, AES-GCM tamper detection, production config refusal, open-now incl. overnight, medicine identity keys, CSV parser, backoff, settings schemas |
| `test/integration/e2e-core-workflow.spec.ts` | 12 | **Section 28 acceptance test, steps 1–20** over HTTP |
| `test/integration/finder.spec.ts` | 13 | 5 km hit, 10/20/40 km expansion, none within max, stale data, warehouse-only stock, unverified pharmacies, suspension, recall, controlled, similar names/different strengths (AR/EN/misspelled), geolocation denied (city), ranking reliability, failing integration, admin radius config, malicious input |
| `test/integration/supply-and-concurrency.spec.ts` | 9 | over-allocation rejected, partial confirmation, no double allocation, cancel after allocation (released), no cancel after dispatch, double dispatch, damaged+missing discrepancies, partial receipt over two shipments, overdue (expected not arrived), mid-transaction failure rollback, hold race for last unit, 8 concurrent sales on 5 units, duplicate & out-of-order webhook events, replay-window, CSV all-or-nothing + re-import |
| `test/integration/security-and-jobs.spec.ts` | 14 | cookie flags, CSRF, form-encoded rejection, logout revocation, enumeration-safe errors, lockout, rate limiting, strict validation, 413, org type/membership/object ownership, admin MFA via TOTP, password-change session revocation, notification dedupe, retry/backoff/dead-letter + admin retry, honest dev e-mail status, low-stock notification, alert matching, request lifecycle + expiry |
| **Total** | **67 passed / 67** | run time ≈ 13 s |

Section 21 scenarios not covered by automated tests: *map provider down* (UI-level fallback, manual check only) and *notification retry against a real provider* (no provider configured; retry mechanics are tested with failing handlers).

## Other verification performed
- Direct SQL tests of migrations: normalization/skeleton outputs, ledger guard (direct insert/update rejected), idempotent replay, oversell CHECK, append-only ledger, 0 mismatches.
- `tsc` strict builds: API and web clean; `next build` production build succeeds (9 routes).
- Live smoke tests through the Next.js proxy: catalog AR search, finder, login cookies (`HttpOnly; Secure; Partitioned; SameSite=None` in preview mode), `/auth/me`, Arabic RTL rendering, CSP headers.
- Backup → restore drill (docs/09).
- `npm audit --omit=dev`: **0 vulnerabilities** (after pinning patched transitive `multer` 2.5.0 and `js-yaml` 5.5.0 via `overrides`; initially 2 high + 2 moderate).
- Dev seed: 10 demo organizations, 27 ledger movements, `sp_inventory_ledger_mismatches()` = 0.

## Performance (synthetic dataset, `scripts/perf/`)
Dataset: 3,000 pharmacies (5 % unverified) over ~150 × 110 km, 200 medicines, 90,000 stock lines created through the ledger function (0 mismatches).
- Query plan (`EXPLAIN ANALYZE`, popular medicine, 40 km radius): bitmap index scan on `inventory_items_medicine_idx` → PK lookups on organizations; **15 ms** execution; no sequential scans. The planner switches to the GiST index when the spatial predicate is more selective.
- HTTP `/finder/search` (random medicine/origin, full pipeline incl. classification, incoming section and analytics insert), API + PostgreSQL + Next.js on the same 2-vCPU box:

| Mode | n | p50 | p95 | p99 | max | throughput |
|---|---:|---:|---:|---:|---:|---:|
| sequential | 300 | 15.0 ms | 20.1 ms | 23.4 ms | 37.9 ms | — |
| 10 concurrent | 300 | 84 ms | 134 ms | 363 ms | 424 ms | 109 req/s |

Caveat: the dataset is dense (every search returned FOUND), so real-world spatial distributions and larger catalogs must be re-measured during the pilot.

## Quality gates (CI, `.github/workflows/ci.yml` — not yet executed on a runner)
`npm ci` → `npm audit --omit=dev --audit-level=high` → API build → API tests against PostGIS service → web type-check → web build → Docker image builds.
