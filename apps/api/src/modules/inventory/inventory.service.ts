import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Errors } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency.service';
import { SettingsService } from '../../common/settings.service';
import { zMoney, zText } from '../../common/zod';
import { Database, Queryable } from '../../database/db';
import { classifyListing, FreshnessSettings } from './freshness';
import { LedgerService, MovementSource } from './ledger.service';

const zCount = z.number().int().min(0).max(1_000_000);
const zPositive = z.number().int().min(1).max(1_000_000);
const zSource = z.enum(['MANUAL', 'BARCODE']).default('MANUAL');

export const AddItemSchema = z.object({
  medicineId: z.uuid(),
  openingQty: zCount.default(0),
  lowStockThreshold: zCount.optional(),
  batch: z.object({ batchNumber: z.string().trim().min(1).max(64), expiryDate: z.iso.date() }).strict().optional(),
  source: zSource,
}).strict();

export const AdjustmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STOCK_COUNT'), countedQty: zCount, note: zText().optional(), expectedVersion: z.number().int().optional(), source: zSource }).strict(),
  z.object({ type: z.literal('RECEIVE_EXTERNAL'), qty: zPositive, note: zText().optional(), expectedVersion: z.number().int().optional(), source: zSource }).strict(),
  z.object({ type: z.literal('SALE'), qty: zPositive, note: zText().optional(), expectedVersion: z.number().int().optional(), source: zSource }).strict(),
  z.object({ type: z.literal('WRITE_OFF'), qty: zPositive, reasonCode: z.enum(['DAMAGED', 'EXPIRED', 'LOST', 'RECALLED']), fromUnavailable: z.boolean().default(false), note: zText().optional(), expectedVersion: z.number().int().optional(), source: zSource }).strict(),
  z.object({ type: z.literal('MARK_UNAVAILABLE'), qty: zPositive, reasonCode: z.enum(['DAMAGED', 'EXPIRED', 'QUARANTINE', 'RECALLED']), note: zText().optional(), expectedVersion: z.number().int().optional(), source: zSource }).strict(),
  z.object({ type: z.literal('RESTORE_AVAILABLE'), qty: zPositive, note: zText().optional(), expectedVersion: z.number().int().optional(), source: zSource }).strict(),
]);

export const ItemSettingsSchema = z.object({
  lowStockThreshold: zCount.nullable().optional(),
  isListed: z.boolean().optional(),
  availabilityOverride: z.enum(['TEMPORARILY_UNAVAILABLE']).nullable().optional(),
  overrideReason: zText(300).nullable().optional(),
}).strict();

export const PriceSchema = z.object({ unitPrice: zMoney.nullable() }).strict();

export const BatchSchema = z.object({
  batchNumber: z.string().trim().min(1).max(64),
  expiryDate: z.iso.date(),
  quantity: zCount,
  status: z.enum(['ACTIVE', 'QUARANTINED', 'EXPIRED', 'RECALLED', 'DEPLETED']).default('ACTIVE'),
}).strict();

