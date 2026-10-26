-- 0003_inventory.sql — unified inventory engine for pharmacies and warehouses.
-- Invariants (DB-enforced):
--   * physical, reserved, unavailable >= 0 and available = physical - reserved - unavailable >= 0
--   * quantities change ONLY inside sp_apply_inventory_movement (trigger guard)
--   * every change writes an append-only movement row with before/after balances
--   * idempotency: (inventory_item_id, idempotency_key) is unique

CREATE TABLE integration_configs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                      text NOT NULL CHECK (kind IN ('INVENTORY_WEBHOOK', 'POS_API', 'WMS_API', 'ERP_API')),
  display_name              text NOT NULL,
  status                    text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'DISABLED')),
  health                    text NOT NULL DEFAULT 'UNKNOWN' CHECK (health IN ('UNKNOWN', 'HEALTHY', 'FAILING', 'STALE')),
  secret_enc                text,
  secret_last4              text,
  expected_interval_minutes integer NOT NULL DEFAULT 60 CHECK (expected_interval_minutes > 0),
  last_event_at             timestamptz,
  last_success_at           timestamptz,
  last_failure_at           timestamptz,
  consecutive_failures      integer NOT NULL DEFAULT 0,
  last_error                text,
  created_by                uuid REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_configs_org_idx ON integration_configs (organization_id);
CREATE TRIGGER integration_configs_touch BEFORE UPDATE ON integration_configs FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE TABLE inventory_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  medicine_id            uuid NOT NULL REFERENCES medicines(id),
  physical_qty           integer NOT NULL DEFAULT 0 CHECK (physical_qty >= 0),
  reserved_qty           integer NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  unavailable_qty        integer NOT NULL DEFAULT 0 CHECK (unavailable_qty >= 0),
  available_qty          integer GENERATED ALWAYS AS (physical_qty - reserved_qty - unavailable_qty) STORED,
  low_stock_threshold    integer CHECK (low_stock_threshold >= 0),
  is_listed              boolean NOT NULL DEFAULT true,        -- visible to patient search
  availability_override  text CHECK (availability_override IN ('TEMPORARILY_UNAVAILABLE')),
  override_reason        text,
  unit_price             numeric(12, 2) CHECK (unit_price >= 0),
  price_currency         char(3) NOT NULL DEFAULT 'EGP',
  price_verified_at      timestamptz,
  last_updated_at        timestamptz NOT NULL DEFAULT now(),   -- last time a source asserted the stock level
  last_update_source     text NOT NULL DEFAULT 'MANUAL' CHECK (last_update_source IN (
                           'MANUAL', 'BARCODE', 'CSV_IMPORT', 'INTEGRATION', 'RECEIPT', 'SYSTEM')),
  last_verified_at       timestamptz,                          -- last physical count / explicit verification
  last_external_event_at timestamptz,                          -- ordering guard for integration snapshots
  integration_config_id  uuid REFERENCES integration_configs(id) ON DELETE SET NULL,
  version                integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_available_nonnegative CHECK (physical_qty - reserved_qty - unavailable_qty >= 0),
  UNIQUE (organization_id, medicine_id)
);
-- Finder access path: medicine -> organizations holding it, with the columns needed for filtering.
CREATE INDEX inventory_items_medicine_idx ON inventory_items (medicine_id)
  INCLUDE (organization_id, available_qty, last_updated_at, last_update_source, is_listed, availability_override);
CREATE INDEX inventory_items_org_idx ON inventory_items (organization_id);
CREATE INDEX inventory_items_low_stock_idx ON inventory_items (organization_id)
  WHERE low_stock_threshold IS NOT NULL AND available_qty <= low_stock_threshold;

