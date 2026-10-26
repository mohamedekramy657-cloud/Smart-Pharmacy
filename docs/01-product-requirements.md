# 01 — Product Requirements & MVP Definition

Status: **Phase 1 deliverable** · Owner: Product/Architecture · Last updated: 2026-10-26

## 1. Problem statement

Patients in Egypt often visit several pharmacies to find a specific medicine (exact strength and form). Pharmacies have little visibility into warehouse stock and delivery schedules, and warehouses have little visibility into pharmacy demand. The platform links **standardized medicine identity → pharmacy & warehouse inventory → supply orders & shipments → patient search**. Every availability claim must state how reliable it is.

## 2. Users and primary jobs

| Persona | Primary job | Success signal |
|---|---|---|
| Patient / public user | Find the nearest pharmacy that has *this exact medicine* in the quantity needed | Finds a reliable listing within minutes, and the listing turns out to be correct |
| Pharmacy staff (owner, manager, staff, viewer) | Keep stock accurate, reorder before running out, receive deliveries correctly | Low effort to maintain stock, fewer stockouts |
| Warehouse staff | Receive, confirm, allocate and ship pharmacy orders with reliable schedules | High fulfillment rate, on-time deliveries |
| Super administrator | Verify organizations, curate the catalog, monitor data quality and security | Only verified, trustworthy data reaches patients |

## 3. Vocabulary (normative definitions)

### 3.1 Quantity semantics (each is a separate stored value)

| Term | Definition | Where stored |
|---|---|---|
| **Physical stock** | Sellable-form units physically held by the organization (counted in *catalog packages*) | `inventory_items.physical_qty` |
| **Reserved stock** | Physical units promised to a specific counterparty and not yet removed (patient holds at pharmacies, PO allocations at warehouses) | `inventory_items.reserved_qty` |
| **Unavailable stock** | Physical units that must not be sold: damaged, expired, quarantined/QC hold, recalled | `inventory_items.unavailable_qty` |
| **Available stock** | `physical − reserved − unavailable`. A DB-generated column, never written directly, with a `CHECK ≥ 0` | `inventory_items.available_qty` |
| Requested qty | What the pharmacy asked for on a purchase order line | `purchase_order_items.requested_qty` |
| Confirmed qty | What the warehouse committed to supply (≤ requested) | `purchase_order_items.confirmed_qty` |
| Allocated qty | Confirmed units reserved in warehouse stock, not yet dispatched | `purchase_order_items.allocated_qty` |
| Dispatched qty | Units that physically left the warehouse on shipments | `purchase_order_items.dispatched_qty`, `shipment_items.quantity` |
| Received qty | Units accepted into pharmacy stock at receipt | `received_qty` (PO line & shipment item) |
| Damaged / missing qty | Dispatched units that were rejected at receipt or never arrived | `damaged_qty`, `missing_qty` |

Invariants enforced by the database: `allocated + dispatched ≤ confirmed ≤ requested`; `received + damaged + missing ≤ dispatched`; all quantities ≥ 0. **Pharmacy stock changes only through the receiving workflow**, never because a PO exists or a shipment was dispatched.

### 3.2 Availability states shown to patients

| State | Meaning | Shown as current availability? |
|---|---|---|
| `AVAILABLE` (Confirmed) | Available qty ≥ requested, and the last stock assertion is within the *confirmed* freshness window for its source | Yes, labeled "Confirmed in stock" |
| `LOW_STOCK` | Same as AVAILABLE, but at or below the pharmacy's low-stock threshold | Yes, labeled "Limited stock" |
| `RECENT_UNCONFIRMED` | Stock reported within the *stale* window but older than the confirmed window, or the source integration is failing | Yes, labeled "Reported in stock (unconfirmed), call first" and ranked below confirmed listings |
| `STALE` | Last stock assertion is older than the stale threshold | No. Shown only in a separate "outdated information" section, if enabled |
| `INSUFFICIENT_QUANTITY` | In stock, but less than the requested quantity | Separate tier, labeled with the quantity gap |
| `OUT_OF_STOCK` | Fresh data shows 0 available | No |
| `TEMPORARILY_UNAVAILABLE` | Pharmacy override (e.g., stock-taking) | No |
| `PENDING_VERIFICATION` | Organization not yet verified by an administrator | Never searchable |
| `UNKNOWN` | No inventory record for this medicine at this pharmacy | Never claimed |
| `EXPECTED_INCOMING` | Open shipment or confirmed PO line toward the pharmacy | Separate "Expected incoming stock" section only |

