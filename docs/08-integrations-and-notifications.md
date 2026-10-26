# 08 — Integrations, Sync Design & Notifications

## Inventory sync options (per organization)
| Method | Status | Freshness source |
|---|---|---|
| Manual entry / stock count / "still accurate" verification | Implemented | MANUAL |
| Barcode-assisted lookup (keyboard-wedge scanners) | Implemented (lookup + adjust) | BARCODE (client-declared) |
| CSV import (snapshot semantics, all-or-nothing, re-upload of same file is a no-op) | Implemented | CSV_IMPORT |
| Signed webhook stock snapshots from POS/ERP | Implemented (contract in docs/04) | INTEGRATION |
| Pull connectors to specific POS vendors | **Not implemented** (needs partner APIs; adapter interface = webhook contract) | — |

### Webhook processing guarantees
Signature + timestamp verified on the raw body → event inserted with `UNIQUE(config, external_event_id)` (duplicates acknowledged, not re-applied) → per item: product resolved by id/barcode, out-of-order snapshots skipped via `last_external_event_at`, quantity applied as an `INTEGRATION_SYNC` ledger movement (idempotency key = event) → event marked `PROCESSED / PARTIALLY_APPLIED / FAILED`; integration health updated.

### Health & failure handling
- Consecutive failures ≥ `integrations.failingAfterFailures` → `FAILING` (managers notified).
- No successful event for `expected_interval × integrations.staleAfterIntervals` → `STALE` (periodic worker task).
- FAILING/STALE integrations can never yield "confirmed" listings; data degrades to unconfirmed and then stale. Senders retry on non-2xx (at-least-once delivery is safe because processing is idempotent).

## Background jobs (PostgreSQL queue — no Redis)
- **Outbox:** jobs are inserted in the same transaction as the business change, so side effects exist iff the change committed.
- **Workers** claim with `FOR UPDATE SKIP LOCKED`; retries with exponential backoff and jitter (5 s → … ≤ 1 h); `DEAD` after `max_attempts` (admin can retry); stuck RUNNING jobs are recovered after 10 min.
- **Periodic tasks** run on one instance at a time (advisory locks): expire holds & requests (30 s), integration health (2 min), overdue shipments (5 min), expiring batches (6 h), expire alerts (1 h), retention purge (12 h).
- Run inside the API (`WORKER_ENABLED=true`, single node) or as a separate process (`node dist/src/worker.js`).

## Notifications
- In-app notifications for every workflow event (PO submitted/decided/cancelled, dispatch, status/ETA change, delay, overdue, receipt, discrepancy updates, confirmation requests and replies, hold expiry, availability alerts, verification decisions, org status, integration failures, low stock, expiring batches) in the recipient's language (Arabic/English templates).
- **Deduplication:** `UNIQUE(user_id, dedupe_key)`; e.g. low-stock once per item per day, alert once per alert/pharmacy/day.
- **E-mail/SMS:** delivery rows + `notification.deliver` jobs with retry. Provider adapters implement `MessageProvider`. **No production provider is configured**: the development `dev-log` provider records deliveries as `SKIPPED` with the reason "logged, not delivered" — it never reports a message as sent. Production must configure a real provider (e.g. an SMTP/SES service and an Egyptian SMS gateway) — open decision D11 (see docs/11-status-report.md).