CREATE TABLE inventory_movements (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_item_id   uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL,
  medicine_id         uuid NOT NULL,
  movement_type       text NOT NULL CHECK (movement_type IN (
                        'OPENING_BALANCE', 'ADJUSTMENT', 'STOCK_COUNT', 'COUNT_VERIFIED', 'CSV_IMPORT',
                        'INTEGRATION_SYNC', 'RECEIPT', 'SALE', 'DISPATCH', 'HOLD_CREATE', 'HOLD_RELEASE',
                        'HOLD_FULFILL', 'ALLOCATION', 'ALLOCATION_RELEASE', 'MARK_UNAVAILABLE',
                        'RESTORE_AVAILABLE', 'WRITE_OFF', 'QC_RELEASE')),
  physical_delta      integer NOT NULL DEFAULT 0,
  reserved_delta      integer NOT NULL DEFAULT 0,
  unavailable_delta   integer NOT NULL DEFAULT 0,
  physical_after      integer NOT NULL,
  reserved_after      integer NOT NULL,
  unavailable_after   integer NOT NULL,
  source              text NOT NULL,
  reason_code         text,
  note                text,
  reference_type      text,
  reference_id        uuid,
  actor_user_id       uuid,
  idempotency_key     text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_item_idx ON inventory_movements (inventory_item_id, id DESC);
CREATE INDEX inventory_movements_org_time_idx ON inventory_movements (organization_id, created_at DESC);
CREATE INDEX inventory_movements_ref_idx ON inventory_movements (reference_type, reference_id);
CREATE UNIQUE INDEX inventory_movements_idem_uq ON inventory_movements (inventory_item_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Deletes are only allowed through ON DELETE CASCADE of an organization (data retention purge).
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION sp_prevent_mutation();

CREATE TABLE inventory_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id  uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  batch_number       text NOT NULL CHECK (length(batch_number) BETWEEN 1 AND 64),
  expiry_date        date NOT NULL,
  quantity           integer NOT NULL CHECK (quantity >= 0),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'RECALLED', 'DEPLETED')),
  source_shipment_item_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inventory_item_id, batch_number, expiry_date)
);
CREATE INDEX inventory_batches_expiry_idx ON inventory_batches (expiry_date) WHERE status = 'ACTIVE' AND quantity > 0;
CREATE TRIGGER inventory_batches_touch BEFORE UPDATE ON inventory_batches FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