### 3.3 Search outcomes (distinct, never conflated)

* `FOUND`: at least one confirmed or recent listing within the searched radius.
* `NO_VERIFIED_STOCK`: listings exist, but all are stale. They are shown separately, and the patient is told to call ahead.
* `NO_MATCHING_STOCK`: participating verified pharmacies exist in range, but none reports the medicine in the requested quantity. The wording is *"No participating pharmacy within X km reports…"*, never "no pharmacy has it".
* `INVENTORY_DATA_UNAVAILABLE`: no verified participating pharmacy exists within the maximum radius (coverage gap).
* `SERVICE_UNAVAILABLE`: technical failure (HTTP 503). The UI shows a retry message, not "no results".

## 4. MVP scope

### In scope (MVP / first E2E milestone)
1. Secure authentication (argon2id, server-side sessions, CSRF, lockout, rate limits); RBAC with organization isolation; TOTP MFA available for administrators.
2. Organization onboarding (pharmacy / warehouse), admin verification, suspension, reactivation; profiles; opening hours.
3. Central medicine catalog with ingredients, clinical identity key (duplicate prevention), aliases, Arabic/English normalized and transliteration-tolerant search, product status (recall/suspend).
4. Unified inventory engine for pharmacies and warehouses: append-only movement ledger, DB-enforced invariants, adjustments, stock counts, verification ("still accurate"), batches/expiry, low-stock flags, CSV import (validate → commit), barcode lookup.
5. Supply chain: supply relationships, purchase orders, warehouse confirm/partial/reject with **atomic allocation**, shipments, dispatch, status updates, delivery schedule history with confidence levels, pharmacy receiving with damaged/missing handling, discrepancies, cancellation with allocation release.
6. Patient finder: product disambiguation, location via GPS (opt-in) / district / map click, a single indexed PostGIS query processed in configurable distance bands (5 → 10 → 20 → 40 km), freshness-aware transparent ranking, separate expected-incoming section, distinct no-result outcomes.
7. Stock confirmation requests, with optional **pharmacist-created holds** (atomic reservations with expiry).
8. Availability alerts and in-app notifications through a transactional PostgreSQL job queue (retry with backoff, dead-lettering, dedupe). Email/SMS through provider adapters, with a clearly labeled development log provider.
9. Inventory webhook integration (HMAC-signed, idempotent, out-of-order-safe), integration health, and freshness downgrade on failure.
10. Admin console: verification, catalog, settings (radii, freshness, ranking), audit logs, security events, integration health, job dead-letter queue, ledger integrity check.
11. Basic analytics for pharmacy, warehouse and platform (measured values only).

### Explicitly out of scope for MVP (with reason)
| Item | Reason |
|---|---|
| Payments, online medicine sales, patient delivery | Legal and regulatory assessment required (prescription verification, EDA rules) |
| Patient self-service reservations | Not reliable while counter sales are not synchronized. Replaced by pharmacist-created holds |
| Automatic substitution or alternative-medicine suggestions | Clinical safety: requires pharmacist oversight and a regulatory basis |
| Live POS/ERP connectors for specific vendors | No credentials or endpoints available. A generic signed webhook contract is provided |
| Partial-pack (strip) quantities | Open business decision (see §7). MVP counts whole catalog packages |
| ML forecasting | Insufficient historical data. Transparent heuristics are labeled as estimates |
| Native mobile apps, push notifications | Responsive web first; push is a later adapter |

## 5. Functional requirements (traceable IDs)

* **FR-AUTH-1..6**: register (patient), register organization (owner + pending org), login/logout, session expiry (idle 30 min and absolute 12 h, configurable), lockout after 5 failures for 15 min, admin MFA (TOTP).
* **FR-ORG-1..5**: profile CRUD (legal and location fields locked after verification), opening hours incl. overnight and 24 h, member management by owner, verification workflow, suspension (immediately revokes search visibility and write access).
* **FR-CAT-1..6**: catalog CRUD (admin), identity key uniqueness, similar-name warning requiring explicit confirmation, aliases, status changes with reason and audit, public search (AR/EN/transliteration) returning distinguishing attributes.
* **FR-INV-1..10**: add product, opening balance, adjustments by reason code, absolute stock count, verify-unchanged, mark unavailable/restore, batches/expiry, low-stock threshold and alerts, CSV import (all-or-nothing), movement history; all with idempotency keys and optimistic version checks.
* **FR-SUP-1..12**: relationships, PO create/submit/cancel, warehouse confirm (full/partial)/reject with allocation, shipments (create/dispatch/status/schedule), receipt (received/damaged/missing), discrepancies (report/acknowledge/resolve), incoming view, supplier performance.
* **FR-FIND-1..9**: product search & disambiguation, location methods, banded progressive search, freshness/eligibility filtering, ranking, result cards, incoming section, outcomes, confirmation requests & alerts.
* **FR-NOT-1..5**: in-app notifications, preferences, dedupe, job retries & dead letters, provider adapters.
* **FR-ADM-1..9**: verification queue, catalog, settings, audit logs, security events, integrations, jobs, integrity check, platform metrics.