export const InventoryListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(['ALL', 'LOW_STOCK', 'OUT_OF_STOCK', 'STALE', 'UNLISTED']).default('ALL'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const ITEM_COLUMNS = `i.id, i.organization_id, i.medicine_id, i.physical_qty, i.reserved_qty, i.unavailable_qty, i.available_qty,
  i.low_stock_threshold, i.is_listed, i.availability_override, i.override_reason, i.unit_price, i.price_currency, i.price_verified_at,
  i.last_updated_at, i.last_update_source, i.last_verified_at, i.version, i.integration_config_id, ic.health AS integration_health,
  m.brand_name_en, m.brand_name_ar, m.generic_name_en, m.strength, m.dosage_form, m.package_size::float AS package_size, m.package_unit,
  m.manufacturer, m.barcode, m.status AS medicine_status, m.prescription_class`;

@Injectable()
export class InventoryService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
    private readonly settings: SettingsService,
  ) {}

  private async decorate<T extends Record<string, unknown>>(rows: T[]): Promise<Array<T & { freshness: string; availabilityStatus: string; ageMinutes: number }>> {
    const windows = (await this.settings.get('freshness.bySource')) as FreshnessSettings;
    return rows.map((r) => {
      const c = classifyListing({
        availableQty: r.availableQty as number, lowStockThreshold: r.lowStockThreshold as number | null,
        lastUpdatedAt: r.lastUpdatedAt as Date, lastUpdateSource: r.lastUpdateSource as never, isListed: r.isListed as boolean,
        availabilityOverride: r.availabilityOverride as string | null, integrationHealth: r.integrationHealth as string | null,
      }, 1, windows);
      return { ...r, freshness: c.tier, availabilityStatus: c.status, ageMinutes: c.ageMinutes };
    });
  }

  async list(orgId: string, f: z.infer<typeof InventoryListSchema>) {
    const windows = (await this.settings.get('freshness.bySource')) as FreshnessSettings;
    const maxStale = Math.min(...Object.values(windows).map((w) => w.staleMinutes));
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS}, count(*) OVER()::int AS total
         FROM inventory_items i JOIN medicines m ON m.id = i.medicine_id LEFT JOIN integration_configs ic ON ic.id = i.integration_config_id
        WHERE i.organization_id = $1
          AND ($2::text IS NULL OR sp_normalize_text(m.brand_name_en || ' ' || m.generic_name_en || ' ' || coalesce(m.brand_name_ar,'')) LIKE '%' || sp_normalize_text($2) || '%')
          AND CASE $3 WHEN 'LOW_STOCK' THEN i.low_stock_threshold IS NOT NULL AND i.available_qty <= i.low_stock_threshold AND i.available_qty > 0
                      WHEN 'OUT_OF_STOCK' THEN i.available_qty <= 0
                      WHEN 'STALE' THEN i.last_updated_at < now() - make_interval(mins => $6)
                      WHEN 'UNLISTED' THEN NOT i.is_listed OR i.availability_override IS NOT NULL
                      ELSE true END
        ORDER BY m.brand_name_en, m.strength LIMIT $4 OFFSET $5`,
      [orgId, f.q ?? null, f.filter, f.pageSize, (f.page - 1) * f.pageSize, maxStale]);
    return { items: await this.decorate(rows), total: (rows[0]?.total as number) ?? 0, page: f.page, pageSize: f.pageSize };
  }

  async get(orgId: string, itemId: string, q: Queryable = this.db) {
    const row = await q.maybeOne<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS} FROM inventory_items i JOIN medicines m ON m.id = i.medicine_id LEFT JOIN integration_configs ic ON ic.id = i.integration_config_id
        WHERE i.id = $1 AND i.organization_id = $2`, [itemId, orgId]);
    if (!row) throw Errors.notFound('Inventory item');
    const batches = await q.query(`SELECT id, batch_number, expiry_date, quantity, status, created_at FROM inventory_batches WHERE inventory_item_id = $1 ORDER BY expiry_date`, [itemId]);
    const [decorated] = await this.decorate([row]);
    return { ...decorated, batches };
  }

  async movements(orgId: string, itemId: string, page = 1, pageSize = 50) {
    await this.assertItem(this.db, orgId, itemId);
    return this.db.query(
      `SELECT mv.id, mv.movement_type, mv.physical_delta, mv.reserved_delta, mv.unavailable_delta, mv.physical_after, mv.reserved_after,
              mv.unavailable_after, mv.source, mv.reason_code, mv.note, mv.reference_type, mv.reference_id, mv.created_at, u.full_name AS actor_name
         FROM inventory_movements mv LEFT JOIN users u ON u.id = mv.actor_user_id
        WHERE mv.inventory_item_id = $1 ORDER BY mv.id DESC LIMIT $2 OFFSET $3`, [itemId, pageSize, (page - 1) * pageSize]);
  }

  private async assertItem(q: Queryable, orgId: string, itemId: string, lock = false) {
    const item = await q.maybeOne<{ id: string; version: number; physicalQty: number; reservedQty: number; unavailableQty: number }>(
      `SELECT id, version, physical_qty, reserved_qty, unavailable_qty FROM inventory_items WHERE id = $1 AND organization_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [itemId, orgId]);
    if (!item) throw Errors.notFound('Inventory item');
    return item;
  }

  async addItem(orgId: string, actorUserId: string, input: z.infer<typeof AddItemSchema>, idemKey?: string) {
    return this.idem.execute(`inv-add:${orgId}`, idemKey, input, async (tx) => {
      const med = await tx.maybeOne<{ status: string }>('SELECT status FROM medicines WHERE id = $1', [input.medicineId]);
      if (!med) throw Errors.notFound('Medicine');
      if (med.status !== 'ACTIVE') throw Errors.unprocessable('MEDICINE_NOT_ACTIVE', `This product is ${med.status.toLowerCase()} and cannot be added to inventory`);
      const { id, created } = await this.ledger.ensureItem(tx, orgId, input.medicineId);
      if (!created) throw Errors.conflict('ALREADY_IN_INVENTORY', 'This product is already in your inventory', { itemId: id });
      if (input.lowStockThreshold !== undefined) await tx.exec('UPDATE inventory_items SET low_stock_threshold = $2 WHERE id = $1', [id, input.lowStockThreshold]);
      await this.ledger.apply(tx, { itemId: id, type: 'OPENING_BALANCE', physicalDelta: input.openingQty, source: input.source, actorUserId, note: 'Opening balance' });
      if (input.batch && input.openingQty > 0) {
        await tx.exec('INSERT INTO inventory_batches (inventory_item_id, batch_number, expiry_date, quantity) VALUES ($1,$2,$3,$4)', [id, input.batch.batchNumber, input.batch.expiryDate, input.openingQty]);
      }
      await this.audit.record(tx, { action: 'INVENTORY_ITEM_ADDED', entityType: 'inventory_item', entityId: id, organizationId: orgId, changes: { medicineId: input.medicineId, openingQty: input.openingQty } });
      return this.get(orgId, id, tx);
    });
  }

  async adjust(orgId: string, itemId: string, actorUserId: string, input: z.infer<typeof AdjustmentSchema>, idemKey?: string) {
    return this.idem.execute(`inv-adjust:${itemId}`, idemKey, input, async (tx) => {
      const item = await this.assertItem(tx, orgId, itemId, true);
      if (input.expectedVersion !== undefined && input.expectedVersion !== item.version) {
        throw Errors.conflict('STALE_VERSION', 'This stock line changed since you loaded it. Reload and try again.', { currentVersion: item.version });
      }
      const source = input.source as MovementSource;
      const base = { itemId, source, actorUserId, note: input.note, idempotencyKey: idemKey };
      switch (input.type) {
        case 'STOCK_COUNT': {
          const minimum = item.reservedQty + item.unavailableQty;
          if (input.countedQty < minimum) {
            throw Errors.unprocessable('COUNT_BELOW_COMMITTED', `Counted quantity (${input.countedQty}) is below reserved + unavailable units (${minimum}). Release holds or adjust unavailable stock first.`);
          }
          const delta = input.countedQty - item.physicalQty;
          await this.ledger.apply(tx, { ...base, type: delta === 0 ? 'COUNT_VERIFIED' : 'STOCK_COUNT', physicalDelta: delta, reasonCode: 'PHYSICAL_COUNT' });
          break;
        }
        case 'RECEIVE_EXTERNAL':
          await this.ledger.apply(tx, { ...base, type: 'ADJUSTMENT', physicalDelta: input.qty, reasonCode: 'RECEIVED_OUTSIDE_PLATFORM' });
          break;
        case 'SALE':
          await this.ledger.apply(tx, { ...base, type: 'SALE', physicalDelta: -input.qty, reasonCode: 'SALE' });
          break;
        case 'WRITE_OFF':
          await this.ledger.apply(tx, { ...base, type: 'WRITE_OFF', physicalDelta: -input.qty, unavailableDelta: input.fromUnavailable ? -input.qty : 0, reasonCode: input.reasonCode });
          break;
        case 'MARK_UNAVAILABLE':
          await this.ledger.apply(tx, { ...base, type: 'MARK_UNAVAILABLE', unavailableDelta: input.qty, reasonCode: input.reasonCode });
          break;
        case 'RESTORE_AVAILABLE':
          await this.ledger.apply(tx, { ...base, type: 'RESTORE_AVAILABLE', unavailableDelta: -input.qty, reasonCode: 'RESTORED' });
          break;
      }
      await this.audit.record(tx, { action: `INVENTORY_${input.type}`, entityType: 'inventory_item', entityId: itemId, organizationId: orgId, changes: input as Record<string, unknown> });
      return this.get(orgId, itemId, tx);
    });
  }

  /** "Stock is still accurate" — refreshes freshness without changing quantities (traceable). */
  async verify(orgId: string, itemId: string, actorUserId: string) {
    return this.db.tx(async (tx) => {
      await this.assertItem(tx, orgId, itemId, true);
      await this.ledger.apply(tx, { itemId, type: 'COUNT_VERIFIED', source: 'MANUAL', actorUserId, reasonCode: 'VERIFIED_UNCHANGED' });
      return this.get(orgId, itemId, tx);
    });
  }

  async updateSettings(orgId: string, itemId: string, input: z.infer<typeof ItemSettingsSchema>) {
    return this.db.tx(async (tx) => {
      await this.assertItem(tx, orgId, itemId, true);
      await tx.exec(
        `UPDATE inventory_items SET
            low_stock_threshold = CASE WHEN $2::boolean THEN $3::int ELSE low_stock_threshold END,
            is_listed = coalesce($4, is_listed),
            availability_override = CASE WHEN $5::boolean THEN $6 ELSE availability_override END,
            override_reason = CASE WHEN $5::boolean THEN $7 ELSE override_reason END
          WHERE id = $1`,
        [itemId, input.lowStockThreshold !== undefined, input.lowStockThreshold ?? null, input.isListed ?? null,
         input.availabilityOverride !== undefined, input.availabilityOverride ?? null, input.overrideReason ?? null]);
      await this.audit.record(tx, { action: 'INVENTORY_SETTINGS_UPDATED', entityType: 'inventory_item', entityId: itemId, organizationId: orgId, changes: input as Record<string, unknown> });
      return this.get(orgId, itemId, tx);
    });
  }

  async setPrice(orgId: string, itemId: string, unitPrice: string | null) {
    return this.db.tx(async (tx) => {
      await this.assertItem(tx, orgId, itemId, true);
      await tx.exec(`UPDATE inventory_items SET unit_price = $2::numeric, price_verified_at = CASE WHEN $2 IS NULL THEN NULL ELSE now() END WHERE id = $1`, [itemId, unitPrice]);
      await this.audit.record(tx, { action: 'INVENTORY_PRICE_SET', entityType: 'inventory_item', entityId: itemId, organizationId: orgId, changes: { unitPrice } });
      return this.get(orgId, itemId, tx);
    });
  }

  async upsertBatch(orgId: string, itemId: string, input: z.infer<typeof BatchSchema>) {
    return this.db.tx(async (tx) => {
      await this.assertItem(tx, orgId, itemId);
      const row = await tx.one<{ id: string }>(
        `INSERT INTO inventory_batches (inventory_item_id, batch_number, expiry_date, quantity, status) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (inventory_item_id, batch_number, expiry_date) DO UPDATE SET quantity = EXCLUDED.quantity, status = EXCLUDED.status RETURNING id`,
        [itemId, input.batchNumber, input.expiryDate, input.quantity, input.status]);
      await this.audit.record(tx, { action: 'INVENTORY_BATCH_UPSERTED', entityType: 'inventory_batch', entityId: row.id, organizationId: orgId, changes: input as Record<string, unknown> });
      return this.get(orgId, itemId, tx);
    });
  }

  async barcodeLookup(orgId: string, code: string) {
    if (!/^[0-9]{8,14}$/.test(code)) throw Errors.badRequest('Invalid barcode');
    const medicine = await this.db.maybeOne<{ id: string }>(`SELECT id, brand_name_en, brand_name_ar, strength, dosage_form, package_size::float AS package_size, package_unit, manufacturer, status FROM medicines WHERE barcode = $1`, [code]);
    if (!medicine) return { medicine: null, item: null };
    const item = await this.db.maybeOne<{ id: string }>('SELECT id FROM inventory_items WHERE organization_id = $1 AND medicine_id = $2', [orgId, medicine.id]);
    return { medicine, item: item ? await this.get(orgId, item.id) : null };
  }

  async expiringBatches(orgId: string, withinDays: number) {
    return this.db.query(
      `SELECT b.id, b.batch_number, b.expiry_date, b.quantity, b.status, i.id AS inventory_item_id, m.brand_name_en, m.strength, m.dosage_form
         FROM inventory_batches b JOIN inventory_items i ON i.id = b.inventory_item_id JOIN medicines m ON m.id = i.medicine_id
        WHERE i.organization_id = $1 AND b.status = 'ACTIVE' AND b.quantity > 0 AND b.expiry_date <= current_date + $2::int
        ORDER BY b.expiry_date`, [orgId, withinDays]);
  }
}
