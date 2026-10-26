-- 0004_supply.sql — warehouse -> pharmacy supply chain.
-- Quantity concepts are separate columns with cross-column invariants (see docs/07).

CREATE TABLE supply_relationships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pharmacy_org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
  payment_terms    text,
  credit_limit     numeric(14, 2) CHECK (credit_limit >= 0),
  notes            text,
  requested_by     uuid REFERENCES users(id),
  decided_by       uuid REFERENCES users(id),
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_org_id, pharmacy_org_id),
  CHECK (warehouse_org_id <> pharmacy_org_id)
);
CREATE INDEX supply_relationships_pharmacy_idx ON supply_relationships (pharmacy_org_id, status);
CREATE TRIGGER supply_relationships_touch BEFORE UPDATE ON supply_relationships FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE SEQUENCE purchase_order_number_seq;
CREATE SEQUENCE shipment_number_seq;

CREATE TABLE purchase_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number            text NOT NULL UNIQUE,
  pharmacy_org_id         uuid NOT NULL REFERENCES organizations(id),
  warehouse_org_id        uuid NOT NULL REFERENCES organizations(id),
  supply_relationship_id  uuid NOT NULL REFERENCES supply_relationships(id),
  status                  text NOT NULL CHECK (status IN (
                            'DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_CONFIRMED', 'REJECTED', 'CANCELLED',
                            'IN_FULFILLMENT', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CLOSED')),
  requested_delivery_date date,
  notes                   text,
  decision_note           text,
  cancellation_reason     text,
  currency                char(3) NOT NULL DEFAULT 'EGP',
  idempotency_key         text,
  created_by              uuid REFERENCES users(id),
  submitted_at            timestamptz,
  decided_at              timestamptz,
  decided_by              uuid REFERENCES users(id),
  cancelled_at            timestamptz,
  cancelled_by            uuid REFERENCES users(id),
  version                 integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pharmacy_org_id, idempotency_key)
);
CREATE INDEX purchase_orders_pharmacy_idx ON purchase_orders (pharmacy_org_id, created_at DESC);
CREATE INDEX purchase_orders_warehouse_idx ON purchase_orders (warehouse_org_id, status, created_at DESC);
CREATE TRIGGER purchase_orders_touch BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE TABLE purchase_order_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id           uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  medicine_id                 uuid NOT NULL REFERENCES medicines(id),
  requested_qty               integer NOT NULL CHECK (requested_qty > 0 AND requested_qty <= 100000),
  confirmed_qty               integer CHECK (confirmed_qty >= 0),
  allocated_qty               integer NOT NULL DEFAULT 0 CHECK (allocated_qty >= 0),
  dispatched_qty              integer NOT NULL DEFAULT 0 CHECK (dispatched_qty >= 0),
  received_qty                integer NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  damaged_qty                 integer NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  missing_qty                 integer NOT NULL DEFAULT 0 CHECK (missing_qty >= 0),
  unit_price                  numeric(12, 2) CHECK (unit_price >= 0),
  warehouse_inventory_item_id uuid REFERENCES inventory_items(id),
  UNIQUE (purchase_order_id, medicine_id),
  CONSTRAINT poi_confirmed_le_requested CHECK (confirmed_qty IS NULL OR confirmed_qty <= requested_qty),
  CONSTRAINT poi_alloc_dispatch_le_confirmed CHECK (allocated_qty + dispatched_qty <= coalesce(confirmed_qty, 0)),
  CONSTRAINT poi_receipt_le_dispatched CHECK (received_qty + damaged_qty + missing_qty <= dispatched_qty)
);
CREATE INDEX purchase_order_items_po_idx ON purchase_order_items (purchase_order_id);
CREATE INDEX purchase_order_items_wh_item_idx ON purchase_order_items (warehouse_inventory_item_id) WHERE allocated_qty > 0;