## 6. Non-functional requirements (pilot targets, to be re-baselined after the pilot)

| Area | Target |
|---|---|
| Finder search latency (server, p95) | < 300 ms at pilot scale; < 500 ms at a 10k-pharmacy synthetic scale (measured: see docs/10) |
| API availability | 99.5% monthly during pilot |
| Data durability | Daily logical backups (RPO ≤ 24 h) for pilot; managed PITR (RPO ≤ 5 min) before production |
| Recovery | RTO ≤ 4 h for pilot; restore procedure tested (docs/09) |
| Security | OWASP ASVS L2-aligned controls; no secrets in code; tenant isolation tested |
| Accessibility | WCAG 2.1 AA intent: keyboard, contrast, labels, RTL |
| Privacy | No precise location history; search analytics store only a coarse ~1 km cell; IPs are stored as keyed hashes |

## 7. Assumptions & open business decisions

Defaults are chosen so they are safe; every item marked ⚙ is a runtime setting.

| # | Decision needed | MVP default | Why it matters |
|---|---|---|---|
| D1 | Unit of stock: whole packs vs strips | Whole catalog packages | Egyptian pharmacies often sell strips; changes the quantity model |
| D2 | Show prices to patients? | Off by default ⚙ (`finder.showPrices`); prices are stored only when verified | Prices are regulated; must confirm display rules |
| D3 | Controlled medicines in public search | **Excluded** from public availability ⚙ (`finder.includeControlled=false`) | Diversion risk; legal review required |
| D4 | Freshness thresholds per source | Integration: confirmed ≤ 2 h, stale > 24 h; manual/barcode/receipt: ≤ 12 h / > 72 h; CSV: ≤ 24 h / > 7 d ⚙; per-pharmacy override | Needs pilot measurement |
| D5 | Radius bands | 5, 10, 20, 40 km; max 40 km ⚙ | Rural coverage may need more |
| D6 | Receiving QC hold | Off ⚙ (`receiving.quarantineOnReceipt`) | Some pharmacies need quarantine before sale |
| D7 | Warehouse quantity disclosure to pharmacies | Availability buckets only (In stock / Limited / Out), not exact counts | Commercially sensitive |
| D8 | Who may create holds for patients | Pharmacy staff only, while responding to a confirmation request | Avoids phantom reservations |
| D9 | Regulatory basis (EDA licensing, Personal Data Protection Law No. 151/2020) | Not claimed; legal review before production | Compliance cannot be self-certified |
| D10 | Map tile provider | OSM-standard tiles for development only ⚙ (`NEXT_PUBLIC_MAP_TILE_URL`); production needs a commercial or self-hosted provider | OSM tile policy forbids heavy use |

## 8. Acceptance criteria — first E2E milestone (spec §28)

Each step is verified by `apps/api/test/integration/e2e-core-workflow.spec.ts` against a real PostgreSQL+PostGIS database:

1. Admin verifies a pharmacy and a warehouse → status `VERIFIED`, audit rows exist.
2. The catalog contains a standardized medicine with an identity key.
3. The pharmacy registers the medicine and authorized staff set stock → ledger rows; `available = physical − reserved − unavailable`.
4. The warehouse has stock; the pharmacy creates and submits a PO; the warehouse confirms → warehouse `reserved_qty` increases atomically.
5. A patient searches from a selected location: 5 km is searched first; with no suitable result the search expands to 10/20/40 km; results show distance, medicine details, availability tier and last update; expected incoming stock is listed separately.
6. The warehouse dispatches and updates the schedule → warehouse physical & reserved decrease; **pharmacy stock unchanged**.
7. The pharmacy receives with a shortage → pharmacy physical increases by the received qty only; a `RECEIPT` movement and a discrepancy are created; the PO becomes `PARTIALLY_DELIVERED`.
8. A subsequent search reflects the new stock.
9. Unauthorized actors (other pharmacy, other warehouse, patient, anonymous) get 401/403/404 and no data changes.
10. The ledger integrity check reports zero mismatches.
