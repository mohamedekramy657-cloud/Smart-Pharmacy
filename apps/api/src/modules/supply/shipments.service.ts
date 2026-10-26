import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { OrgContext } from '../../common/auth/decorators';
import { Errors } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency.service';
import { SettingsService } from '../../common/settings.service';
import { zText } from '../../common/zod';
import { Database, Queryable } from '../../database/db';
import { LedgerService } from '../inventory/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { assertTransition, deliveryDateStatus, RECEIVABLE, SHIPMENT_TRANSITIONS, ShipmentStatus, WAREHOUSE_SETTABLE } from './state-machines';

const zConfidence = z.enum(['CONFIRMED', 'ESTIMATED', 'PENDING_CONFIRMATION', 'UNKNOWN']);

export const CreateShipmentSchema = z.object({
  purchaseOrderId: z.uuid(),
  items: z.array(z.object({
    purchaseOrderItemId: z.uuid(),
    quantity: z.number().int().min(1).max(100000),
    batchNumber: z.string().trim().min(1).max(64).optional(),
    expiryDate: z.iso.date().optional(),
  }).strict()).min(1).max(200),
  carrier: zText(120).optional(),
  trackingNumber: zText(120).optional(),
  plannedDispatchAt: z.iso.datetime({ offset: true }).optional(),
  estimatedDeliveryAt: z.iso.datetime({ offset: true }).optional(),
  scheduleConfidence: zConfidence.default('ESTIMATED'),
}).strict();

export const ShipmentStatusSchema = z.object({
  status: z.enum(['IN_TRANSIT', 'DELAYED', 'ARRIVED']),
  reason: zText(500).optional(),
}).strict().refine((v) => v.status !== 'DELAYED' || (v.reason && v.reason.length >= 3), 'A reason is required when marking a shipment as delayed');

export const ScheduleSchema = z.object({
  estimatedDeliveryAt: z.iso.datetime({ offset: true }).nullable(),
  confidence: zConfidence,
  reason: zText(500).optional(),
}).strict();

export const ReceiveSchema = z.object({
  items: z.array(z.object({
    shipmentItemId: z.uuid(),
    receivedQty: z.number().int().min(0).max(100000),
    damagedQty: z.number().int().min(0).max(100000).default(0),
    note: zText(500).optional(),
  }).strict()).min(1).max(200),
  note: zText(1000).optional(),
}).strict();

export const DiscrepancyActionSchema = z.object({
  action: z.enum(['ACKNOWLEDGE', 'RESOLVE', 'DISPUTE']),
  resolution: z.enum(['CREDIT_ISSUED', 'REPLACEMENT_PLANNED', 'WRITTEN_OFF', 'REJECTED']).optional(),
  note: zText(1000).optional(),
}).strict().refine((v) => v.action !== 'RESOLVE' || v.resolution, 'resolution is required when resolving');

