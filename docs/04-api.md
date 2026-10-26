# 04 — API Specification

- **Machine-readable spec:** `docs/openapi.json` (OpenAPI 3, generated from the live route definitions with `node apps/api/dist/src/openapi.cli.js`; 95 paths at the time of writing). Interactive docs at `/api/docs` when `SWAGGER_ENABLED=true`.
- **Base path:** `/api/v1` (health/metrics under `/api`). Browsers reach it same-origin through the Next.js proxy.

## Conventions

| Topic | Rule |
|---|---|
| Format | JSON only. Mutating requests with any other `Content-Type` → `415`. Bodies ≤ 1 MB (`413`). |
| Validation | Strict zod schemas (unknown fields rejected) → `400 VALIDATION_FAILED` with `details[] {path, message}`. UUID path params validated before DB access. |
| Errors | `{ "error": { "code", "message", "details?", "requestId" } }`. Clients branch on `code` (e.g. `INSUFFICIENT_STOCK`, `INVALID_STATE_TRANSITION`, `STALE_VERSION`, `ORG_NOT_VERIFIED`, `ORG_SUSPENDED`, `CSRF_FAILED`, `MFA_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`). |
| Auth | Session cookie (`sp_session` / `__Host-sp_session` when secure) + `X-CSRF-Token` header (value of the `sp_csrf` cookie) on every state-changing request. |
| Idempotency | `Idempotency-Key` header (8–128 chars) on create PO, confirm PO, create/dispatch/receive shipment, inventory add/adjust, patient requests and responses. Same key + same body → stored response, never re-applied; same key + different body → `422`. |
| Concurrency | Row locks + DB constraints; optional `expectedVersion` on stock adjustments → `409 STALE_VERSION`. |
| Tenancy | Org resources live under `/orgs/:orgId/...`; non-members get `404` (existence not disclosed). |
| Rate limits | Per client IP: global, auth (10/min), finder (60/min) — configurable; `429 RATE_LIMITED`. |
| Pagination | `page` / `pageSize` (bounded) with `total`; finder results bounded by `finder.maxCandidates`. |
| Tracing | Every response carries `X-Request-Id` (also stored in audit logs). |

## Endpoint groups

| Group | Endpoints (abridged) | Access |
|---|---|---|
| Auth | `POST /auth/register`, `/auth/register-organization`, `/auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/mfa/setup`, `/auth/mfa/enable`, `/auth/password` | public / signed-in |
| Patient finder | `GET /finder/search`, `GET /finder/pharmacies/:id`, `GET /geo/cities`, `GET /geo/cities/:id/districts`, `GET /catalog/medicines?q=`, `GET /catalog/medicines/:id` | public |
| Me | `GET/POST /me/requests`, `POST /me/requests/:id/cancel`, `GET/POST/PATCH/DELETE /me/alerts`, `GET /me/notifications`, `POST /me/notifications/read`, `GET/PATCH /me/preferences` | signed-in (own data only) |
| Organization | `GET/PATCH /orgs/:orgId`, `PUT /orgs/:orgId/opening-hours`, members CRUD | org members by permission |
| Inventory | `GET/POST /orgs/:orgId/inventory`, `GET/PATCH /inventory/:itemId`, `POST .../adjustments`, `POST .../verify`, `PUT .../price`, `PUT .../batches`, `GET .../movements`, `GET /inventory/barcode/:code`, `GET /inventory/expiring`, `POST /inventory/imports` | `inventory:*` |
| Supply | relationships, `warehouses` directory + products, purchase orders (create/submit/confirm/reject/cancel/close), shipments (create/dispatch/status/schedule/cancel/receive), `incoming`, discrepancies | `supply:*`, org type + verification enforced |
| Patient requests (pharmacy side) | `GET /orgs/:orgId/confirmation-requests`, `POST .../respond`, `GET /holds`, `POST /holds/:id/fulfill`, `POST /holds/:id/release` | `requests:respond` |
| Integrations | `GET/POST /orgs/:orgId/integrations`, rotate secret, pause, events; `POST /integrations/webhooks/:id` (HMAC-signed, no cookies) | `integrations:manage` / signature |
| Analytics | `GET /orgs/:orgId/analytics/dashboard` | `analytics:read` |
| Admin | overview, verifications, organizations (status, edit), users, medicines (CRUD, status, aliases), settings, permissions, jobs (+retry), audit logs, security events, integrations health, ledger check, platform analytics | `SUPER_ADMIN` (+MFA if `ADMIN_MFA_REQUIRED`) |
| Health | `GET /api/health/live`, `GET /api/health/ready`, `GET /api/metrics` (Prometheus, optional bearer token) | public / token |

## Finder response (shape)

```json
{
  "outcome": "FOUND | PARTIAL_QUANTITY_ONLY | NO_MATCHING_STOCK | NO_VERIFIED_STOCK | INVENTORY_DATA_UNAVAILABLE | PRODUCT_UNAVAILABLE | NOT_PUBLICLY_LISTED",
  "matchedRadiusKm": 5, "searchedRadiusKm": 5, "radiiKm": [5, 10, 20, 40],
  "medicine": { "id": "…", "brandNameEn": "…", "strength": "…", "dosageForm": "…", "status": "ACTIVE" },
  "results": [{ "pharmacy": { "id": "…", "verified": true, "openNow": true, "isDemo": false, "…": "…" },
                "distanceKm": 1.5, "bandKm": 5,
                "availability": { "status": "AVAILABLE", "freshness": "CONFIRMED", "lastUpdatedAt": "…", "source": "RECEIPT",
                                  "quantity": null, "quantityBucket": "PLENTY", "sufficientForRequest": true },
                "price": null, "directions": { "google": "…", "osm": "…" } }],
  "stale": [], "incoming": [{ "pharmacyId": "…", "estimatedDeliveryAt": "…", "deliveryDateStatus": "ESTIMATED", "label": "EXPECTED_INCOMING" }],
  "coverage": { "verifiedPharmaciesWithinMaxRadius": 7 }, "total": 1, "latencyMs": 19,
  "disclaimer": "Availability is reported by pharmacies and may change…"
}
```
A database/service outage returns `503 SERVICE_UNAVAILABLE` (distinct from every "no results" outcome).

## Webhook contract (inventory integrations)

`POST /api/v1/integrations/webhooks/:integrationId` with headers `X-SP-Timestamp: <unix seconds>` and `X-SP-Signature: hex(HMAC_SHA256(secret, timestamp + "." + rawBody))`. Requests older than 5 minutes are rejected (replay protection). Body:
```json
{ "eventId": "pos-123", "type": "STOCK_SNAPSHOT", "occurredAt": "2026-10-26T10:00:00Z",
  "items": [{ "barcode": "6221234567890", "physicalQty": 40 }, { "medicineId": "uuid", "physicalQty": 0 }] }
```
Snapshots are absolute counts. Duplicate `eventId` → `{"status":"DUPLICATE"}` (not re-applied); snapshots older than the last applied event for a product are skipped; unknown products are reported per item (`PARTIALLY_APPLIED`).
