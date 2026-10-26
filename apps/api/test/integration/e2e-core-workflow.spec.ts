/**
 * Section 28 — first end-to-end acceptance test. Every step goes through the real HTTP API,
 * authentication, authorization, validation and PostgreSQL. Nothing is mocked or hardcoded.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database } from '../../src/database/db';
import {
  addStock, Client, createAdmin, createMedicine, createTestApp, drainJobs, expectStatus, north, ORIGIN, OrgHandle,
  PASSWORD, registerOrg, registerPatient, search, truncateAll, verifyOrg,
} from '../helpers';

describe('Section 28: core pharmacy ⇄ warehouse ⇄ patient workflow', () => {
  let app: INestApplication;
  let db: Database;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let admin: Client;
  let pharmacy: OrgHandle;
  let farPharmacy: OrgHandle;
  let warehouse: OrgHandle;
  let otherWarehouse: OrgHandle;
  let patient: Client;
  let medicineId: string;
  let pharmacyItemId: string;
  let warehouseItemId: string;
  let poId: string;
  let poItemId: string;
  let shipmentId: string;
  let shipmentItemId: string;

  beforeAll(async () => {
    ({ app, db, server } = await createTestApp());
    await truncateAll(db);
    admin = await createAdmin(db, server);
  });
  afterAll(async () => { await app.close(); });

  it('1-2. admin verifies a pharmacy and a warehouse (registered through onboarding)', async () => {
    pharmacy = await registerOrg(server, 'PHARMACY', north(1.5), '[TEST] Near Pharmacy');
    farPharmacy = await registerOrg(server, 'PHARMACY', north(7), '[TEST] Far Pharmacy');
    warehouse = await registerOrg(server, 'WAREHOUSE', north(4), '[TEST] Canal Warehouse');
    otherWarehouse = await registerOrg(server, 'WAREHOUSE', north(50), '[TEST] Other Warehouse');

    const queue = expectStatus(await admin.get('/api/v1/admin/verifications'), 200).body as Array<{ organizationId: string }>;
    expect(queue.map((q) => q.organizationId)).toEqual(expect.arrayContaining([pharmacy.orgId, warehouse.orgId]));
    // Unverified pharmacy cannot place supply orders yet.
    const blocked = await pharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/relationships`, { warehouseOrgId: warehouse.orgId });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ORG_NOT_VERIFIED');

    for (const o of [pharmacy, farPharmacy, warehouse, otherWarehouse]) await verifyOrg(admin, o.orgId);
    const rows = await db.query<{ verificationStatus: string }>('SELECT verification_status FROM organizations WHERE id = ANY($1::uuid[])', [[pharmacy.orgId, warehouse.orgId]]);
    expect(rows.every((r) => r.verificationStatus === 'VERIFIED')).toBe(true);
  });

  it('3. the central catalog holds a standardized medicine record (duplicates rejected)', async () => {
    const med = await createMedicine(admin, {
      brandNameEn: 'Concor', brandNameAr: 'كونكور', genericNameEn: 'Bisoprolol fumarate', strength: '5 mg', dosageForm: 'FILM_COATED_TABLET',
      packageSize: 30, manufacturer: 'Merck (TEST DATA)', prescriptionClass: 'PRESCRIPTION', confirmDistinct: false,
      ingredients: [{ nameEn: 'Bisoprolol fumarate', strengthValue: 5, strengthUnit: 'MG' }],
    });
    medicineId = med.id;
    const dup = await admin.post('/api/v1/admin/medicines', {
      brandNameEn: 'CONCOR', genericNameEn: 'Bisoprolol fumarate', strength: '5 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 30,
      packageUnit: 'TABLET', manufacturer: 'Merck (TEST DATA)', ingredients: [{ nameEn: 'bisoprolol fumarate', strengthValue: 5, strengthUnit: 'MG' }], confirmDistinct: true,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_MEDICINE');
    const arabic = expectStatus(await request(server).get(`/api/v1/catalog/medicines?q=${encodeURIComponent('كونكور')}`), 200).body;
    expect(arabic[0].id).toBe(medicineId);
  });

  it('4-5. the pharmacy stocks it and authorized staff update stock (viewer is blocked)', async () => {
    const item = await addStock(pharmacy, medicineId, 2, { lowStockThreshold: 5 });
    pharmacyItemId = item.id;
    expect(item.physicalQty).toBe(2);

    expectStatus(await pharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/members`, { email: 'staff1@test.local', role: 'ORG_STAFF', fullName: 'Staff One', initialPassword: PASSWORD }), 201);
    expectStatus(await pharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/members`, { email: 'viewer1@test.local', role: 'ORG_VIEWER', fullName: 'Viewer One', initialPassword: PASSWORD }), 201);
    const staff = new Client(server); expectStatus(await staff.login('staff1@test.local'), 200);
    const viewer = new Client(server); expectStatus(await viewer.login('viewer1@test.local'), 200);

    const denied = await viewer.post(`/api/v1/orgs/${pharmacy.orgId}/inventory/${pharmacyItemId}/adjustments`, { type: 'STOCK_COUNT', countedQty: 50 });
    expect(denied.status).toBe(403);

    const counted = expectStatus(await staff.post(`/api/v1/orgs/${pharmacy.orgId}/inventory/${pharmacyItemId}/adjustments`, { type: 'STOCK_COUNT', countedQty: 3, expectedVersion: item.version }), 201).body;
    expect(counted.physicalQty).toBe(3);
    expect(counted.availableQty).toBe(3);
    const stale = await staff.post(`/api/v1/orgs/${pharmacy.orgId}/inventory/${pharmacyItemId}/adjustments`, { type: 'STOCK_COUNT', countedQty: 9, expectedVersion: item.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');
    await addStock(farPharmacy, medicineId, 10);
  });

  it('6. the warehouse holds the medicine in inventory', async () => {
    const item = await addStock(warehouse, medicineId, 500);
    warehouseItemId = item.id;
    expect(item.availableQty).toBe(500);
  });

  it('7. the pharmacy creates a replenishment purchase order (idempotent)', async () => {
    const rel = expectStatus(await pharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/relationships`, { warehouseOrgId: warehouse.orgId }), 201).body;
    expectStatus(await warehouse.client.patch(`/api/v1/orgs/${warehouse.orgId}/relationships/${rel.id}`, { status: 'ACTIVE', paymentTerms: 'Net 30 (test)' }), 200);

    const body = { warehouseOrgId: warehouse.orgId, items: [{ medicineId, quantity: 100 }], notes: 'replenishment' };
    const first = expectStatus(await pharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/purchase-orders`, body, { 'Idempotency-Key': 'po-key-0001' }), 201).body;
    const replay = expectStatus(await pharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/purchase-orders`, body, { 'Idempotency-Key': 'po-key-0001' }), 201).body;
    expect(replay.id).toBe(first.id);
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM purchase_orders')).n).toBe(1);
    expect(first.status).toBe('SUBMITTED');
    poId = first.id;
    poItemId = first.items[0].id;
  });

  it('8. the warehouse accepts the order (allocating stock) and schedules + dispatches delivery', async () => {
    const confirmed = expectStatus(await warehouse.client.post(`/api/v1/orgs/${warehouse.orgId}/purchase-orders/${poId}/confirm`, { items: [{ itemId: poItemId, confirmedQty: 100 }] }), 200).body;
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.items[0]).toMatchObject({ requestedQty: 100, confirmedQty: 100, allocatedQty: 100, dispatchedQty: 0 });
    let wh = expectStatus(await warehouse.client.get(`/api/v1/orgs/${warehouse.orgId}/inventory/${warehouseItemId}`), 200).body;
    expect(wh).toMatchObject({ physicalQty: 500, reservedQty: 100, availableQty: 400 });

    const eta = new Date(Date.now() + 24 * 3600_000).toISOString();
    const shipment = expectStatus(await warehouse.client.post(`/api/v1/orgs/${warehouse.orgId}/shipments`, {
      purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, quantity: 100, batchNumber: 'TB-001', expiryDate: '2028-06-30' }],
      carrier: 'Test Courier', trackingNumber: 'TRK-123', estimatedDeliveryAt: eta, scheduleConfidence: 'ESTIMATED',
    }), 201).body;
    shipmentId = shipment.id;
    shipmentItemId = shipment.items[0].id;
    const dispatched = expectStatus(await warehouse.client.post(`/api/v1/orgs/${warehouse.orgId}/shipments/${shipmentId}/dispatch`), 200).body;
    expect(dispatched.status).toBe('DISPATCHED');
    wh = expectStatus(await warehouse.client.get(`/api/v1/orgs/${warehouse.orgId}/inventory/${warehouseItemId}`), 200).body;
    expect(wh).toMatchObject({ physicalQty: 400, reservedQty: 0, availableQty: 400 });

    // Orders and dispatches must NOT increase pharmacy stock.
    const ph = expectStatus(await pharmacy.client.get(`/api/v1/orgs/${pharmacy.orgId}/inventory/${pharmacyItemId}`), 200).body;
    expect(ph.physicalQty).toBe(3);
    const incoming = expectStatus(await pharmacy.client.get(`/api/v1/orgs/${pharmacy.orgId}/incoming`), 200).body;
    expect(incoming[0]).toMatchObject({ shipmentId, status: 'DISPATCHED', confirmedQty: 100, dispatchedQty: 100, receivedQty: 0, deliveryDateStatus: 'ESTIMATED' });
  });

  it('9-13. a patient searches: verified pharmacies within 5 km, expansion when needed, freshness, incoming shown separately', async () => {
    patient = await registerPatient(server, 'patient1@test.local');
    const r1 = expectStatus(await search(server, { medicineId, quantity: 1, lat: ORIGIN.lat, lng: ORIGIN.lng, locationMethod: 'MAP_PIN' }), 200).body;
    expect(r1.outcome).toBe('FOUND');
    expect(r1.matchedRadiusKm).toBe(5);
    expect(r1.results).toHaveLength(1); // the 7 km pharmacy is outside the matched 5 km band
    const hit = r1.results[0];
    expect(hit.pharmacy).toMatchObject({ id: pharmacy.orgId, verified: true });
    expect(hit.distanceKm).toBeCloseTo(1.5, 1);
    expect(hit.availability).toMatchObject({ status: 'LOW_STOCK', freshness: 'CONFIRMED', source: 'MANUAL', quantity: null, quantityBucket: 'LIMITED' });
    expect(r1.medicine).toMatchObject({ id: medicineId, brandNameEn: 'Concor', strength: '5 mg' });
    expect(r1.incoming).toEqual([expect.objectContaining({ pharmacyId: pharmacy.orgId, label: 'EXPECTED_INCOMING', deliveryDateStatus: 'ESTIMATED' })]);

    // 5 units requested: the near pharmacy (3) is insufficient -> search expands to the 10 km band.
    const r2 = expectStatus(await search(server, { medicineId, quantity: 5, lat: ORIGIN.lat, lng: ORIGIN.lng }), 200).body;
    expect(r2.outcome).toBe('FOUND');
    expect(r2.matchedRadiusKm).toBe(10);
    expect(r2.results.map((r: { pharmacy: { id: string } }) => r.pharmacy.id)).toEqual([farPharmacy.orgId, pharmacy.orgId]);
    expect(r2.results[1].availability.status).toBe('INSUFFICIENT_QUANTITY');
  });

  it('14. the warehouse updates shipment status and delivery schedule (delay recorded and notified)', async () => {
    expectStatus(await warehouse.client.post(`/api/v1/orgs/${warehouse.orgId}/shipments/${shipmentId}/status`, { status: 'IN_TRANSIT' }), 200);
    const later = new Date(Date.now() + 48 * 3600_000).toISOString();
    const s = expectStatus(await warehouse.client.post(`/api/v1/orgs/${warehouse.orgId}/shipments/${shipmentId}/schedule`, { estimatedDeliveryAt: later, confidence: 'CONFIRMED', reason: 'Truck rescheduled' }), 200).body;
    expect(s.status).toBe('IN_TRANSIT');
    expect(s.schedule).toHaveLength(2);
    expect(s.schedule[1]).toMatchObject({ isDelay: true, newConfidence: 'CONFIRMED', reason: 'Truck rescheduled' });
    const notes = expectStatus(await pharmacy.client.get('/api/v1/me/notifications'), 200).body as Array<{ type: string }>;
    expect(notes.map((n) => n.type)).toEqual(expect.arrayContaining(['PO_DECIDED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_DELAYED']));
  });

  it('15-17. the pharmacy receives and verifies the shipment; stock rises via a ledger RECEIPT movement', async () => {
    const received = expectStatus(await pharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/shipments/${shipmentId}/receive`,
      { items: [{ shipmentItemId, receivedQty: 100, damagedQty: 0 }], note: 'All cartons intact' }, { 'Idempotency-Key': 'receipt-key-0001' }), 200).body;
    expect(received.status).toBe('DELIVERED');
    // Replaying the same receipt returns the stored result and does not add stock twice.
    expectStatus(await pharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/shipments/${shipmentId}/receive`,
      { items: [{ shipmentItemId, receivedQty: 100, damagedQty: 0 }], note: 'All cartons intact' }, { 'Idempotency-Key': 'receipt-key-0001' }), 200);

    const item = expectStatus(await pharmacy.client.get(`/api/v1/orgs/${pharmacy.orgId}/inventory/${pharmacyItemId}`), 200).body;
    expect(item).toMatchObject({ physicalQty: 103, availableQty: 103, lastUpdateSource: 'RECEIPT' });
    expect(item.batches).toEqual([expect.objectContaining({ batchNumber: 'TB-001', expiryDate: '2028-06-30', quantity: 100 })]);
    const movements = expectStatus(await pharmacy.client.get(`/api/v1/orgs/${pharmacy.orgId}/inventory/${pharmacyItemId}/movements`), 200).body;
    expect(movements[0]).toMatchObject({ movementType: 'RECEIPT', physicalDelta: 100, physicalAfter: 103, referenceType: 'SHIPMENT', referenceId: shipmentId });
    expect(movements.filter((m: { movementType: string }) => m.movementType === 'RECEIPT')).toHaveLength(1);
    const po = expectStatus(await pharmacy.client.get(`/api/v1/orgs/${pharmacy.orgId}/purchase-orders/${poId}`), 200).body;
    expect(po.status).toBe('DELIVERED');
    expect(po.items[0]).toMatchObject({ requestedQty: 100, confirmedQty: 100, allocatedQty: 0, dispatchedQty: 100, receivedQty: 100, damagedQty: 0, missingQty: 0 });
  });

  it('18. later searches reflect the received stock', async () => {
    const r = expectStatus(await search(server, { medicineId, quantity: 5, lat: ORIGIN.lat, lng: ORIGIN.lng }), 200).body;
    expect(r.outcome).toBe('FOUND');
    expect(r.matchedRadiusKm).toBe(5);
    expect(r.results[0].pharmacy.id).toBe(pharmacy.orgId);
    expect(r.results[0].availability).toMatchObject({ status: 'AVAILABLE', freshness: 'CONFIRMED', source: 'RECEIPT' });
    expect(r.incoming).toHaveLength(0);
  });

  it('19. unauthorized users are blocked from protected records', async () => {
    expect((await patient.get(`/api/v1/orgs/${pharmacy.orgId}/inventory`)).status).toBe(404);
    expect((await patient.get('/api/v1/admin/overview')).status).toBe(403);
    expect((await request(server).get(`/api/v1/orgs/${pharmacy.orgId}/inventory`)).status).toBe(401);
    const crossTenant = await farPharmacy.client.post(`/api/v1/orgs/${pharmacy.orgId}/inventory/${pharmacyItemId}/adjustments`, { type: 'SALE', qty: 1 });
    expect(crossTenant.status).toBe(404);
    const ownOrgOtherItem = await farPharmacy.client.post(`/api/v1/orgs/${farPharmacy.orgId}/inventory/${pharmacyItemId}/adjustments`, { type: 'SALE', qty: 1 });
    expect(ownOrgOtherItem.status).toBe(404);
    expect((await otherWarehouse.client.get(`/api/v1/orgs/${otherWarehouse.orgId}/purchase-orders/${poId}`)).status).toBe(404);
    expect((await otherWarehouse.client.post(`/api/v1/orgs/${warehouse.orgId}/shipments/${shipmentId}/status`, { status: 'ARRIVED' })).status).toBe(404);
    const unchanged = await db.one<{ physicalQty: number }>('SELECT physical_qty FROM inventory_items WHERE id = $1', [pharmacyItemId]);
    expect(unchanged.physicalQty).toBe(103);
  });

  it('20. critical invariants hold: ledger reconciles, audit trail exists, notifications deduplicated', async () => {
    await drainJobs(app);
    const ledger = expectStatus(await admin.get('/api/v1/admin/ledger-check'), 200).body;
    expect(ledger).toMatchObject({ ok: true, negativeAvailable: 0, mismatches: [] });
    const actions = (await db.query<{ action: string }>('SELECT DISTINCT action FROM audit_logs')).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['ORG_VERIFIED', 'MEDICINE_CREATED', 'INVENTORY_STOCK_COUNT', 'PO_CREATED', 'PO_CONFIRMED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_RECEIVED']));
    const dupes = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT user_id, dedupe_key FROM notifications WHERE dedupe_key IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1) x`);
    expect(dupes.n).toBe(0);
  });
});
