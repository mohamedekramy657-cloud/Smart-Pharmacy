/** Section 21 search scenarios, executed against PostGIS through the public HTTP API. */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Database } from '../../src/database/db';
import { signWebhook } from '../../src/modules/integrations/integrations.service';
import { addStock, Client, createAdmin, createMedicine, createTestApp, createVerifiedOrg, expectStatus, north, ORIGIN, registerOrg, search, truncateAll } from '../helpers';

describe('Patient finder: progressive radius search and availability rules', () => {
  let app: INestApplication;
  let db: Database;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let admin: Client;
  const at = { lat: ORIGIN.lat, lng: ORIGIN.lng };

  beforeAll(async () => {
    ({ app, db, server } = await createTestApp());
    await truncateAll(db);
    admin = await createAdmin(db, server);
  });
  afterAll(async () => { await app.close(); });

  const ids = (body: { results: Array<{ pharmacy: { id: string } }> }) => body.results.map((r) => r.pharmacy.id);

  it('finds stock within 5 km and does not show farther bands', async () => {
    const med = await createMedicine(admin);
    const near = await createVerifiedOrg(server, admin, 'PHARMACY', north(2));
    const far = await createVerifiedOrg(server, admin, 'PHARMACY', north(8));
    await addStock(near, med.id, 10);
    await addStock(far, med.id, 10);
    const r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(r).toMatchObject({ outcome: 'FOUND', matchedRadiusKm: 5, searchedRadiusKm: 5 });
    expect(ids(r)).toEqual([near.orgId]);
    const expanded = expectStatus(await search(server, { medicineId: med.id, ...at, expandToMax: true }), 200).body;
    expect(ids(expanded)).toEqual([near.orgId, far.orgId]);
  });

  it('expands to 10 km, then continues through 20 km and 40 km bands', async () => {
    const med = await createMedicine(admin);
    const p8 = await createVerifiedOrg(server, admin, 'PHARMACY', north(8));
    await addStock(p8, med.id, 5);
    expect(expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body).toMatchObject({ outcome: 'FOUND', matchedRadiusKm: 10 });

    const med2 = await createMedicine(admin);
    const p15 = await createVerifiedOrg(server, admin, 'PHARMACY', north(15));
    await addStock(p15, med2.id, 5);
    expect(expectStatus(await search(server, { medicineId: med2.id, ...at }), 200).body).toMatchObject({ outcome: 'FOUND', matchedRadiusKm: 20 });

    const med3 = await createMedicine(admin);
    const p35 = await createVerifiedOrg(server, admin, 'PHARMACY', north(35));
    await addStock(p35, med3.id, 5);
    const r = expectStatus(await search(server, { medicineId: med3.id, ...at }), 200).body;
    expect(r).toMatchObject({ outcome: 'FOUND', matchedRadiusKm: 40 });
    expect(r.results[0].distanceKm).toBeCloseTo(35, 0);
  });

  it('reports no matching stock beyond the maximum radius, with coverage info', async () => {
    const med = await createMedicine(admin);
    const p60 = await createVerifiedOrg(server, admin, 'PHARMACY', north(60));
    await addStock(p60, med.id, 50);
    const r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(r).toMatchObject({ outcome: 'NO_MATCHING_STOCK', matchedRadiusKm: null, searchedRadiusKm: 40, results: [] });
    expect(r.coverage.verifiedPharmaciesWithinMaxRadius).toBeGreaterThan(0);
  });

  it('separates stale listings and reports data unavailable when only stale data exists', async () => {
    const med = await createMedicine(admin);
    const p = await createVerifiedOrg(server, admin, 'PHARMACY', north(3));
    const item = await addStock(p, med.id, 20);
    await db.exec(`UPDATE inventory_items SET last_updated_at = now() - interval '5 days' WHERE id = $1`, [item.id]);
    const r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(r.outcome).toBe('INVENTORY_DATA_UNAVAILABLE');
    expect(r.results).toHaveLength(0);
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0].availability).toMatchObject({ status: 'STALE', freshness: 'STALE' });
  });

  it('does not show warehouse-only stock or unverified pharmacies to patients', async () => {
    const med = await createMedicine(admin);
    const wh = await createVerifiedOrg(server, admin, 'WAREHOUSE', north(1));
    await addStock(wh, med.id, 1000);
    expect(expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body.outcome).toBe('NO_MATCHING_STOCK');
    const pending = await registerOrg(server, 'PHARMACY', north(1));
    await addStock(pending, med.id, 10);
    const r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(r.outcome).toBe('NO_VERIFIED_STOCK');
    expect(r.results).toHaveLength(0);
  });

  it('excludes a pharmacy immediately when an admin suspends it', async () => {
    const med = await createMedicine(admin);
    const p = await createVerifiedOrg(server, admin, 'PHARMACY', north(2));
    await addStock(p, med.id, 10);
    expect(ids(expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body)).toEqual([p.orgId]);
    expectStatus(await admin.post(`/api/v1/admin/organizations/${p.orgId}/status`, { status: 'SUSPENDED', reason: 'license under review' }), 200);
    expect(expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body.results).toHaveLength(0);
    const write = await p.client.post(`/api/v1/orgs/${p.orgId}/inventory`, { medicineId: (await createMedicine(admin)).id, openingQty: 1 });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('ORG_SUSPENDED');
    expect((await p.client.get(`/api/v1/orgs/${p.orgId}/inventory`)).status).toBe(200); // read-only access remains
  });

  it('treats recalled products as unavailable and controlled medicines as not publicly listed', async () => {
    const med = await createMedicine(admin);
    const p = await createVerifiedOrg(server, admin, 'PHARMACY', north(2));
    await addStock(p, med.id, 10);
    expectStatus(await admin.post(`/api/v1/admin/medicines/${med.id}/status`, { status: 'RECALLED', reason: 'Manufacturer recall (test)' }), 201);
    const r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(r).toMatchObject({ outcome: 'PRODUCT_UNAVAILABLE', productStatus: 'RECALLED', results: [] });
    const add = await p.client.post(`/api/v1/orgs/${p.orgId}/inventory`, { medicineId: med.id, openingQty: 1 });
    expect([409, 422]).toContain(add.status);

    const controlled = await createMedicine(admin, { prescriptionClass: 'CONTROLLED' });
    await addStock(p, controlled.id, 5);
    expect(expectStatus(await search(server, { medicineId: controlled.id, ...at }), 200).body.outcome).toBe('NOT_PUBLICLY_LISTED');
  });

  it('keeps similar names with different strengths as distinct products', async () => {
    const a = await createMedicine(admin, { brandNameEn: 'Augmentin', brandNameAr: 'أوجمنتين', genericNameEn: 'Amoxicillin + Clavulanic acid', strength: '625 mg', dosageForm: 'FILM_COATED_TABLET', packageSize: 14,
      ingredients: [{ nameEn: 'Amoxicillin', strengthValue: 500, strengthUnit: 'MG' }, { nameEn: 'Clavulanic acid', strengthValue: 125, strengthUnit: 'MG' }] });
    const b = await createMedicine(admin, { brandNameEn: 'Augmentin', brandNameAr: 'أوجمنتين', genericNameEn: 'Amoxicillin + Clavulanic acid', strength: '1 g', dosageForm: 'FILM_COATED_TABLET', packageSize: 14,
      ingredients: [{ nameEn: 'Amoxicillin', strengthValue: 875, strengthUnit: 'MG' }, { nameEn: 'Clavulanic acid', strengthValue: 125, strengthUnit: 'MG' }] });
    const p = await createVerifiedOrg(server, admin, 'PHARMACY', north(2));
    await addStock(p, b.id, 10);
    for (const q of ['augmentin', 'اوجمنتين', 'agmentin']) {
      const found = expectStatus(await request(server).get(`/api/v1/catalog/medicines?q=${encodeURIComponent(q)}`), 200).body as Array<{ id: string; strength: string }>;
      expect(found.map((m) => m.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    }
    expect(expectStatus(await search(server, { medicineId: a.id, ...at }), 200).body.outcome).toBe('NO_MATCHING_STOCK'); // never substituted
    expect(expectStatus(await search(server, { medicineId: b.id, ...at }), 200).body.outcome).toBe('FOUND');
  });

  it('works without precise location (geolocation denied): city/district centroid search', async () => {
    const city = await db.one<{ id: number }>(`INSERT INTO cities (governorate_en, governorate_ar, name_en, name_ar, centroid) VALUES ('Ismailia','الإسماعيلية','Ismailia (test)','الإسماعيلية', ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) RETURNING id`, [ORIGIN.lng, ORIGIN.lat]);
    const med = await createMedicine(admin);
    const p = await createVerifiedOrg(server, admin, 'PHARMACY', north(3));
    await addStock(p, med.id, 4);
    const r = expectStatus(await search(server, { medicineId: med.id, cityId: city.id }), 200).body;
    expect(r.origin.precision).toBe('CITY');
    expect(ids(r)).toEqual([p.orgId]);
    expect((await search(server, { medicineId: med.id })).status).toBe(400);
  });

  it('never ranks a closer unconfirmed listing above a farther confirmed one', async () => {
    const med = await createMedicine(admin);
    const close = await createVerifiedOrg(server, admin, 'PHARMACY', north(1));
    const farther = await createVerifiedOrg(server, admin, 'PHARMACY', north(4));
    const i1 = await addStock(close, med.id, 10);
    await addStock(farther, med.id, 10);
    await db.exec(`UPDATE inventory_items SET last_updated_at = now() - interval '20 hours' WHERE id = $1`, [i1.id]); // manual: >12 h, <72 h
    const r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(ids(r)).toEqual([farther.orgId, close.orgId]);
    expect(r.results[1].availability.status).toBe('RECENT_UNCONFIRMED');
  });

  it('shows integration-fed stock as unconfirmed once the integration is failing', async () => {
    const med = await createMedicine(admin);
    const p = await createVerifiedOrg(server, admin, 'PHARMACY', north(2));
    const integ = expectStatus(await p.client.post(`/api/v1/orgs/${p.orgId}/integrations`, { displayName: 'POS sync (test)', expectedIntervalMinutes: 15 }), 201).body;
    const payload = JSON.stringify({ eventId: 'evt-1', type: 'STOCK_SNAPSHOT', occurredAt: new Date().toISOString(), items: [{ medicineId: med.id, physicalQty: 12 }] });
    const ts = String(Math.floor(Date.now() / 1000));
    expectStatus(await request(server).post(integ.webhookPath).set('Content-Type', 'application/json').set('X-SP-Timestamp', ts).set('X-SP-Signature', signWebhook(integ.secret, ts, payload)).send(payload), 200);
    let r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(r.results[0].availability).toMatchObject({ freshness: 'CONFIRMED', source: 'INTEGRATION' });
    for (let i = 0; i < 3; i++) {
      expect((await request(server).post(integ.webhookPath).set('Content-Type', 'application/json').set('X-SP-Timestamp', ts).set('X-SP-Signature', 'bad').send(payload)).status).toBe(401);
    }
    r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(r.results[0].availability).toMatchObject({ status: 'RECENT_UNCONFIRMED', freshness: 'RECENT_UNCONFIRMED' });
  });

  it('follows admin-configured radius bands and validates them', async () => {
    const med = await createMedicine(admin);
    const p = await createVerifiedOrg(server, admin, 'PHARMACY', north(5.5));
    await addStock(p, med.id, 10);
    expect((await admin.put('/api/v1/admin/settings/finder.radiiKm', { value: [10, 5] })).status).toBe(400);
    expect((await admin.put('/api/v1/admin/settings/finder.radiiKm', { value: [3, 6] })).status).toBe(200);
    const r = expectStatus(await search(server, { medicineId: med.id, ...at }), 200).body;
    expect(r.radiiKm).toEqual([3, 6, 40]);
    expect(r.matchedRadiusKm).toBe(6);
    expectStatus(await admin.put('/api/v1/admin/settings/finder.radiiKm', { value: [5, 10, 20, 40] }), 200);
  });

  it('handles malicious and malformed input safely', async () => {
    const inj = await request(server).get(`/api/v1/catalog/medicines?q=${encodeURIComponent("x'; DROP TABLE medicines; --")}`);
    expect(inj.status).toBe(200);
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM medicines')).n).toBeGreaterThan(0);
    expect((await request(server).get('/api/v1/finder/search?medicineId=not-a-uuid&lat=30&lng=32')).status).toBe(400);
    expect((await request(server).get(`/api/v1/finder/search?medicineId=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}&lat=999&lng=32`)).status).toBe(400);
    expect((await request(server).get('/api/v1/finder/search?medicineId=00000000-0000-4000-8000-000000000000&lat=30.5&lng=32.2')).status).toBe(404);
    const xss = await createMedicine(admin, { brandNameEn: '<script>alert(1)</script>Med' });
    const got = expectStatus(await request(server).get(`/api/v1/catalog/medicines/${xss.id}`), 200);
    expect(got.headers['content-type']).toMatch(/application\/json/);
    expect(got.body.brandNameEn).toBe('<script>alert(1)</script>Med'); // stored as data, rendered escaped by the UI
  });
});