type ShipmentRow = { id: string; shipmentNumber: string; status: ShipmentStatus; purchaseOrderId: string; warehouseOrgId: string; pharmacyOrgId: string;
  estimatedDeliveryAt: Date | null; scheduleConfidence: string; orderNumber: string; pharmacyName: string; warehouseName: string };

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
    private readonly notifications: NotificationsService,
    private readonly orders: PurchaseOrdersService,
    private readonly settings: SettingsService,
  ) {}

  private async load(q: Queryable, org: OrgContext, shipmentId: string, lock = false): Promise<ShipmentRow> {
    const s = await q.maybeOne<ShipmentRow>(
      `SELECT s.*, po.order_number, ph.name_en AS pharmacy_name, wh.name_en AS warehouse_name
         FROM shipments s JOIN purchase_orders po ON po.id = s.purchase_order_id
         JOIN organizations ph ON ph.id = s.pharmacy_org_id JOIN organizations wh ON wh.id = s.warehouse_org_id
        WHERE s.id = $1 AND (s.pharmacy_org_id = $2 OR s.warehouse_org_id = $2) ${lock ? 'FOR UPDATE OF s' : ''}`, [shipmentId, org.id]);
    if (!s) throw Errors.notFound('Shipment');
    return s;
  }

  private async setStatus(q: Queryable, s: ShipmentRow, to: ShipmentStatus, actor: string, note?: string) {
    assertTransition(SHIPMENT_TRANSITIONS, s.status, to, 'Shipment');
    await q.exec('UPDATE shipments SET status = $2, version = version + 1 WHERE id = $1', [s.id, to]);
    await this.orders.history(q, 'shipment', s.id, s.status, to, actor, note);
  }

  async create(org: OrgContext, actorUserId: string, input: z.infer<typeof CreateShipmentSchema>, idemKey?: string) {
    return this.idem.execute(`shipment-create:${org.id}`, idemKey, input, async (tx) => {
      const po = await this.orders.load(tx, org, input.purchaseOrderId, true);
      if (po.warehouseOrgId !== org.id) throw Errors.forbidden('Only the supplying warehouse can create shipments for this order');
      if (!['CONFIRMED', 'PARTIALLY_CONFIRMED', 'IN_FULFILLMENT', 'PARTIALLY_DELIVERED'].includes(po.status)) {
        throw Errors.invalidState(`Cannot ship an order in status ${po.status}`);
      }
      const lines = await tx.query<{ id: string; medicineId: string; allocatedQty: number; inDrafts: number }>(
        `SELECT poi.id, poi.medicine_id, poi.allocated_qty,
                coalesce((SELECT sum(si.quantity) FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
                           WHERE si.purchase_order_item_id = poi.id AND s.status = 'DRAFT'), 0)::int AS in_drafts
           FROM purchase_order_items poi WHERE poi.purchase_order_id = $1`, [po.id]);
      for (const it of input.items) {
        const line = lines.find((l) => l.id === it.purchaseOrderItemId);
        if (!line) throw Errors.unprocessable('UNKNOWN_ORDER_LINE', 'Order line not found on this purchase order');
        if (it.quantity > line.allocatedQty - line.inDrafts) {
          throw Errors.unprocessable('EXCEEDS_ALLOCATION', 'Shipment quantity exceeds the allocated quantity not yet planned for shipping', { purchaseOrderItemId: line.id, remaining: line.allocatedQty - line.inDrafts });
        }
        if ((it.batchNumber && !it.expiryDate) || (!it.batchNumber && it.expiryDate)) throw Errors.badRequest('batchNumber and expiryDate must be provided together');
      }
      if (new Set(input.items.map((i) => i.purchaseOrderItemId)).size !== input.items.length) throw Errors.badRequest('Each order line may appear once per shipment');
      const shipment = await tx.one<{ id: string }>(
        `INSERT INTO shipments (shipment_number, purchase_order_id, warehouse_org_id, pharmacy_org_id, carrier, tracking_number, planned_dispatch_at,
                                estimated_delivery_at, schedule_confidence, schedule_updated_at, created_by)
         VALUES ('SH-' || to_char(now(),'YYYY') || '-' || lpad(nextval('shipment_number_seq')::text, 6, '0'), $1,$2,$3,$4,$5,$6,$7,$8, now(), $9) RETURNING id`,
        [po.id, po.warehouseOrgId, po.pharmacyOrgId, input.carrier ?? null, input.trackingNumber ?? null, input.plannedDispatchAt ?? null,
         input.estimatedDeliveryAt ?? null, input.estimatedDeliveryAt ? input.scheduleConfidence : 'PENDING_CONFIRMATION', actorUserId]);
      for (const it of input.items) {
        const line = lines.find((l) => l.id === it.purchaseOrderItemId)!;
        await tx.exec('INSERT INTO shipment_items (shipment_id, purchase_order_item_id, medicine_id, quantity, batch_number, expiry_date) VALUES ($1,$2,$3,$4,$5,$6)',
          [shipment.id, line.id, line.medicineId, it.quantity, it.batchNumber ?? null, it.expiryDate ?? null]);
      }
      await tx.exec(`INSERT INTO delivery_schedule_updates (shipment_id, new_estimated_at, new_confidence, reason, updated_by) VALUES ($1,$2,$3,'initial schedule',$4)`,
        [shipment.id, input.estimatedDeliveryAt ?? null, input.estimatedDeliveryAt ? input.scheduleConfidence : 'PENDING_CONFIRMATION', actorUserId]);
      await this.orders.history(tx, 'shipment', shipment.id, null, 'DRAFT', actorUserId);
      await this.audit.record(tx, { action: 'SHIPMENT_CREATED', entityType: 'shipment', entityId: shipment.id, organizationId: org.id, changes: { purchaseOrderId: po.id, lines: input.items.length } });
      return this.detail(tx, org, shipment.id);
    });
  }

  /** Goods leave the warehouse: warehouse physical & reserved decrease. Pharmacy stock is NOT changed. */
  async dispatch(org: OrgContext, actorUserId: string, shipmentId: string, idemKey?: string) {
    return this.idem.execute(`shipment-dispatch:${shipmentId}`, idemKey, { shipmentId }, async (tx) => {
      const s = await this.load(tx, org, shipmentId, true);
      if (s.warehouseOrgId !== org.id) throw Errors.forbidden('Only the warehouse can dispatch this shipment');
      const po = await tx.one<{ status: string; orderNumber: string }>('SELECT status, order_number FROM purchase_orders WHERE id = $1 FOR UPDATE', [s.purchaseOrderId]);
      if (!['CONFIRMED', 'PARTIALLY_CONFIRMED', 'IN_FULFILLMENT', 'PARTIALLY_DELIVERED'].includes(po.status)) throw Errors.invalidState(`Order is ${po.status}; it cannot be dispatched`);
      await this.setStatus(tx, s, 'DISPATCHED', actorUserId);
      const items = await tx.query<{ id: string; purchaseOrderItemId: string; quantity: number; warehouseInventoryItemId: string }>(
        `SELECT si.id, si.purchase_order_item_id, si.quantity, poi.warehouse_inventory_item_id
           FROM shipment_items si JOIN purchase_order_items poi ON poi.id = si.purchase_order_item_id
          WHERE si.shipment_id = $1 ORDER BY poi.warehouse_inventory_item_id`, [s.id]);
      for (const it of items) {
        // CHECK constraints guarantee allocated_qty never goes negative (no dispatch beyond allocation).
        await tx.exec('UPDATE purchase_order_items SET allocated_qty = allocated_qty - $2, dispatched_qty = dispatched_qty + $2 WHERE id = $1', [it.purchaseOrderItemId, it.quantity]);
        await this.ledger.apply(tx, { itemId: it.warehouseInventoryItemId, type: 'DISPATCH', physicalDelta: -it.quantity, reservedDelta: -it.quantity, source: 'MANUAL', actorUserId, referenceType: 'SHIPMENT', referenceId: s.id, note: s.shipmentNumber });
      }
      await tx.exec('UPDATE shipments SET dispatched_at = now() WHERE id = $1', [s.id]);
      if (po.status === 'CONFIRMED' || po.status === 'PARTIALLY_CONFIRMED') await this.orders.setStatus(tx, s.purchaseOrderId, po.status, 'IN_FULFILLMENT', actorUserId);
      await this.audit.record(tx, { action: 'SHIPMENT_DISPATCHED', entityType: 'shipment', entityId: s.id, organizationId: org.id });
      await this.notifications.toOrg(tx, s.pharmacyOrgId, {
        type: 'SHIPMENT_DISPATCHED', dedupeKey: `shipment-dispatched:${s.id}`,
        data: { shipmentNumber: s.shipmentNumber, orderNumber: s.orderNumber, eta: s.estimatedDeliveryAt ? new Date(s.estimatedDeliveryAt).toISOString() : null, confidence: s.scheduleConfidence, shipmentId: s.id },
      });
      return this.detail(tx, org, s.id);
    });
  }

  async updateStatus(org: OrgContext, actorUserId: string, shipmentId: string, input: z.infer<typeof ShipmentStatusSchema>) {
    return this.db.tx(async (tx) => {
      const s = await this.load(tx, org, shipmentId, true);
      if (s.warehouseOrgId !== org.id) throw Errors.forbidden('Only the warehouse can update shipment status');
      if (!WAREHOUSE_SETTABLE.includes(input.status)) throw Errors.badRequest('Invalid status');
      await this.setStatus(tx, s, input.status, actorUserId, input.reason);
      if (input.status === 'DELAYED') await tx.exec('UPDATE shipments SET delay_reason = $2 WHERE id = $1', [s.id, input.reason]);
      if (input.status === 'ARRIVED') await tx.exec('UPDATE shipments SET arrived_at = now() WHERE id = $1', [s.id]);
      await this.audit.record(tx, { action: 'SHIPMENT_STATUS_UPDATED', entityType: 'shipment', entityId: s.id, organizationId: org.id, changes: { from: s.status, to: input.status, reason: input.reason } });
      await this.notifications.toOrg(tx, s.pharmacyOrgId, input.status === 'DELAYED'
        ? { type: 'SHIPMENT_DELAYED', data: { shipmentNumber: s.shipmentNumber, eta: s.estimatedDeliveryAt, reason: input.reason, shipmentId: s.id }, dedupeKey: `shipment-delayed:${s.id}:${Date.now()}` }
        : { type: 'SHIPMENT_STATUS', data: { shipmentNumber: s.shipmentNumber, status: input.status, shipmentId: s.id }, dedupeKey: `shipment-status:${s.id}:${input.status}` });
      return this.detail(tx, org, s.id);
    });
  }

  async updateSchedule(org: OrgContext, actorUserId: string, shipmentId: string, input: z.infer<typeof ScheduleSchema>) {
    return this.db.tx(async (tx) => {
      const s = await this.load(tx, org, shipmentId, true);
      if (s.warehouseOrgId !== org.id) throw Errors.forbidden('Only the warehouse can update the delivery schedule');
      if (!['DRAFT', 'DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED'].includes(s.status)) throw Errors.invalidState(`Schedule cannot change once the shipment is ${s.status}`);
      const prev = s.estimatedDeliveryAt ? new Date(s.estimatedDeliveryAt) : null;
      const next = input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null;
      const isDelay = Boolean(prev && (!next || next > prev));
      await tx.exec('UPDATE shipments SET estimated_delivery_at = $2, schedule_confidence = $3, schedule_updated_at = now(), delay_reason = CASE WHEN $4 THEN $5 ELSE delay_reason END WHERE id = $1',
        [s.id, next, input.estimatedDeliveryAt ? input.confidence : (input.confidence === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'UNKNOWN'), isDelay, input.reason ?? null]);
      await tx.exec(`INSERT INTO delivery_schedule_updates (shipment_id, previous_estimated_at, new_estimated_at, previous_confidence, new_confidence, reason, is_delay, updated_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [s.id, prev, next, s.scheduleConfidence, input.confidence, input.reason ?? null, isDelay, actorUserId]);
      await this.audit.record(tx, { action: 'SHIPMENT_SCHEDULE_UPDATED', entityType: 'shipment', entityId: s.id, organizationId: org.id, changes: { previous: prev, next, confidence: input.confidence, reason: input.reason } });
      await this.notifications.toOrg(tx, s.pharmacyOrgId, {
        type: isDelay ? 'SHIPMENT_DELAYED' : 'SHIPMENT_STATUS', dedupeKey: `shipment-schedule:${s.id}:${next?.toISOString() ?? 'none'}`,
        data: { shipmentNumber: s.shipmentNumber, eta: next?.toISOString() ?? null, reason: input.reason, status: `ETA ${next?.toISOString() ?? 'unknown'} (${input.confidence})`, shipmentId: s.id },
      });
      return this.detail(tx, org, s.id);
    });
  }

  async cancel(org: OrgContext, actorUserId: string, shipmentId: string, reason: string) {
    return this.db.tx(async (tx) => {
      const s = await this.load(tx, org, shipmentId, true);
      if (s.warehouseOrgId !== org.id) throw Errors.forbidden('Only the warehouse can cancel this shipment');
      await this.setStatus(tx, s, 'CANCELLED', actorUserId, reason); // only DRAFT -> CANCELLED is valid
      await this.audit.record(tx, { action: 'SHIPMENT_CANCELLED', entityType: 'shipment', entityId: s.id, organizationId: org.id, changes: { reason } });
      return this.detail(tx, org, s.id);
    });
  }

  /**
   * Receiving & verification (pharmacy). The ONLY path by which supplied goods increase pharmacy
   * stock. All lines must be accounted for: received + damaged + missing = shipped.
   */
  async receive(org: OrgContext, actorUserId: string, shipmentId: string, input: z.infer<typeof ReceiveSchema>, idemKey?: string) {
    const quarantine = await this.settings.get('receiving.quarantineOnReceipt');
    return this.idem.execute(`shipment-receive:${shipmentId}`, idemKey, input, async (tx) => {
      const s = await this.load(tx, org, shipmentId, true);
      if (s.pharmacyOrgId !== org.id) throw Errors.forbidden('Only the receiving pharmacy can receive this shipment');
      if (!RECEIVABLE.includes(s.status)) throw Errors.invalidState(`Shipment is ${s.status}; it cannot be received`);
      const items = await tx.query<{ id: string; purchaseOrderItemId: string; medicineId: string; quantity: number; batchNumber: string | null; expiryDate: string | null }>(
        'SELECT id, purchase_order_item_id, medicine_id, quantity, batch_number, expiry_date FROM shipment_items WHERE shipment_id = $1 ORDER BY medicine_id', [s.id]);
      const byId = new Map(input.items.map((i) => [i.shipmentItemId, i]));
      if (byId.size !== items.length || items.some((i) => !byId.has(i.id))) throw Errors.badRequest('Every shipment line must be included in the receipt');

      let discrepancyCount = 0;
      for (const it of items) {
        const r = byId.get(it.id)!;
        if (r.receivedQty + r.damagedQty > it.quantity) {
          throw Errors.unprocessable('RECEIPT_EXCEEDS_SHIPPED', 'Received + damaged cannot exceed the shipped quantity; record surplus as a separate stock adjustment', { shipmentItemId: it.id, shipped: it.quantity });
        }
        const missing = it.quantity - r.receivedQty - r.damagedQty;
        await tx.exec('UPDATE shipment_items SET received_qty = $2, damaged_qty = $3, missing_qty = $4 WHERE id = $1', [it.id, r.receivedQty, r.damagedQty, missing]);
        await tx.exec('UPDATE purchase_order_items SET received_qty = received_qty + $2, damaged_qty = damaged_qty + $3, missing_qty = missing_qty + $4 WHERE id = $1',
          [it.purchaseOrderItemId, r.receivedQty, r.damagedQty, missing]);
        if (r.receivedQty > 0) {
          const { id: itemId } = await this.ledger.ensureItem(tx, org.id, it.medicineId);
          await this.ledger.apply(tx, {
            itemId, type: 'RECEIPT', physicalDelta: r.receivedQty, unavailableDelta: quarantine ? r.receivedQty : 0, source: 'RECEIPT', actorUserId,
            referenceType: 'SHIPMENT', referenceId: s.id, note: `${s.shipmentNumber}${quarantine ? ' (quarantine)' : ''}`, idempotencyKey: `receipt:${it.id}`,
          });
          if (it.batchNumber && it.expiryDate) {
            await tx.exec(`INSERT INTO inventory_batches (inventory_item_id, batch_number, expiry_date, quantity, status, source_shipment_item_id) VALUES ($1,$2,$3,$4,$5,$6)
                           ON CONFLICT (inventory_item_id, batch_number, expiry_date) DO UPDATE SET quantity = inventory_batches.quantity + EXCLUDED.quantity`,
              [itemId, it.batchNumber, it.expiryDate, r.receivedQty, quarantine ? 'QUARANTINED' : 'ACTIVE', it.id]);
          }
        }
        for (const [type, qty] of [['DAMAGED', r.damagedQty], ['MISSING', missing]] as const) {
          if (qty > 0) {
            discrepancyCount++;
            await tx.exec(`INSERT INTO delivery_discrepancies (shipment_id, shipment_item_id, purchase_order_id, pharmacy_org_id, warehouse_org_id, medicine_id, type, quantity, note, reported_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [s.id, it.id, s.purchaseOrderId, s.pharmacyOrgId, s.warehouseOrgId, it.medicineId, type, qty, r.note ?? null, actorUserId]);
          }
        }
      }
      const outcome: ShipmentStatus = discrepancyCount ? 'PARTIALLY_DELIVERED' : 'DELIVERED';
      await this.setStatus(tx, s, outcome, actorUserId, input.note);
      await tx.exec('UPDATE shipments SET received_at = now(), received_by = $2, receipt_note = $3 WHERE id = $1', [s.id, actorUserId, input.note ?? null]);
      await this.orders.recompute(tx, s.purchaseOrderId, actorUserId);
      await this.audit.record(tx, { action: 'SHIPMENT_RECEIVED', entityType: 'shipment', entityId: s.id, organizationId: org.id, changes: { outcome, discrepancies: discrepancyCount, quarantine } });
      await this.notifications.toOrg(tx, s.warehouseOrgId, { type: 'SHIPMENT_RECEIVED', dedupeKey: `shipment-received:${s.id}`, data: { shipmentNumber: s.shipmentNumber, pharmacy: s.pharmacyName, discrepancies: discrepancyCount, shipmentId: s.id } });
      return this.detail(tx, org, s.id);
    });
  }

  get(org: OrgContext, shipmentId: string) {
    return this.detail(this.db, org, shipmentId);
  }

  async detail(q: Queryable, org: OrgContext, shipmentId: string) {
    const s = await this.load(q, org, shipmentId);
    const items = await q.query(
      `SELECT si.id, si.purchase_order_item_id, si.medicine_id, m.brand_name_en, m.brand_name_ar, m.strength, m.dosage_form, si.quantity,
              si.batch_number, si.expiry_date, si.received_qty, si.damaged_qty, si.missing_qty
         FROM shipment_items si JOIN medicines m ON m.id = si.medicine_id WHERE si.shipment_id = $1 ORDER BY m.brand_name_en`, [s.id]);
    const schedule = await q.query('SELECT previous_estimated_at, new_estimated_at, previous_confidence, new_confidence, reason, is_delay, created_at FROM delivery_schedule_updates WHERE shipment_id = $1 ORDER BY id', [s.id]);
    const history = await q.query(`SELECT from_status, to_status, note, created_at FROM status_history WHERE entity_type = 'shipment' AND entity_id = $1 ORDER BY id`, [s.id]);
    const discrepancies = await q.query('SELECT id, shipment_item_id, medicine_id, type, quantity, status, resolution, note, resolution_note, reported_at, resolved_at FROM delivery_discrepancies WHERE shipment_id = $1 ORDER BY reported_at', [s.id]);
    return { ...s, deliveryDateStatus: deliveryDateStatus(s), items, schedule, history, discrepancies };
  }

  async list(org: OrgContext, status?: string) {
    const col = org.type === 'PHARMACY' ? 'pharmacy_org_id' : 'warehouse_org_id';
    const rows = await this.db.query<{ status: string; estimatedDeliveryAt: Date | null; scheduleConfidence: string }>(
      `SELECT s.id, s.shipment_number, s.status, s.purchase_order_id, po.order_number, s.carrier, s.tracking_number, s.dispatched_at, s.estimated_delivery_at,
              s.schedule_confidence, s.schedule_updated_at, s.received_at, ph.name_en AS pharmacy_name, wh.name_en AS warehouse_name,
              (SELECT coalesce(sum(quantity),0)::int FROM shipment_items WHERE shipment_id = s.id) AS total_units
         FROM shipments s JOIN purchase_orders po ON po.id = s.purchase_order_id JOIN organizations ph ON ph.id = s.pharmacy_org_id JOIN organizations wh ON wh.id = s.warehouse_org_id
        WHERE s.${col} = $1 AND ($2::text IS NULL OR s.status = $2) ORDER BY s.created_at DESC LIMIT 200`, [org.id, status ?? null]);
    return rows.map((r) => ({ ...r, deliveryDateStatus: deliveryDateStatus(r) }));
  }

  /** Pharmacy "incoming inventory" view: open order lines with schedule state, separate from stock. */
  async incoming(org: OrgContext) {
    const rows = await this.db.query<Record<string, unknown> & { status: string | null; estimatedDeliveryAt: Date | null; scheduleConfidence: string | null }>(
      `SELECT po.id AS purchase_order_id, po.order_number, po.status AS order_status, wh.name_en AS warehouse_name, wh.name_ar AS warehouse_name_ar,
              poi.medicine_id, m.brand_name_en, m.brand_name_ar, m.strength, m.dosage_form,
              poi.requested_qty, poi.confirmed_qty, poi.allocated_qty, poi.dispatched_qty, poi.received_qty, poi.damaged_qty, poi.missing_qty,
              s.id AS shipment_id, s.shipment_number, s.status, s.dispatched_at, s.estimated_delivery_at, s.schedule_confidence, s.schedule_updated_at, s.delay_reason,
              si.quantity AS shipment_qty
         FROM purchase_orders po
         JOIN organizations wh ON wh.id = po.warehouse_org_id
         JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
         JOIN medicines m ON m.id = poi.medicine_id
         LEFT JOIN shipment_items si ON si.purchase_order_item_id = poi.id
         LEFT JOIN shipments s ON s.id = si.shipment_id AND s.status IN ('DRAFT','DISPATCHED','IN_TRANSIT','DELAYED','ARRIVED')
        WHERE po.pharmacy_org_id = $1 AND po.status IN ('SUBMITTED','CONFIRMED','PARTIALLY_CONFIRMED','IN_FULFILLMENT','PARTIALLY_DELIVERED')
          AND (si.id IS NULL OR s.id IS NOT NULL OR poi.allocated_qty > 0)
        ORDER BY s.estimated_delivery_at NULLS LAST, po.created_at`, [org.id]);
    return rows.map((r) => ({
      ...r,
      deliveryDateStatus: r.status ? deliveryDateStatus({ status: r.status, estimatedDeliveryAt: r.estimatedDeliveryAt, scheduleConfidence: r.scheduleConfidence ?? 'UNKNOWN' })
        : r.orderStatus === 'SUBMITTED' ? 'PENDING_CONFIRMATION' : 'UNKNOWN',
      isOverdue: Boolean(r.status && r.estimatedDeliveryAt && new Date(r.estimatedDeliveryAt) < new Date() && r.status !== 'ARRIVED'),
    }));
  }

  async discrepancies(org: OrgContext, status?: string) {
    const col = org.type === 'PHARMACY' ? 'pharmacy_org_id' : 'warehouse_org_id';
    return this.db.query(
      `SELECT d.id, d.type, d.quantity, d.status, d.resolution, d.note, d.resolution_note, d.reported_at, d.resolved_at, s.shipment_number, po.order_number,
              m.brand_name_en, m.strength, ph.name_en AS pharmacy_name, wh.name_en AS warehouse_name
         FROM delivery_discrepancies d JOIN shipments s ON s.id = d.shipment_id JOIN purchase_orders po ON po.id = d.purchase_order_id
         JOIN medicines m ON m.id = d.medicine_id JOIN organizations ph ON ph.id = d.pharmacy_org_id JOIN organizations wh ON wh.id = d.warehouse_org_id
        WHERE d.${col} = $1 AND ($2::text IS NULL OR d.status = $2) ORDER BY d.reported_at DESC LIMIT 200`, [org.id, status ?? null]);
  }

  async actOnDiscrepancy(org: OrgContext, actorUserId: string, discrepancyId: string, input: z.infer<typeof DiscrepancyActionSchema>) {
    return this.db.tx(async (tx) => {
      const d = await tx.maybeOne<{ id: string; status: string; warehouseOrgId: string; pharmacyOrgId: string; shipmentId: string }>(
        'SELECT id, status, warehouse_org_id, pharmacy_org_id, shipment_id FROM delivery_discrepancies WHERE id = $1 AND (warehouse_org_id = $2 OR pharmacy_org_id = $2) FOR UPDATE', [discrepancyId, org.id]);
      if (!d) throw Errors.notFound('Discrepancy');
      if (d.warehouseOrgId !== org.id) throw Errors.forbidden('Only the supplying warehouse can act on this discrepancy');
      const allowed: Record<string, string[]> = { OPEN: ['ACKNOWLEDGE', 'RESOLVE', 'DISPUTE'], ACKNOWLEDGED: ['RESOLVE', 'DISPUTE'], DISPUTED: ['RESOLVE'], RESOLVED: [] };
      if (!allowed[d.status]?.includes(input.action)) throw Errors.invalidState(`Cannot ${input.action.toLowerCase()} a ${d.status} discrepancy`);
      const next = input.action === 'ACKNOWLEDGE' ? 'ACKNOWLEDGED' : input.action === 'RESOLVE' ? 'RESOLVED' : 'DISPUTED';
      await tx.exec(`UPDATE delivery_discrepancies SET status = $2, resolution = coalesce($3, resolution), resolution_note = coalesce($4, resolution_note),
                       resolved_by = CASE WHEN $2 = 'RESOLVED' THEN $5::uuid ELSE resolved_by END, resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE resolved_at END WHERE id = $1`,
        [d.id, next, input.resolution ?? null, input.note ?? null, actorUserId]);
      await this.orders.history(tx, 'delivery_discrepancy', d.id, d.status, next, actorUserId, input.note);
      await this.audit.record(tx, { action: `DISCREPANCY_${input.action}`, entityType: 'delivery_discrepancy', entityId: d.id, organizationId: org.id, changes: input as Record<string, unknown> });
      const s = await tx.one<{ shipmentNumber: string }>('SELECT shipment_number FROM shipments WHERE id = $1', [d.shipmentId]);
      await this.notifications.toOrg(tx, d.pharmacyOrgId, { type: 'DISCREPANCY_UPDATED', dedupeKey: `discrepancy:${d.id}:${next}`, data: { shipmentNumber: s.shipmentNumber, status: next } });
      return { id: d.id, status: next };
    });
  }
}