CREATE TABLE shipments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_number       text NOT NULL UNIQUE,
  purchase_order_id     uuid NOT NULL REFERENCES purchase_orders(id),
  warehouse_org_id      uuid NOT NULL REFERENCES organizations(id),
  pharmacy_org_id       uuid NOT NULL REFERENCES organizations(id),
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                          'DRAFT', 'DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED', 'DELIVERED',
                          'PARTIALLY_DELIVERED', 'CANCELLED')),
  carrier               text,
  tracking_number       text,
  planned_dispatch_at   timestamptz,
  dispatched_at         timestamptz,
  estimated_delivery_at timestamptz,
  schedule_confidence   text NOT NULL DEFAULT 'PENDING_CONFIRMATION' CHECK (schedule_confidence IN (
                          'CONFIRMED', 'ESTIMATED', 'PENDING_CONFIRMATION', 'UNKNOWN')),
  schedule_updated_at   timestamptz,
  delay_reason          text,
  arrived_at            timestamptz,
  received_at           timestamptz,
  received_by           uuid REFERENCES users(id),
  receipt_note          text,
  created_by            uuid REFERENCES users(id),
  version               integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipments_po_idx ON shipments (purchase_order_id);
CREATE INDEX shipments_pharmacy_open_idx ON shipments (pharmacy_org_id, status)
  WHERE status IN ('DRAFT', 'DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED');
CREATE INDEX shipments_warehouse_idx ON shipments (warehouse_org_id, status, created_at DESC);
CREATE TRIGGER shipments_touch BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE TABLE shipment_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id            uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  purchase_order_item_id uuid NOT NULL REFERENCES purchase_order_items(id),
  medicine_id            uuid NOT NULL REFERENCES medicines(id),
  quantity               integer NOT NULL CHECK (quantity > 0),
  batch_number           text,
  expiry_date            date,
  received_qty           integer CHECK (received_qty >= 0),
  damaged_qty            integer CHECK (damaged_qty >= 0),
  missing_qty            integer CHECK (missing_qty >= 0),
  UNIQUE (shipment_id, purchase_order_item_id),
  CONSTRAINT si_receipt_complete CHECK (
    (received_qty IS NULL AND damaged_qty IS NULL AND missing_qty IS NULL)
    OR (received_qty + damaged_qty + missing_qty = quantity))
);
CREATE INDEX shipment_items_shipment_idx ON shipment_items (shipment_id);

CREATE TABLE delivery_schedule_updates (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id            uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  previous_estimated_at  timestamptz,
  new_estimated_at       timestamptz,
  previous_confidence    text,
  new_confidence         text NOT NULL,
  reason                 text,
  is_delay               boolean NOT NULL DEFAULT false,
  updated_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_schedule_updates_shipment_idx ON delivery_schedule_updates (shipment_id, id DESC);

-- Generic status timeline (purchase orders, shipments, requests). Append-only.
CREATE TABLE status_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  actor_user_id uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_history_entity_idx ON status_history (entity_type, entity_id, id);
CREATE TRIGGER status_history_append_only BEFORE UPDATE OR DELETE ON status_history
  FOR EACH ROW EXECUTE FUNCTION sp_prevent_mutation();

CREATE TABLE delivery_discrepancies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id       uuid NOT NULL REFERENCES shipments(id),
  shipment_item_id  uuid NOT NULL REFERENCES shipment_items(id),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  pharmacy_org_id   uuid NOT NULL REFERENCES organizations(id),
  warehouse_org_id  uuid NOT NULL REFERENCES organizations(id),
  medicine_id       uuid NOT NULL REFERENCES medicines(id),
  type              text NOT NULL CHECK (type IN ('MISSING', 'DAMAGED')),
  quantity          integer NOT NULL CHECK (quantity > 0),
  note              text,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISPUTED')),
  resolution        text CHECK (resolution IN ('CREDIT_ISSUED', 'REPLACEMENT_PLANNED', 'WRITTEN_OFF', 'REJECTED')),
  resolution_note   text,
  reported_by       uuid REFERENCES users(id),
  reported_at       timestamptz NOT NULL DEFAULT now(),
  resolved_by       uuid REFERENCES users(id),
  resolved_at       timestamptz,
  UNIQUE (shipment_item_id, type)
);
CREATE INDEX delivery_discrepancies_wh_idx ON delivery_discrepancies (warehouse_org_id, status);
CREATE INDEX delivery_discrepancies_ph_idx ON delivery_discrepancies (pharmacy_org_id, status);
