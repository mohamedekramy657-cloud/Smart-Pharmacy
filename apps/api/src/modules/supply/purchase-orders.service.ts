import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { OrgContext } from '../../common/auth/decorators';
import { Errors } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency.service';
import { zText } from '../../common/zod';
import { Database, Queryable, Tx } from '../../database/db';
import { LedgerService } from '../inventory/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertTransition, deliveryDateStatus, OPEN_SHIPMENT, PO_TRANSITIONS, PoStatus } from './state-machines';

export const CreatePoSchema = z.object({
  warehouseOrgId: z.uuid(),
  items: z.array(z.object({ medicineId: z.uuid(), quantity: z.number().int().min(1).max(100000) }).strict()).min(1).max(200),
  requestedDeliveryDate: z.iso.date().optional(),
  notes: zText(1000).optional(),
  submit: z.boolean().default(true),
}).strict().refine((v) => new Set(v.items.map((i) => i.medicineId)).size === v.items.length, 'Each medicine may appear only once per order');

export const ConfirmPoSchema = z.object({
  items: z.array(z.object({ itemId: z.uuid(), confirmedQty: z.number().int().min(0).max(100000) }).strict()).min(1).max(200),
  note: zText(1000).optional(),
}).strict();

export const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const PoListSchema = z.object({
  status: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const STATUS_AR: Record<string, string> = { CONFIRMED: 'مؤكد', PARTIALLY_CONFIRMED: 'مؤكد جزئياً', REJECTED: 'مرفوض' };

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Loads a PO visible to the caller's organization (buyer or seller); others get 404. */
  async load(q: Queryable, org: OrgContext, poId: string, lock = false) {
    const po = await q.maybeOne<{ id: string; orderNumber: string; status: PoStatus; pharmacyOrgId: string; warehouseOrgId: string; pharmacyName: string; warehouseName: string }>(
      `SELECT po.*, ph.name_en AS pharmacy_name, wh.name_en AS warehouse_name FROM purchase_orders po
         JOIN organizations ph ON ph.id = po.pharmacy_org_id JOIN organizations wh ON wh.id = po.warehouse_org_id
        WHERE po.id = $1 AND (po.pharmacy_org_id = $2 OR po.warehouse_org_id = $2) ${lock ? 'FOR UPDATE OF po' : ''}`,
      [poId, org.id]);
    if (!po) throw Errors.notFound('Purchase order');
    return po;
  }

  async history(q: Queryable, entityType: string, entityId: string, from: string | null, to: string, actor: string | null, note?: string) {
    await q.exec('INSERT INTO status_history (entity_type, entity_id, from_status, to_status, actor_user_id, note) VALUES ($1,$2,$3,$4,$5,$6)', [entityType, entityId, from, to, actor, note ?? null]);
  }

  async setStatus(q: Queryable, poId: string, from: PoStatus, to: PoStatus, actor: string | null, note?: string) {
    if (from === to) return;
    assertTransition(PO_TRANSITIONS, from, to, 'Purchase order');
    await q.exec('UPDATE purchase_orders SET status = $2, version = version + 1 WHERE id = $1', [poId, to]);
    await this.history(q, 'purchase_order', poId, from, to, actor, note);
  }

  async create(org: OrgContext, actorUserId: string, input: z.infer<typeof CreatePoSchema>, idemKey?: string) {
    return this.idem.execute(`po-create:${org.id}`, idemKey, input, async (tx) => {
      const rel = await tx.maybeOne<{ id: string; status: string; whVerification: string; whStatus: string; whType: string }>(
        `SELECT r.id, r.status, o.verification_status AS wh_verification, o.status AS wh_status, o.type AS wh_type
           FROM supply_relationships r JOIN organizations o ON o.id = r.warehouse_org_id
          WHERE r.pharmacy_org_id = $1 AND r.warehouse_org_id = $2`, [org.id, input.warehouseOrgId]);
      if (!rel || rel.status !== 'ACTIVE') throw Errors.forbidden('No active supply relationship with this warehouse', 'NO_SUPPLY_RELATIONSHIP');
      if (rel.whVerification !== 'VERIFIED' || rel.whStatus !== 'ACTIVE') throw Errors.unprocessable('WAREHOUSE_UNAVAILABLE', 'The warehouse is not currently verified and active');
      const meds = await tx.query<{ id: string; status: string }>('SELECT id, status FROM medicines WHERE id = ANY($1::uuid[])', [input.items.map((i) => i.medicineId)]);
      for (const it of input.items) {
        const m = meds.find((x) => x.id === it.medicineId);
        if (!m) throw Errors.unprocessable('UNKNOWN_MEDICINE', `Medicine ${it.medicineId} not found`);
        if (m.status !== 'ACTIVE') throw Errors.unprocessable('MEDICINE_NOT_ACTIVE', `Medicine ${it.medicineId} is ${m.status.toLowerCase()}`);
      }
      const status: PoStatus = input.submit ? 'SUBMITTED' : 'DRAFT';
      const po = await tx.one<{ id: string; orderNumber: string }>(
        `INSERT INTO purchase_orders (order_number, pharmacy_org_id, warehouse_org_id, supply_relationship_id, status, requested_delivery_date, notes, idempotency_key, created_by, submitted_at)
         VALUES ('PO-' || to_char(now(),'YYYY') || '-' || lpad(nextval('purchase_order_number_seq')::text, 6, '0'), $1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $4 = 'SUBMITTED' THEN now() END)
         RETURNING id, order_number`,
        [org.id, input.warehouseOrgId, rel.id, status, input.requestedDeliveryDate ?? null, input.notes ?? null, idemKey ?? null, actorUserId]);
      for (const it of input.items) {
        await tx.exec('INSERT INTO purchase_order_items (purchase_order_id, medicine_id, requested_qty) VALUES ($1,$2,$3)', [po.id, it.medicineId, it.quantity]);
      }
      await this.history(tx, 'purchase_order', po.id, null, status, actorUserId);
      await this.audit.record(tx, { action: 'PO_CREATED', entityType: 'purchase_order', entityId: po.id, organizationId: org.id, changes: { status, lines: input.items.length } });
      if (status === 'SUBMITTED') await this.notifySubmitted(tx, po.id);
      return this.detail(tx, org, po.id);
    });
  }

  private async notifySubmitted(tx: Tx, poId: string) {
    const po = await tx.one<{ orderNumber: string; warehouseOrgId: string; pharmacyName: string }>(
      `SELECT po.order_number, po.warehouse_org_id, o.name_en AS pharmacy_name FROM purchase_orders po JOIN organizations o ON o.id = po.pharmacy_org_id WHERE po.id = $1`, [poId]);
    await this.notifications.toOrg(tx, po.warehouseOrgId, { type: 'PO_SUBMITTED', data: { orderNumber: po.orderNumber, pharmacy: po.pharmacyName, poId }, dedupeKey: `po-submitted:${poId}` }, ['ORG_OWNER', 'ORG_MANAGER']);
  }

  async submit(org: OrgContext, actorUserId: string, poId: string) {
    return this.db.tx(async (tx) => {
      const po = await this.load(tx, org, poId, true);
      if (po.pharmacyOrgId !== org.id) throw Errors.forbidden('Only the ordering pharmacy can submit this order');
      await this.setStatus(tx, poId, po.status, 'SUBMITTED', actorUserId);
      await tx.exec('UPDATE purchase_orders SET submitted_at = now() WHERE id = $1', [poId]);
      await this.audit.record(tx, { action: 'PO_SUBMITTED', entityType: 'purchase_order', entityId: poId, organizationId: org.id });
      await this.notifySubmitted(tx, poId);
      return this.detail(tx, org, poId);
    });
  }

  /**
   * Warehouse accepts the order (fully or partially). Confirmation implies allocation: confirmed
   * quantities are reserved in warehouse stock in the same transaction (no oversell window).
   */
  async confirm(org: OrgContext, actorUserId: string, poId: string, input: z.infer<typeof ConfirmPoSchema>, idemKey?: string) {
    return this.idem.execute(`po-confirm:${poId}`, idemKey, input, async (tx) => {
      const po = await this.load(tx, org, poId, true);
      if (po.warehouseOrgId !== org.id) throw Errors.forbidden('Only the supplying warehouse can confirm this order');
      if (po.status !== 'SUBMITTED') throw Errors.invalidState(`Order is ${po.status}; only SUBMITTED orders can be confirmed`);
      const lines = await tx.query<{ id: string; medicineId: string; requestedQty: number }>('SELECT id, medicine_id, requested_qty FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
      const decisions = new Map(input.items.map((i) => [i.itemId, i.confirmedQty]));
      if (decisions.size !== lines.length || lines.some((l) => !decisions.has(l.id))) {
        throw Errors.badRequest('Provide a confirmedQty for every order line (use 0 to decline a line)');
      }
      for (const l of lines) {
        if (decisions.get(l.id)! > l.requestedQty) throw Errors.unprocessable('OVER_CONFIRMATION', 'Confirmed quantity cannot exceed requested quantity', { itemId: l.id });
      }
      const total = [...decisions.values()].reduce((a, b) => a + b, 0);
      if (total === 0) throw Errors.unprocessable('NOTHING_CONFIRMED', 'All lines are zero; reject the order instead');

      // Resolve warehouse stock lines and lock them in a deterministic order (deadlock avoidance).
      const stock = await tx.query<{ id: string; medicineId: string; availableQty: number; unitPrice: string | null }>(
        `SELECT id, medicine_id, available_qty, unit_price FROM inventory_items WHERE organization_id = $1 AND medicine_id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
        [org.id, lines.map((l) => l.medicineId)]);
      const plan = lines
        .map((l) => ({ line: l, qty: decisions.get(l.id)!, stock: stock.find((s) => s.medicineId === l.medicineId) }))
        .sort((a, b) => (a.stock?.id ?? '').localeCompare(b.stock?.id ?? ''));
      const shortages = plan.filter((p) => p.qty > 0 && (!p.stock || p.stock.availableQty < p.qty))
        .map((p) => ({ itemId: p.line.id, medicineId: p.line.medicineId, requested: p.qty, available: p.stock?.availableQty ?? 0 }));
      if (shortages.length) throw Errors.conflict('INSUFFICIENT_STOCK', 'Not enough available warehouse stock to allocate the confirmed quantities', { shortages });

      for (const p of plan) {
        if (p.qty > 0) {
          await this.ledger.apply(tx, { itemId: p.stock!.id, type: 'ALLOCATION', reservedDelta: p.qty, source: 'MANUAL', actorUserId, referenceType: 'PURCHASE_ORDER', referenceId: poId, note: po.orderNumber });
        }
        await tx.exec(
          `UPDATE purchase_order_items SET confirmed_qty = $2, allocated_qty = $2, warehouse_inventory_item_id = $3, unit_price = $4 WHERE id = $1`,
          [p.line.id, p.qty, p.stock?.id ?? null, p.stock?.unitPrice ?? null]);
      }
      const full = plan.every((p) => p.qty === p.line.requestedQty);
      const next: PoStatus = full ? 'CONFIRMED' : 'PARTIALLY_CONFIRMED';
      await this.setStatus(tx, poId, po.status, next, actorUserId, input.note);
      await tx.exec('UPDATE purchase_orders SET decided_at = now(), decided_by = $2, decision_note = $3 WHERE id = $1', [poId, actorUserId, input.note ?? null]);
      await this.audit.record(tx, { action: 'PO_CONFIRMED', entityType: 'purchase_order', entityId: poId, organizationId: org.id, changes: { status: next, lines: Object.fromEntries(decisions) } });
      await this.notifications.toOrg(tx, po.pharmacyOrgId, { type: 'PO_DECIDED', data: { orderNumber: po.orderNumber, status: next, statusAr: STATUS_AR[next], warehouse: po.warehouseName, poId }, dedupeKey: `po-decided:${poId}` });
      return this.detail(tx, org, poId);
    });
  }

  async reject(org: OrgContext, actorUserId: string, poId: string, reason: string) {
    return this.db.tx(async (tx) => {
      const po = await this.load(tx, org, poId, true);
      if (po.warehouseOrgId !== org.id) throw Errors.forbidden('Only the supplying warehouse can reject this order');
      await this.setStatus(tx, poId, po.status, 'REJECTED', actorUserId, reason);
      await tx.exec('UPDATE purchase_orders SET decided_at = now(), decided_by = $2, decision_note = $3 WHERE id = $1', [poId, actorUserId, reason]);
      await this.audit.record(tx, { action: 'PO_REJECTED', entityType: 'purchase_order', entityId: poId, organizationId: org.id, changes: { reason } });
      await this.notifications.toOrg(tx, po.pharmacyOrgId, { type: 'PO_DECIDED', data: { orderNumber: po.orderNumber, status: 'REJECTED', statusAr: STATUS_AR.REJECTED, warehouse: po.warehouseName, poId }, dedupeKey: `po-decided:${poId}` });
      return this.detail(tx, org, poId);
    });
  }

  /** Releases every outstanding allocation of a PO back to warehouse available stock. */
  private async releaseAllocations(tx: Tx, poId: string, orderNumber: string, actorUserId: string) {
    const lines = await tx.query<{ id: string; allocatedQty: number; warehouseInventoryItemId: string }>(
      `SELECT id, allocated_qty, warehouse_inventory_item_id FROM purchase_order_items WHERE purchase_order_id = $1 AND allocated_qty > 0 ORDER BY warehouse_inventory_item_id FOR UPDATE`, [poId]);
    for (const l of lines) {
      await this.ledger.apply(tx, { itemId: l.warehouseInventoryItemId, type: 'ALLOCATION_RELEASE', reservedDelta: -l.allocatedQty, source: 'MANUAL', actorUserId, referenceType: 'PURCHASE_ORDER', referenceId: poId, note: orderNumber });
      await tx.exec('UPDATE purchase_order_items SET allocated_qty = 0 WHERE id = $1', [l.id]);
    }
    return lines.length;
  }

  async cancel(org: OrgContext, actorUserId: string, poId: string, reason: string) {
    return this.db.tx(async (tx) => {
      const po = await this.load(tx, org, poId, true);
      const dispatched = await tx.one<{ n: number }>('SELECT coalesce(sum(dispatched_qty),0)::int AS n FROM purchase_order_items WHERE purchase_order_id = $1', [poId]);
      if (dispatched.n > 0) throw Errors.invalidState('Goods were already dispatched; close the order instead of cancelling it');
      const drafts = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM shipments WHERE purchase_order_id = $1 AND status = 'DRAFT'`, [poId]);
      if (drafts.n > 0) await tx.exec(`UPDATE shipments SET status = 'CANCELLED' WHERE purchase_order_id = $1 AND status = 'DRAFT'`, [poId]);
      await this.setStatus(tx, poId, po.status, 'CANCELLED', actorUserId, reason);
      const released = await this.releaseAllocations(tx, poId, po.orderNumber, actorUserId);
      await tx.exec('UPDATE purchase_orders SET cancelled_at = now(), cancelled_by = $2, cancellation_reason = $3 WHERE id = $1', [poId, actorUserId, reason]);
      await this.audit.record(tx, { action: 'PO_CANCELLED', entityType: 'purchase_order', entityId: poId, organizationId: org.id, changes: { reason, releasedLines: released, cancelledBy: org.type } });
      const other = org.id === po.pharmacyOrgId ? po.warehouseOrgId : po.pharmacyOrgId;
      await this.notifications.toOrg(tx, other, { type: 'PO_CANCELLED', data: { orderNumber: po.orderNumber, reason, poId }, dedupeKey: `po-cancelled:${poId}` });
      return this.detail(tx, org, poId);
    });
  }

  /** Finishes an order short: releases undispatched allocations once no shipment is open. */
  async close(org: OrgContext, actorUserId: string, poId: string, reason: string) {
    return this.db.tx(async (tx) => {
      const po = await this.load(tx, org, poId, true);
      const open = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM shipments WHERE purchase_order_id = $1 AND status = ANY($2::text[])`, [poId, OPEN_SHIPMENT]);
      if (open.n > 0) throw Errors.invalidState('Close or receive all open shipments first');
      await this.setStatus(tx, poId, po.status, 'CLOSED', actorUserId, reason);
      await this.releaseAllocations(tx, poId, po.orderNumber, actorUserId);
      await this.audit.record(tx, { action: 'PO_CLOSED', entityType: 'purchase_order', entityId: poId, organizationId: org.id, changes: { reason } });
      return this.detail(tx, org, poId);
    });
  }

  /** Recomputes order status from line counters and shipments (called after receipts). */
  async recompute(tx: Tx, poId: string, actorUserId: string | null) {
    const po = await tx.one<{ status: PoStatus }>('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId]);
    const agg = await tx.one<{ allocated: number; discrepancies: number; received: number }>(
      `SELECT coalesce(sum(allocated_qty),0)::int AS allocated, coalesce(sum(damaged_qty + missing_qty),0)::int AS discrepancies,
              coalesce(sum(received_qty + damaged_qty + missing_qty),0)::int AS received FROM purchase_order_items WHERE purchase_order_id = $1`, [poId]);
    const open = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM shipments WHERE purchase_order_id = $1 AND status = ANY($2::text[])`, [poId, OPEN_SHIPMENT]);
    if (agg.received === 0) return;
    const next: PoStatus = agg.allocated === 0 && open.n === 0 && agg.discrepancies === 0 ? 'DELIVERED' : 'PARTIALLY_DELIVERED';
    if (po.status !== next) await this.setStatus(tx, poId, po.status, next, actorUserId);
  }

  get(org: OrgContext, poId: string) {
    return this.detail(this.db, org, poId);
  }

  async detail(q: Queryable, org: OrgContext, poId: string) {
    const po = await q.maybeOne<Record<string, unknown>>(
      `SELECT po.id, po.order_number, po.status, po.pharmacy_org_id, po.warehouse_org_id, ph.name_en AS pharmacy_name, ph.name_ar AS pharmacy_name_ar,
              wh.name_en AS warehouse_name, wh.name_ar AS warehouse_name_ar, po.requested_delivery_date, po.notes, po.decision_note, po.cancellation_reason,
              po.currency, po.created_at, po.submitted_at, po.decided_at, po.cancelled_at, po.version
         FROM purchase_orders po JOIN organizations ph ON ph.id = po.pharmacy_org_id JOIN organizations wh ON wh.id = po.warehouse_org_id
        WHERE po.id = $1 AND (po.pharmacy_org_id = $2 OR po.warehouse_org_id = $2)`, [poId, org.id]);
    if (!po) throw Errors.notFound('Purchase order');
    const items = await q.query(
      `SELECT poi.id, poi.medicine_id, m.brand_name_en, m.brand_name_ar, m.strength, m.dosage_form, m.package_size::float AS package_size, m.package_unit,
              poi.requested_qty, poi.confirmed_qty, poi.allocated_qty, poi.dispatched_qty, poi.received_qty, poi.damaged_qty, poi.missing_qty, poi.unit_price
         FROM purchase_order_items poi JOIN medicines m ON m.id = poi.medicine_id WHERE poi.purchase_order_id = $1 ORDER BY m.brand_name_en`, [poId]);
    const shipments = await q.query<{ status: string; estimatedDeliveryAt: Date | null; scheduleConfidence: string }>(
      `SELECT id, shipment_number, status, carrier, tracking_number, planned_dispatch_at, dispatched_at, estimated_delivery_at, schedule_confidence,
              schedule_updated_at, delay_reason, arrived_at, received_at FROM shipments WHERE purchase_order_id = $1 ORDER BY created_at`, [poId]);
    const history = await q.query(`SELECT h.from_status, h.to_status, h.note, h.created_at, u.full_name AS actor_name FROM status_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.entity_type = 'purchase_order' AND h.entity_id = $1 ORDER BY h.id`, [poId]);
    return { ...po, viewerRole: org.id === po.pharmacyOrgId ? 'BUYER' : 'SELLER', items, shipments: shipments.map((s) => ({ ...s, deliveryDateStatus: deliveryDateStatus(s) })), history };
  }

  async list(org: OrgContext, f: z.infer<typeof PoListSchema>) {
    const col = org.type === 'PHARMACY' ? 'pharmacy_org_id' : 'warehouse_org_id';
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT po.id, po.order_number, po.status, po.created_at, po.submitted_at, po.requested_delivery_date,
              ph.name_en AS pharmacy_name, wh.name_en AS warehouse_name,
              (SELECT count(*)::int FROM purchase_order_items WHERE purchase_order_id = po.id) AS line_count,
              (SELECT coalesce(sum(requested_qty),0)::int FROM purchase_order_items WHERE purchase_order_id = po.id) AS total_requested,
              (SELECT min(estimated_delivery_at) FROM shipments s WHERE s.purchase_order_id = po.id AND s.status = ANY($5::text[])) AS next_eta,
              count(*) OVER()::int AS total
         FROM purchase_orders po JOIN organizations ph ON ph.id = po.pharmacy_org_id JOIN organizations wh ON wh.id = po.warehouse_org_id
        WHERE po.${col} = $1 AND ($2::text IS NULL OR po.status = $2)
        ORDER BY po.created_at DESC LIMIT $3 OFFSET $4`,
      [org.id, f.status ?? null, f.pageSize, (f.page - 1) * f.pageSize, OPEN_SHIPMENT]);
    return { items: rows, total: (rows[0]?.total as number) ?? 0, page: f.page, pageSize: f.pageSize };
  }
}
