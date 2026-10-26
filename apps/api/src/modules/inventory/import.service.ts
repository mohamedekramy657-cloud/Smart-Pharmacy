import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { sha256Hex } from '../../common/crypto';
import { Errors } from '../../common/errors';
import { Database } from '../../database/db';
import { LedgerService } from './ledger.service';

export const ImportSchema = z.object({
  csv: z.string().min(1).max(1_000_000, 'CSV must be at most 1 MB'),
  fileName: z.string().trim().max(200).optional(),
  mode: z.enum(['validate', 'commit']),
}).strict();

const MAX_ROWS = 5000;
const HEADER = ['barcode', 'medicine_id', 'physical_qty', 'low_stock_threshold', 'batch_number', 'expiry_date'];

/** RFC 4180-style parser (quotes, escaped quotes, CRLF). Small and dependency-free. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

interface RowResult { line: number; medicineId?: string; physicalQty?: number; lowStockThreshold?: number | null; batchNumber?: string; expiryDate?: string; errors: string[] }

/**
 * CSV stock import with SNAPSHOT semantics (physical_qty = counted quantity), which makes a
 * re-import harmless. Validation is complete before commit, and commit is all-or-nothing.
 */
@Injectable()
export class ImportService {
  constructor(private readonly db: Database, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  async run(orgId: string, actorUserId: string, input: z.infer<typeof ImportSchema>) {
    const fileHash = sha256Hex(input.csv);
    const rows = parseCsv(input.csv.replace(/^\uFEFF/, ''));
    if (!rows.length) throw Errors.badRequest('CSV is empty');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const missing = ['physical_qty'].filter((h) => !header.includes(h));
    if (missing.length || (!header.includes('barcode') && !header.includes('medicine_id'))) {
      throw Errors.badRequest(`CSV header must include physical_qty and barcode or medicine_id. Supported columns: ${HEADER.join(', ')}`);
    }
    if (rows.length - 1 > MAX_ROWS) throw Errors.badRequest(`At most ${MAX_ROWS} rows per import`);
    const col = (r: string[], name: string) => { const idx = header.indexOf(name); return idx >= 0 ? (r[idx] ?? '').trim() : ''; };

    const results: RowResult[] = [];
    const seen = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const res: RowResult = { line: i + 1, errors: [] };
      const barcode = col(r, 'barcode');
      const medicineId = col(r, 'medicine_id');
      const qty = col(r, 'physical_qty');
      const threshold = col(r, 'low_stock_threshold');
      const batch = col(r, 'batch_number');
      const expiry = col(r, 'expiry_date');
      let med: { id: string; status: string } | null = null;
      if (medicineId) {
        if (!/^[0-9a-f-]{36}$/i.test(medicineId)) res.errors.push('medicine_id is not a valid id');
        else med = await this.db.maybeOne('SELECT id, status FROM medicines WHERE id = $1', [medicineId]);
      } else if (barcode) {
        if (!/^[0-9]{8,14}$/.test(barcode)) res.errors.push('barcode must be 8-14 digits');
        else med = await this.db.maybeOne('SELECT id, status FROM medicines WHERE barcode = $1', [barcode]);
      } else res.errors.push('barcode or medicine_id is required');
      if (!res.errors.length && !med) res.errors.push('product not found in the central catalog');
      if (med && med.status !== 'ACTIVE') res.errors.push(`product is ${med.status.toLowerCase()}`);
      if (med && seen.has(med.id)) res.errors.push('duplicate product in file');
      if (med) { seen.add(med.id); res.medicineId = med.id; }
      if (!/^\d{1,7}$/.test(qty)) res.errors.push('physical_qty must be a whole number between 0 and 9999999');
      else res.physicalQty = Number(qty);
      if (threshold) { if (!/^\d{1,7}$/.test(threshold)) res.errors.push('low_stock_threshold must be a whole number'); else res.lowStockThreshold = Number(threshold); }
      if (batch || expiry) {
        if (!batch || !expiry) res.errors.push('batch_number and expiry_date must be provided together');
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(expiry))) res.errors.push('expiry_date must be YYYY-MM-DD');
        else if (batch.length > 64) res.errors.push('batch_number too long');
        else { res.batchNumber = batch; res.expiryDate = expiry; }
      }
      results.push(res);
    }
    const errors = results.filter((r) => r.errors.length).map((r) => ({ line: r.line, errors: r.errors }));
    const summary = { rowCount: results.length, validRows: results.length - errors.length, errors };

    if (input.mode === 'validate' || errors.length) {
      const rec = await this.db.one<{ id: string }>(
        `INSERT INTO inventory_imports (organization_id, file_name, file_sha256, row_count, status, errors, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orgId, input.fileName ?? null, fileHash, results.length, errors.length ? 'REJECTED' : 'VALIDATED', JSON.stringify(errors), actorUserId]);
      if (input.mode === 'commit') throw Errors.unprocessable('IMPORT_INVALID', 'The file has errors; nothing was imported', { importId: rec.id, ...summary });
      return { importId: rec.id, status: errors.length ? 'REJECTED' : 'VALIDATED', ...summary };
    }

    return this.db.tx(async (tx) => {
      const already = await tx.maybeOne<{ id: string; committedAt: Date }>(`SELECT id, committed_at FROM inventory_imports WHERE organization_id = $1 AND file_sha256 = $2 AND status = 'COMMITTED'`, [orgId, fileHash]);
      if (already) return { importId: already.id, status: 'ALREADY_COMMITTED', ...summary, applied: 0 };
      const rec = await tx.one<{ id: string }>(
        `INSERT INTO inventory_imports (organization_id, file_name, file_sha256, row_count, status, created_by, committed_at) VALUES ($1,$2,$3,$4,'COMMITTED',$5, now()) RETURNING id`,
        [orgId, input.fileName ?? null, fileHash, results.length, actorUserId]);
      let changed = 0;
      for (const r of results) {
        const { id } = await this.ledger.ensureItem(tx, orgId, r.medicineId!);
        const cur = await tx.one<{ physicalQty: number; reservedQty: number; unavailableQty: number }>('SELECT physical_qty, reserved_qty, unavailable_qty FROM inventory_items WHERE id = $1 FOR UPDATE', [id]);
        if (r.physicalQty! < cur.reservedQty + cur.unavailableQty) {
          throw Errors.unprocessable('IMPORT_INVALID', `Line ${r.line}: physical_qty is below reserved + unavailable units (${cur.reservedQty + cur.unavailableQty}); nothing was imported`);
        }
        const delta = r.physicalQty! - cur.physicalQty;
        await this.ledger.apply(tx, { itemId: id, type: 'CSV_IMPORT', physicalDelta: delta, source: 'CSV_IMPORT', actorUserId, referenceType: 'IMPORT', referenceId: rec.id, idempotencyKey: `import:${rec.id}` });
        if (delta !== 0) changed++;
        if (r.lowStockThreshold !== undefined) await tx.exec('UPDATE inventory_items SET low_stock_threshold = $2 WHERE id = $1', [id, r.lowStockThreshold]);
        if (r.batchNumber) {
          await tx.exec(`INSERT INTO inventory_batches (inventory_item_id, batch_number, expiry_date, quantity) VALUES ($1,$2,$3,$4)
                         ON CONFLICT (inventory_item_id, batch_number, expiry_date) DO UPDATE SET quantity = EXCLUDED.quantity`, [id, r.batchNumber, r.expiryDate, r.physicalQty]);
        }
      }
      await this.audit.record(tx, { action: 'INVENTORY_CSV_IMPORTED', entityType: 'inventory_import', entityId: rec.id, organizationId: orgId, changes: { rows: results.length, changed } });
      return { importId: rec.id, status: 'COMMITTED', ...summary, applied: results.length, changed };
    });
  }
}
