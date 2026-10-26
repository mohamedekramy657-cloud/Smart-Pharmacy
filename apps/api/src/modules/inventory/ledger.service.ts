import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors';
import { Queryable } from '../../database/db';
import { JobsService } from '../jobs/jobs.service';

export type MovementType =
  | 'OPENING_BALANCE' | 'ADJUSTMENT' | 'STOCK_COUNT' | 'COUNT_VERIFIED' | 'CSV_IMPORT' | 'INTEGRATION_SYNC'
  | 'RECEIPT' | 'SALE' | 'DISPATCH' | 'HOLD_CREATE' | 'HOLD_RELEASE' | 'HOLD_FULFILL' | 'ALLOCATION'
  | 'ALLOCATION_RELEASE' | 'MARK_UNAVAILABLE' | 'RESTORE_AVAILABLE' | 'WRITE_OFF' | 'QC_RELEASE';
export type MovementSource = 'MANUAL' | 'BARCODE' | 'CSV_IMPORT' | 'INTEGRATION' | 'RECEIPT' | 'SYSTEM';

/** Movement types that assert the real stock level and therefore refresh inventory freshness. */
const TOUCHES_FRESHNESS = new Set<MovementType>([
  'OPENING_BALANCE', 'ADJUSTMENT', 'STOCK_COUNT', 'COUNT_VERIFIED', 'CSV_IMPORT', 'INTEGRATION_SYNC', 'RECEIPT',
  'SALE', 'DISPATCH', 'MARK_UNAVAILABLE', 'RESTORE_AVAILABLE', 'WRITE_OFF', 'QC_RELEASE',
]);

export interface MovementInput {
  itemId: string;
  type: MovementType;
  physicalDelta?: number;
  reservedDelta?: number;
  unavailableDelta?: number;
  source: MovementSource;
  actorUserId?: string | null;
  referenceType?: string;
  referenceId?: string;
  reasonCode?: string;
  note?: string;
  idempotencyKey?: string;
}

export interface Movement {
  id: number;
  inventoryItemId: string;
  organizationId: string;
  medicineId: string;
  movementType: MovementType;
  physicalDelta: number;
  reservedDelta: number;
  unavailableDelta: number;
  physicalAfter: number;
  reservedAfter: number;
  unavailableAfter: number;
  createdAt: Date;
}

/**
 * The ONLY application path that changes stock. Delegates to sp_apply_inventory_movement which
 * locks the row, enforces non-negative invariants and writes the append-only ledger atomically.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly jobs: JobsService) {}

  async ensureItem(tx: Queryable, organizationId: string, medicineId: string): Promise<{ id: string; created: boolean }> {
    const inserted = await tx.maybeOne<{ id: string }>(
      `INSERT INTO inventory_items (organization_id, medicine_id) VALUES ($1,$2) ON CONFLICT (organization_id, medicine_id) DO NOTHING RETURNING id`,
      [organizationId, medicineId]);
    if (inserted) return { id: inserted.id, created: true };
    const existing = await tx.one<{ id: string }>('SELECT id FROM inventory_items WHERE organization_id = $1 AND medicine_id = $2', [organizationId, medicineId]);
    return { id: existing.id, created: false };
  }

  async apply(tx: Queryable, m: MovementInput): Promise<Movement> {
    const physical = m.physicalDelta ?? 0;
    const reserved = m.reservedDelta ?? 0;
    const unavailable = m.unavailableDelta ?? 0;
    if (![physical, reserved, unavailable].every(Number.isInteger)) throw Errors.badRequest('Quantities must be integers');
    const mov = await tx.one<Movement>(
      `SELECT * FROM sp_apply_inventory_movement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [m.itemId, m.type, physical, reserved, unavailable, m.source, m.actorUserId ?? null, m.referenceType ?? null,
       m.referenceId ?? null, m.reasonCode ?? null, m.note ?? null, m.idempotencyKey ?? null, TOUCHES_FRESHNESS.has(m.type)]);
    await this.afterMovement(tx, mov, physical - reserved - unavailable);
    return mov;
  }

  /** Side effects are enqueued in the same transaction (outbox) and run after commit. */
  private async afterMovement(tx: Queryable, mov: Movement, availableDelta: number): Promise<void> {
    if (availableDelta === 0) return;
    const item = await tx.one<{ lowStockThreshold: number | null; orgType: string }>(
      `SELECT i.low_stock_threshold, o.type AS org_type FROM inventory_items i JOIN organizations o ON o.id = i.organization_id WHERE i.id = $1`,
      [mov.inventoryItemId]);
    const availableAfter = mov.physicalAfter - mov.reservedAfter - mov.unavailableAfter;
    const availableBefore = availableAfter - availableDelta;
    if (item.lowStockThreshold !== null && availableAfter <= item.lowStockThreshold && availableBefore > item.lowStockThreshold) {
      const day = new Date().toISOString().slice(0, 10);
      await this.jobs.enqueue(tx, 'inventory.lowStock', { itemId: mov.inventoryItemId }, { dedupeKey: `low-stock:${mov.inventoryItemId}:${day}` });
    }
    if (item.orgType === 'PHARMACY' && availableDelta > 0 && availableAfter > 0) {
      await this.jobs.enqueue(tx, 'alerts.match', { itemId: mov.inventoryItemId }, { dedupeKey: `alerts-match:${mov.inventoryItemId}`, runAt: new Date(Date.now() + 5_000) });
    }
  }
}