-- Guard: quantity columns can only change inside sp_apply_inventory_movement.
CREATE OR REPLACE FUNCTION sp_guard_inventory_quantities() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('sp.ledger_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.physical_qty <> 0 OR NEW.reserved_qty <> 0 OR NEW.unavailable_qty <> 0 THEN
      RAISE EXCEPTION 'inventory items must be created empty; use an OPENING_BALANCE movement' USING ERRCODE = 'P0001';
    END IF;
  ELSIF (NEW.physical_qty, NEW.reserved_qty, NEW.unavailable_qty)
        IS DISTINCT FROM (OLD.physical_qty, OLD.reserved_qty, OLD.unavailable_qty) THEN
    RAISE EXCEPTION 'inventory quantities may only change through sp_apply_inventory_movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_items_guard BEFORE INSERT OR UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION sp_guard_inventory_quantities();
CREATE TRIGGER inventory_items_touch BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

-- The single entry point for stock changes. Atomic: row lock (UPDATE), CHECK constraints,
-- ledger insert. Idempotent per (item, idempotency_key): a replay returns the original movement.
CREATE OR REPLACE FUNCTION sp_apply_inventory_movement(
  p_item_id uuid, p_type text, p_physical_delta integer, p_reserved_delta integer,
  p_unavailable_delta integer, p_source text, p_actor uuid, p_reference_type text,
  p_reference_id uuid, p_reason_code text, p_note text, p_idempotency_key text,
  p_touch_freshness boolean
) RETURNS inventory_movements
LANGUAGE plpgsql AS $$
DECLARE
  v_item inventory_items;
  v_mov  inventory_movements;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_mov FROM inventory_movements
     WHERE inventory_item_id = p_item_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_mov; END IF;
  END IF;

  PERFORM set_config('sp.ledger_write', 'on', true);
  UPDATE inventory_items
     SET physical_qty       = physical_qty + p_physical_delta,
         reserved_qty       = reserved_qty + p_reserved_delta,
         unavailable_qty    = unavailable_qty + p_unavailable_delta,
         last_updated_at    = CASE WHEN p_touch_freshness THEN now() ELSE last_updated_at END,
         last_update_source = CASE WHEN p_touch_freshness THEN p_source ELSE last_update_source END,
         last_verified_at   = CASE WHEN p_type IN ('STOCK_COUNT', 'COUNT_VERIFIED', 'OPENING_BALANCE')
                                   THEN now() ELSE last_verified_at END,
         version            = version + 1
   WHERE id = p_item_id
   RETURNING * INTO v_item;
  PERFORM set_config('sp.ledger_write', 'off', true);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory item % not found', p_item_id USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO inventory_movements (
    inventory_item_id, organization_id, medicine_id, movement_type,
    physical_delta, reserved_delta, unavailable_delta,
    physical_after, reserved_after, unavailable_after,
    source, reason_code, note, reference_type, reference_id, actor_user_id, idempotency_key)
  VALUES (
    v_item.id, v_item.organization_id, v_item.medicine_id, p_type,
    p_physical_delta, p_reserved_delta, p_unavailable_delta,
    v_item.physical_qty, v_item.reserved_qty, v_item.unavailable_qty,
    p_source, p_reason_code, p_note, p_reference_type, p_reference_id, p_actor, p_idempotency_key)
  RETURNING * INTO v_mov;
  RETURN v_mov;
END $$;

-- Reconciliation: balances must equal the sum of ledger deltas (items start at zero).
CREATE OR REPLACE FUNCTION sp_inventory_ledger_mismatches()
RETURNS TABLE (inventory_item_id uuid, physical_qty integer, ledger_physical bigint,
               reserved_qty integer, ledger_reserved bigint, unavailable_qty integer, ledger_unavailable bigint)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.physical_qty, coalesce(m.p, 0), i.reserved_qty, coalesce(m.r, 0), i.unavailable_qty, coalesce(m.u, 0)
    FROM inventory_items i
    LEFT JOIN (SELECT mv.inventory_item_id, sum(mv.physical_delta) p, sum(mv.reserved_delta) r, sum(mv.unavailable_delta) u
                 FROM inventory_movements mv GROUP BY mv.inventory_item_id) m ON m.inventory_item_id = i.id
   WHERE i.physical_qty <> coalesce(m.p, 0) OR i.reserved_qty <> coalesce(m.r, 0) OR i.unavailable_qty <> coalesce(m.u, 0)
$$;

CREATE TABLE inventory_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_name       text,
  file_sha256     text NOT NULL,
  row_count       integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('VALIDATED', 'COMMITTED', 'REJECTED')),
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  committed_at    timestamptz
);
CREATE UNIQUE INDEX inventory_imports_committed_uq ON inventory_imports (organization_id, file_sha256) WHERE status = 'COMMITTED';

CREATE TABLE integration_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_config_id uuid NOT NULL REFERENCES integration_configs(id) ON DELETE CASCADE,
  organization_id       uuid NOT NULL,
  external_event_id     text NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 128),
  event_type            text NOT NULL,
  occurred_at           timestamptz NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  payload               jsonb NOT NULL,
  status                text NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSED', 'PARTIALLY_APPLIED', 'FAILED', 'DEAD', 'REJECTED')),
  attempts              integer NOT NULL DEFAULT 0,
  result                jsonb,
  last_error            text,
  processed_at          timestamptz,
  UNIQUE (integration_config_id, external_event_id)
);
CREATE INDEX integration_events_status_idx ON integration_events (integration_config_id, status, received_at DESC);
