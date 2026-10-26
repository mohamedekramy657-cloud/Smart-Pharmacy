/** Supply-chain edge cases, concurrency and integration idempotency (Section 21). */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database } from '../../src/database/db';
import { signWebhook } from '../../src/modules/integrations/integrations.service';
import { RequestsService } from '../../src/modules/patient/requests.service';
import { addStock, Client, createAdmin, createMedicine, createTestApp, createVerifiedOrg, expectStatus, north, OrgHandle, registerPatient, truncateAll } from '../helpers';

describe('Supply chain, concurrency and integrations', () => {
  let app: INestApplication;
  let db: Database;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let admin: Client;
  let ph: OrgHandle;
  let wh: OrgHandle;

  const P = (path: string) => `/api/v1/orgs/${ph.orgId}${path}`;
  const W = (path: string) => `/api/v1/orgs/${wh.orgId}${path}`;
  const stockOf = (orgId: string, medicineId: string) =>
    db.maybeOne<{ physicalQty: number; reservedQty: number; unavailableQty: number; availableQty: number }>('SELECT physical_qty, reserved_qty, unavailable_qty, available_qty FROM inventory_items WHERE organization_id = $1 AND medicine_id = $2', [orgId, medicineId]);

  async function order(medicineId: string, qty: number) {
    const po = expectStatus(await ph.client.post(P('/purchase-orders'), { warehouseOrgId: wh.orgId, items: [{ medicineId, quantity: qty }] }), 201).body;
    return { poId: po.id as string, itemId: po.items[0].id as string };
  }

  beforeAll(async () => {
    ({ app, db, server } = await createTestApp());
    await truncateAll(db);
    admin = await createAdmin(db, server);
    ph = await createVerifiedOrg(server, admin, 'PHARMACY', north(2));
    wh = await createVerifiedOrg(server, admin, 'WAREHOUSE', north(5));
    const rel = expectStatus(await ph.client.post(P('/relationships'), { warehouseOrgId: wh.orgId }), 201).body;
    expectStatus(await wh.client.patch(W(`/relationships/${rel.id}`), { status: 'ACTIVE' }), 200);
  });
  afterAll(async () => { await app.close(); });

  it('rejects confirmation beyond available warehouse stock and supports partial confirmation', async () => {
    const med = await createMedicine(admin);
    await addStock(wh, med.id, 30);
    const { poId, itemId } = await order(med.id, 50);
    const over = await wh.client.post(W(`/purchase-orders/${poId}/confirm`), { items: [{ itemId, confirmedQty: 50 }] });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(over.body.error.details.shortages[0]).toMatchObject({ requested: 50, available: 30 });
    const partial = expectStatus(await wh.client.post(W(`/purchase-orders/${poId}/confirm`), { items: [{ itemId, confirmedQty: 30 }] }), 200).body;
    expect(partial.status).toBe('PARTIALLY_CONFIRMED');
    expect(await stockOf(wh.orgId, med.id)).toMatchObject({ physicalQty: 30, reservedQty: 30, availableQty: 0 });
    // A second order cannot double-allocate the same units.
    const second = await order(med.id, 1);
    expect((await wh.client.post(W(`/purchase-orders/${second.poId}/confirm`), { items: [{ itemId: second.itemId, confirmedQty: 1 }] })).status).toBe(409);
  });

  it('releases allocation when a confirmed PO is cancelled, and forbids cancelling after dispatch', async () => {
    const med = await createMedicine(admin);
    await addStock(wh, med.id, 100);
    const a = await order(med.id, 40);
    expectStatus(await wh.client.post(W(`/purchase-orders/${a.poId}/confirm`), { items: [{ itemId: a.itemId, confirmedQty: 40 }] }), 200);
    expect(await stockOf(wh.orgId, med.id)).toMatchObject({ reservedQty: 40, availableQty: 60 });
    const cancelled = expectStatus(await ph.client.post(P(`/purchase-orders/${a.poId}/cancel`), { reason: 'Found stock elsewhere' }), 200).body;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.items[0].allocatedQty).toBe(0);
    expect(await stockOf(wh.orgId, med.id)).toMatchObject({ reservedQty: 0, availableQty: 100 });

    const b = await order(med.id, 10);
    expectStatus(await wh.client.post(W(`/purchase-orders/${b.poId}/confirm`), { items: [{ itemId: b.itemId, confirmedQty: 10 }] }), 200);
    const sh = expectStatus(await wh.client.post(W('/shipments'), { purchaseOrderId: b.poId, items: [{ purchaseOrderItemId: b.itemId, quantity: 10 }] }), 201).body;
    expectStatus(await wh.client.post(W(`/shipments/${sh.id}/dispatch`)), 200);
    const late = await ph.client.post(P(`/purchase-orders/${b.poId}/cancel`), { reason: 'too late' });
    expect(late.status).toBe(409);
    expect((await wh.client.post(W(`/shipments/${sh.id}/dispatch`))).status).toBe(409); // double dispatch rejected
  });

  it('records damaged and missing units as discrepancies on a short shipment (never silently discarded)', async () => {
    const med = await createMedicine(admin);
    await addStock(wh, med.id, 100);
    const { poId, itemId } = await order(med.id, 20);
    expectStatus(await wh.client.post(W(`/purchase-orders/${poId}/confirm`), { items: [{ itemId, confirmedQty: 20 }] }), 200);
    const sh = expectStatus(await wh.client.post(W('/shipments'), { purchaseOrderId: poId, items: [{ purchaseOrderItemId: itemId, quantity: 20 }] }), 201).body;
    expectStatus(await wh.client.post(W(`/shipments/${sh.id}/dispatch`)), 200);
    const over = await ph.client.post(P(`/shipments/${sh.id}/receive`), { items: [{ shipmentItemId: sh.items[0].id, receivedQty: 21 }] });
    expect(over.status).toBe(422);
    const rec = expectStatus(await ph.client.post(P(`/shipments/${sh.id}/receive`), { items: [{ shipmentItemId: sh.items[0].id, receivedQty: 15, damagedQty: 2, note: '2 crushed boxes' }] }), 200).body;
    expect(rec.status).toBe('PARTIALLY_DELIVERED');
    expect(rec.items[0]).toMatchObject({ quantity: 20, receivedQty: 15, damagedQty: 2, missingQty: 3 });
    expect(rec.discrepancies.map((d: { type: string; quantity: number }) => [d.type, d.quantity]).sort()).toEqual([['DAMAGED', 2], ['MISSING', 3]]);
    expect(await stockOf(ph.orgId, med.id)).toMatchObject({ physicalQty: 15, availableQty: 15 });
    const po = expectStatus(await ph.client.get(P(`/purchase-orders/${poId}`)), 200).body;
    expect(po.status).toBe('PARTIALLY_DELIVERED');
    const disc = expectStatus(await wh.client.get(W('/discrepancies')), 200).body;
    const missing = disc.find((d: { type: string }) => d.type === 'MISSING');
    expect((await ph.client.post(P(`/discrepancies/${missing.id}`), { action: 'ACKNOWLEDGE' })).status).toBe(403); // pharmacy cannot resolve
    expectStatus(await wh.client.post(W(`/discrepancies/${missing.id}`), { action: 'RESOLVE', resolution: 'CREDIT_ISSUED', note: 'Credit note issued' }), 200);
    expectStatus(await ph.client.post(P(`/purchase-orders/${poId}/close`), { reason: 'Shortage credited' }), 200);
  });

  it('supports partial deliveries across two shipments and tracks expected-but-not-arrived stock', async () => {
    const med = await createMedicine(admin);
    await addStock(wh, med.id, 100);
    const { poId, itemId } = await order(med.id, 30);
    expectStatus(await wh.client.post(W(`/purchase-orders/${poId}/confirm`), { items: [{ itemId, confirmedQty: 30 }] }), 200);
    const s1 = expectStatus(await wh.client.post(W('/shipments'), { purchaseOrderId: poId, items: [{ purchaseOrderItemId: itemId, quantity: 10 }], estimatedDeliveryAt: new Date(Date.now() - 3600_000).toISOString(), scheduleConfidence: 'CONFIRMED' }), 201).body;
    expect((await wh.client.post(W('/shipments'), { purchaseOrderId: poId, items: [{ purchaseOrderItemId: itemId, quantity: 25 }] })).status).toBe(422); // exceeds unplanned allocation
    expectStatus(await wh.client.post(W(`/shipments/${s1.id}/dispatch`)), 200);
    const incoming = expectStatus(await ph.client.get(P('/incoming')), 200).body.filter((r: { purchaseOrderId: string }) => r.purchaseOrderId === poId);
    expect(incoming[0]).toMatchObject({ isOverdue: true, deliveryDateStatus: 'DELAYED' }); // expected but not arrived
    expect((await stockOf(ph.orgId, med.id))).toBeNull(); // nothing counted before receipt
    expectStatus(await ph.client.post(P(`/shipments/${s1.id}/receive`), { items: [{ shipmentItemId: s1.items[0].id, receivedQty: 10 }] }), 200);
    let po = expectStatus(await ph.client.get(P(`/purchase-orders/${poId}`)), 200).body;
    expect(po.status).toBe('PARTIALLY_DELIVERED');
    const s2 = expectStatus(await wh.client.post(W('/shipments'), { purchaseOrderId: poId, items: [{ purchaseOrderItemId: itemId, quantity: 20 }] }), 201).body;
    expectStatus(await wh.client.post(W(`/shipments/${s2.id}/dispatch`)), 200);
    expectStatus(await ph.client.post(P(`/shipments/${s2.id}/receive`), { items: [{ shipmentItemId: s2.items[0].id, receivedQty: 20 }] }), 200);
    po = expectStatus(await ph.client.get(P(`/purchase-orders/${poId}`)), 200).body;
    expect(po.status).toBe('DELIVERED');
    expect(po.items[0]).toMatchObject({ confirmedQty: 30, dispatchedQty: 30, receivedQty: 30, allocatedQty: 0 });
    expect(await stockOf(ph.orgId, med.id)).toMatchObject({ physicalQty: 30 });
  });

  it('rolls back an entire receipt when the transaction fails mid-way (no partial stock)', async () => {
    const m1 = await createMedicine(admin);
    const m2 = await createMedicine(admin);
    await addStock(wh, m1.id, 50);
    await addStock(wh, m2.id, 50);
    const po = expectStatus(await ph.client.post(P('/purchase-orders'), { warehouseOrgId: wh.orgId, items: [{ medicineId: m1.id, quantity: 5 }, { medicineId: m2.id, quantity: 5 }] }), 201).body;
    expectStatus(await wh.client.post(W(`/purchase-orders/${po.id}/confirm`), { items: po.items.map((i: { id: string }) => ({ itemId: i.id, confirmedQty: 5 })) }), 200);
    const sh = expectStatus(await wh.client.post(W('/shipments'), { purchaseOrderId: po.id, items: po.items.map((i: { id: string }) => ({ purchaseOrderItemId: i.id, quantity: 5 })) }), 201).body;
    expectStatus(await wh.client.post(W(`/shipments/${sh.id}/dispatch`)), 200);
    // Simulate a failure on the 2nd line inside the receipt transaction (temporary CHECK constraint on batches).
    await db.exec(`ALTER TABLE inventory_batches ADD CONSTRAINT test_fail_batch CHECK (batch_number <> 'FAIL-ME')`);
    await db.exec(`UPDATE shipment_items SET batch_number = 'FAIL-ME', expiry_date = '2030-01-01' WHERE shipment_id = $1 AND medicine_id = $2`, [sh.id, m2.id]);
    try {
      const res = await ph.client.post(P(`/shipments/${sh.id}/receive`), { items: sh.items.map((i: { id: string }) => ({ shipmentItemId: i.id, receivedQty: 5 })) });
      expect(res.status).toBe(409);
    } finally {
      await db.exec('ALTER TABLE inventory_batches DROP CONSTRAINT test_fail_batch');
    }
    expect(await stockOf(ph.orgId, m1.id)).toBeNull(); // first line was rolled back too
    expect((await db.one<{ status: string }>('SELECT status FROM shipments WHERE id = $1', [sh.id])).status).toBe('DISPATCHED');
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_movements WHERE reference_id = $1 AND movement_type = 'RECEIPT'`, [sh.id])).n).toBe(0);
  });

  it('two pharmacists racing to hold the last units: exactly one succeeds', async () => {
    const med = await createMedicine(admin);
    await db.exec('UPDATE pharmacies SET accepts_holds = true WHERE organization_id = $1', [ph.orgId]);
    await addStock(ph, med.id, 1);
    const pA = await registerPatient(server, `race-a-${Date.now()}@test.local`);
    const pB = await registerPatient(server, `race-b-${Date.now()}@test.local`);
    const rA = expectStatus(await pA.post('/api/v1/me/requests', { pharmacyOrgId: ph.orgId, medicineId: med.id, quantity: 1, wantsHold: true }), 201).body;
    const rB = expectStatus(await pB.post('/api/v1/me/requests', { pharmacyOrgId: ph.orgId, medicineId: med.id, quantity: 1, wantsHold: true }), 201).body;
    const [x, y] = await Promise.all([
      ph.client.post(P(`/confirmation-requests/${rA.id}/respond`), { outcome: 'HOLD', holdMinutes: 30 }),
      ph.client.post(P(`/confirmation-requests/${rB.id}/respond`), { outcome: 'HOLD', holdMinutes: 30 }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(ph.orgId, med.id)).toMatchObject({ physicalQty: 1, reservedQty: 1, availableQty: 0 });
    // The hold expires automatically and releases stock.
    await db.exec(`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE organization_id = $1 AND medicine_id = $2`, [ph.orgId, med.id]);
    const expired = await app.get(RequestsService).expireDue();
    expect(expired.holds).toBe(1);
    expect(await stockOf(ph.orgId, med.id)).toMatchObject({ reservedQty: 0, availableQty: 1 });
  });

  it('concurrent sales never oversell (row-level locking + CHECK constraints)', async () => {
    const med = await createMedicine(admin);
    const item = await addStock(ph, med.id, 5);
    const results = await Promise.all(Array.from({ length: 8 }, () => ph.client.post(P(`/inventory/${item.id}/adjustments`), { type: 'SALE', qty: 1 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await stockOf(ph.orgId, med.id)).toMatchObject({ physicalQty: 0, availableQty: 0 });
    expect((await db.query('SELECT * FROM sp_inventory_ledger_mismatches()'))).toHaveLength(0);
  });

  it('ignores duplicate and out-of-order integration events', async () => {
    const med = await createMedicine(admin);
    const integ = expectStatus(await ph.client.post(P('/integrations'), { displayName: 'POS (test)' }), 201).body;
    const send = (body: object) => {
      const raw = JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      return request(server).post(integ.webhookPath).set('Content-Type', 'application/json').set('X-SP-Timestamp', ts).set('X-SP-Signature', signWebhook(integ.secret, ts, raw)).send(raw);
    };
    const t0 = Date.now();
    const first = expectStatus(await send({ eventId: 'e-100', type: 'STOCK_SNAPSHOT', occurredAt: new Date(t0).toISOString(), items: [{ medicineId: med.id, physicalQty: 40 }] }), 200).body;
    expect(first).toMatchObject({ status: 'PROCESSED', applied: 1 });
    const dup = expectStatus(await send({ eventId: 'e-100', type: 'STOCK_SNAPSHOT', occurredAt: new Date(t0).toISOString(), items: [{ medicineId: med.id, physicalQty: 40 }] }), 200).body;
    expect(dup.status).toBe('DUPLICATE');
    const older = expectStatus(await send({ eventId: 'e-099', type: 'STOCK_SNAPSHOT', occurredAt: new Date(t0 - 60_000).toISOString(), items: [{ medicineId: med.id, physicalQty: 7 }] }), 200).body;
    expect(older).toMatchObject({ applied: 0, skipped: 1 });
    expect(await stockOf(ph.orgId, med.id)).toMatchObject({ physicalQty: 40 });
    const movements = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_movements WHERE movement_type = 'INTEGRATION_SYNC' AND medicine_id = $1`, [med.id]);
    expect(movements.n).toBe(1);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const raw = JSON.stringify({ eventId: 'e-101', type: 'STOCK_SNAPSHOT', occurredAt: new Date().toISOString(), items: [{ medicineId: med.id, physicalQty: 1 }] });
    expect((await request(server).post(integ.webhookPath).set('Content-Type', 'application/json').set('X-SP-Timestamp', stale).set('X-SP-Signature', signWebhook(integ.secret, stale, raw)).send(raw)).status).toBe(401); // replay window
  });

  it('imports CSV stock all-or-nothing with row-level validation', async () => {
    const med = await createMedicine(admin, { barcode: '6221234567890' });
    const bad = await ph.client.post(P('/inventory/imports'), { mode: 'commit', csv: 'barcode,physical_qty\n6221234567890,12\n0000000000000,5\n6221234567890,abc' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.errors.map((e: { line: number }) => e.line)).toEqual([3, 4]);
    expect(await stockOf(ph.orgId, med.id)).toBeNull();
    const ok = expectStatus(await ph.client.post(P('/inventory/imports'), { mode: 'commit', csv: 'barcode,physical_qty,low_stock_threshold\n6221234567890,12,4' }), 201).body;
    expect(ok).toMatchObject({ status: 'COMMITTED', applied: 1 });
    const again = expectStatus(await ph.client.post(P('/inventory/imports'), { mode: 'commit', csv: 'barcode,physical_qty,low_stock_threshold\n6221234567890,12,4' }), 201).body;
    expect(again.status).toBe('ALREADY_COMMITTED');
    expect(await stockOf(ph.orgId, med.id)).toMatchObject({ physicalQty: 12 });
  });
});
