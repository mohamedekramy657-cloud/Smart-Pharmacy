# 06 — Patient Search, Freshness & Ranking

## Flow
1. **Identify the exact product** — catalog search (`/catalog/medicines?q=`) over brand/generic/ingredient/alias terms in Arabic, English and transliteration (trigram + phonetic skeleton; barcode exact match). The UI never auto-selects: the patient picks a product showing strength, form, package and manufacturer. No automatic substitution — products with other strengths are separate catalog records.
2. **Location** — explicit GPS (consent text, rounded to 4 decimals, not stored), map pin (Leaflet, configurable tile provider, no API key in browser), or city/district centroid (works when geolocation is denied or the map provider is down; results are marked approximate).
3. **One indexed spatial query** to the maximum radius (`ST_DWithin` on `geography`, bounded by `finder.maxCandidates`), with database-level filters: exact medicine, verified + active pharmacy, listed line, no override, `available > 0`, updated within 30 days. The planner chooses medicine-first (`inventory_items_medicine_idx`) or space-first (`organizations_searchable_pharmacy_gix`) plans by statistics; both are index-driven (see docs/10 for the measured plan).
4. **Classification in code** (pure function `classifyListing`, unit-tested) and **progressive bands** (`finder.radiiKm`, default 5→10→20→40 km, admin-configurable, validated ascending and ≤ `finder.maxRadiusKm`): the search stops at the first band containing a qualifying listing (confirmed or recently-reported with sufficient quantity). Patients can explicitly expand to the maximum.

## Quantity definitions
`available = physical − reserved − unavailable` (never negative, DB-enforced). *Reserved* = warehouse allocations to confirmed POs or pharmacist holds. *Unavailable* = damaged/expired/quarantined/recalled units still physically present.

## Freshness (source-aware, configurable: `freshness.bySource`, per-pharmacy overrides)
| Source | Confirmed ≤ | Stale > |
|---|---|---|
| INTEGRATION | 2 h | 24 h |
| MANUAL / BARCODE / RECEIPT / SYSTEM | 12 h | 72 h |
| CSV_IMPORT | 24 h | 7 days |

Only movements that assert the real stock level refresh freshness (counts, sales, receipts, syncs, "still accurate" verification) — holds/allocations do not. A FAILING or STALE integration caps its listings at *recently reported (unconfirmed)*; failed integrations never look fresh.

## Availability states and ranking
| Status | Meaning | Rank group |
|---|---|---|
| AVAILABLE / LOW_STOCK | confirmed fresh, enough units | 0 |
| RECENT_UNCONFIRMED | between confirmed and stale windows | 1 |
| INSUFFICIENT_QUANTITY | fresh but fewer units than requested | 2 |
| STALE | older than stale window (≤ 30 days) | separate "outdated" section |
| OUT_OF_STOCK / TEMPORARILY_UNAVAILABLE | — | excluded |
| Expected incoming | dispatched shipment containing the product | separate section, **never** counted as stock |

Order within a band: rank group → open-now (configurable `ranking.preferOpenNow`: open, unknown, closed) → distance → most recent update. A closer unconfirmed listing never outranks a farther confirmed one (integration-tested).

## Outcomes (distinct no-result cases)
`FOUND`, `PARTIAL_QUANTITY_ONLY`, `NO_MATCHING_STOCK` (with verified-pharmacy coverage count), `NO_VERIFIED_STOCK` (only unverified pharmacies report it), `INVENTORY_DATA_UNAVAILABLE` (only stale data), `PRODUCT_UNAVAILABLE` (recalled/suspended/discontinued), `NOT_PUBLICLY_LISTED` (controlled medicines, policy setting `finder.includeControlled=false` by default), and HTTP `503` for service failure. The UI offers: expand search, availability alert, confirmation request, call, directions. Copy never promises stock will remain available.

## Disclosure
Exact quantities hidden by default (`finder.showExactQuantities=false` → buckets PLENTY/LIMITED); prices hidden unless enabled and verified (`finder.showPrices`).

## Confirmation requests & holds (instead of patient self-reservation)
Patients send a request (max pending per patient, duplicates rejected, expires after `requests.responseTimeoutMinutes`). Pharmacy staff answer *available / not available / hold*. A hold is created by staff only: atomic ledger movement (`reserved += qty`, fails if not available), unique pickup code, expiry (`holds.defaultMinutes`, max `holds.maxMinutes`), automatic release by the worker, fully audited. Integration test: two pharmacists racing to hold the last unit → exactly one succeeds.

## Availability alerts
Patients subscribe to a product near a (rounded) location; when a verified pharmacy's stock rises with fresh confirmed data, a background job notifies matching alerts once (then `TRIGGERED` until re-armed), deduplicated per day.
