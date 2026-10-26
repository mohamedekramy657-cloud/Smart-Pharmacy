/** Authentication/authorization hardening, notification dedupe, job retries and alerts. */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { resetConfigForTests } from '../../src/config/config';
import { Database } from '../../src/database/db';
import { totp } from '../../src/modules/auth/totp';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { RequestsService } from '../../src/modules/patient/requests.service';
import { addStock, Client, createAdmin, createMedicine, createTestApp, createVerifiedOrg, drainJobs, expectStatus, north, ORIGIN, OrgHandle, PASSWORD, registerPatient, truncateAll } from '../helpers';

describe('Security hardening', () => {
  let app: INestApplication;
  let db: Database;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let admin: Client;
  let ph: OrgHandle;
  let wh: OrgHandle;

  beforeAll(async () => {
    ({ app, db, server } = await createTestApp());
    await truncateAll(db);
    admin = await createAdmin(db, server);
    ph = await createVerifiedOrg(server, admin, 'PHARMACY', north(2));
    wh = await createVerifiedOrg(server, admin, 'WAREHOUSE', north(3));
  });
  afterAll(async () => { await app.close(); });

  it('sets hardened session cookies and requires CSRF tokens for state changes', async () => {
    const c = new Client(server);
    const res = await c.login(ph.email);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]);
    expect(cookies.find((x) => x.startsWith('sp_session='))).toMatch(/HttpOnly/i);
    expect(cookies.find((x) => x.startsWith('sp_session='))).toMatch(/SameSite=Lax/i);
    const noCsrf = await c.agent.post(`/api/v1/orgs/${ph.orgId}/inventory`).send({ medicineId: '00000000-0000-4000-8000-000000000000' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
    const formPost = await c.agent.post('/api/v1/auth/logout').set('Content-Type', 'application/x-www-form-urlencoded').send('a=b');
    expect(formPost.status).toBe(415);
  });

  it('revokes the session on logout', async () => {
    const c = new Client(server);
    await c.login(ph.email);
    expectStatus(await c.post('/api/v1/auth/logout'), 200);
    expect((await c.get(`/api/v1/orgs/${ph.orgId}`)).status).toBe(401);
  });

  it('uses identical errors for unknown accounts and wrong passwords, and locks after 5 failures', async () => {
    const patient = await registerPatient(server, 'lockme@test.local');
    expect(patient.userId).toBeTruthy();
    const unknown = await new Client(server).login('nobody@test.local', 'whatever123');
    const wrong = await new Client(server).login('lockme@test.local', 'wrong-password-1');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    for (let i = 0; i < 4; i++) await new Client(server).login('lockme@test.local', 'wrong-password-1');
    const locked = await new Client(server).login('lockme@test.local', PASSWORD);
    expect(locked.status).toBe(401);
    const events = await db.query<{ type: string }>(`SELECT type FROM security_events WHERE type IN ('ACCOUNT_LOCKED','LOGIN_BLOCKED_LOCKED')`);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['ACCOUNT_LOCKED', 'LOGIN_BLOCKED_LOCKED']));
  });

  it('rate-limits authentication endpoints', async () => {
    process.env.AUTH_RATE_LIMIT_PER_MINUTE = '3';
    resetConfigForTests();
    try {
      const statuses: number[] = [];
      // Distinct client IP (trusted proxy hop) so the temporary block does not affect other tests.
      for (let i = 0; i < 5; i++) statuses.push((await request(server).post('/api/v1/auth/register').set('X-Forwarded-For', '203.0.113.77').send({})).status);
      expect(statuses).toContain(429);
    } finally {
      process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100000';
      resetConfigForTests();
    }
  });

  it('enforces strict input validation and payload limits', async () => {
    const unknownField = await ph.client.post(`/api/v1/orgs/${ph.orgId}/inventory`, { medicineId: '00000000-0000-4000-8000-000000000000', openingQty: 1, isAdmin: true });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error.code).toBe('VALIDATION_FAILED');
    const negative = await ph.client.post(`/api/v1/orgs/${ph.orgId}/inventory`, { medicineId: '00000000-0000-4000-8000-000000000000', openingQty: -5 });
    expect(negative.status).toBe(400);
    const huge = await ph.client.post(`/api/v1/orgs/${ph.orgId}/inventory/imports`, { mode: 'validate', csv: 'x'.repeat(1_100_000) });
    expect(huge.status).toBe(413);
  });

  it('enforces organization type, membership and object ownership', async () => {
    expect((await wh.client.post(`/api/v1/orgs/${wh.orgId}/purchase-orders`, { warehouseOrgId: wh.orgId, items: [{ medicineId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] })).status).toBe(403);
    expect((await ph.client.get(`/api/v1/orgs/${wh.orgId}/purchase-orders`)).status).toBe(404);
    const p1 = await registerPatient(server, 'owner-a@test.local');
    const p2 = await registerPatient(server, 'owner-b@test.local');
    const med = await createMedicine(admin);
    await addStock(ph, med.id, 3);
    const req = expectStatus(await p1.post('/api/v1/me/requests', { pharmacyOrgId: ph.orgId, medicineId: med.id, quantity: 1 }), 201).body;
    expect((await p2.get(`/api/v1/me/requests/${req.id}`)).status).toBe(404);
    expect((await p2.post(`/api/v1/me/requests/${req.id}/cancel`)).status).toBe(404);
    const denied = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM security_events WHERE type = 'ORG_ACCESS_DENIED'`);
    expect(denied.n).toBeGreaterThan(0);
  });

  it('requires MFA for administrators when configured, using TOTP', async () => {
    process.env.ADMIN_MFA_REQUIRED = 'true';
    resetConfigForTests();
    try {
      const blocked = await admin.get('/api/v1/admin/overview');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('MFA_REQUIRED');
      const setup = expectStatus(await admin.post('/api/v1/auth/mfa/setup'), 200).body;
      expectStatus(await admin.post('/api/v1/auth/mfa/enable', { code: totp(setup.secret) }), 200);
      expectStatus(await admin.get('/api/v1/admin/overview'), 200);
      const fresh = new Client(server);
      const noCode = await fresh.login('admin@test.local');
      expect(noCode.status).toBe(401);
      expect(noCode.body.error.code).toBe('MFA_REQUIRED');
      const withCode = await fresh.agent.post('/api/v1/auth/login').send({ email: 'admin@test.local', password: PASSWORD, totpCode: totp(setup.secret) });
      expect(withCode.status).toBe(200);
    } finally {
      process.env.ADMIN_MFA_REQUIRED = 'false';
      resetConfigForTests();
    }
  });

  it('revokes other sessions after a password change', async () => {
    const p = await registerPatient(server, 'pwchange@test.local');
    const other = new Client(server);
    await other.login('pwchange@test.local');
    expectStatus(await p.post('/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'AnotherPassw0rd!99' }), 200);
    expect((await other.get('/api/v1/me/notifications')).status).toBe(401);
    expect((await p.get('/api/v1/me/notifications')).status).toBe(200);
  });
});

describe('Notifications, jobs, requests and alerts', () => {
  let app: INestApplication;
  let db: Database;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let admin: Client;
  let ph: OrgHandle;

  beforeAll(async () => {
    ({ app, db, server } = await createTestApp());
    await truncateAll(db);
    admin = await createAdmin(db, server);
    ph = await createVerifiedOrg(server, admin, 'PHARMACY', north(2));
  });
  afterAll(async () => { await app.close(); });

  it('deduplicates notifications by key', async () => {
    const svc = app.get(NotificationsService);
    const first = await db.tx((tx) => svc.toUser(tx, ph.userId, { type: 'LOW_STOCK', data: { medicine: 'X', available: 1, threshold: 2 }, dedupeKey: 'dedupe-test' }));
    const second = await db.tx((tx) => svc.toUser(tx, ph.userId, { type: 'LOW_STOCK', data: { medicine: 'X', available: 1, threshold: 2 }, dedupeKey: 'dedupe-test' }));
    expect([first, second]).toEqual([true, false]);
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = 'dedupe-test'`)).n).toBe(1);
  });

  it('retries failed jobs with backoff and dead-letters after max attempts', async () => {
    const jobs = app.get(JobsService);
    let calls = 0;
    jobs.register('test.flaky', async () => { calls++; if (calls < 3) throw new Error(`transient failure ${calls}`); });
    jobs.register('test.broken', async () => { throw new Error('permanent failure'); });
    await db.tx(async (tx) => {
      await jobs.enqueue(tx, 'test.flaky', {});
      await jobs.enqueue(tx, 'test.broken', {}, { maxAttempts: 2 });
    });
    for (let i = 0; i < 4; i++) {
      await jobs.drain();
      await db.exec(`UPDATE jobs SET run_at = now() WHERE status = 'FAILED'`); // fast-forward backoff
    }
    const rows = await db.query<{ type: string; status: string; attempts: number; lastError: string | null }>(`SELECT type, status, attempts, last_error FROM jobs WHERE type LIKE 'test.%' ORDER BY type`);
    expect(rows).toEqual([
      expect.objectContaining({ type: 'test.broken', status: 'DEAD', attempts: 2, lastError: 'permanent failure' }),
      expect.objectContaining({ type: 'test.flaky', status: 'SUCCEEDED', attempts: 3 }),
    ]);
    const dead = expectStatus(await admin.get('/api/v1/admin/jobs'), 200).body.dead;
    expectStatus(await admin.post(`/api/v1/admin/jobs/${dead[0].id}/retry`), 200);
    expect((await db.one<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [dead[0].id])).status).toBe('PENDING');
  });

  it('never reports dev-log email as delivered', async () => {
    const p = await registerPatient(server, 'email-pref@test.local');
    expectStatus(await p.patch('/api/v1/me/preferences', { emailEnabled: true }), 200);
    await db.tx((tx) => app.get(NotificationsService).toUser(tx, p.userId, { type: 'REQUEST_EXPIRED', data: { code: 'RQ-1', medicine: 'X' }, channels: ['EMAIL'], dedupeKey: 'email-1' }));
    await drainJobs(app);
    const d = await db.one<{ status: string; provider: string; lastError: string }>(`SELECT d.status, d.provider, d.last_error FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.user_id = $1`, [p.userId]);
    expect(d).toMatchObject({ status: 'SKIPPED', provider: 'dev-log' });
    expect(d.lastError).toMatch(/not delivered/);
  });

  it('sends a low-stock notification when available stock crosses the threshold', async () => {
    const med = await createMedicine(admin);
    const item = await addStock(ph, med.id, 10, { lowStockThreshold: 3 });
    expectStatus(await ph.client.post(`/api/v1/orgs/${ph.orgId}/inventory/${item.id}/adjustments`, { type: 'SALE', qty: 8 }), 201);
    await drainJobs(app);
    const n = await db.query<{ type: string; body: string }>(`SELECT type, body FROM notifications WHERE user_id = $1 AND type = 'LOW_STOCK' AND data->>'itemId' = $2`, [ph.userId, item.id]);
    expect(n).toHaveLength(1);
    expect(n[0].body).toMatch(/2 available/);
  });

  it('notifies patients with matching availability alerts when stock returns (once per day)', async () => {
    const med = await createMedicine(admin);
    const item = await addStock(ph, med.id, 0);
    const patient = await registerPatient(server, 'alert-me@test.local');
    const alert = expectStatus(await patient.post('/api/v1/me/alerts', { medicineId: med.id, lat: ORIGIN.lat, lng: ORIGIN.lng, radiusKm: 5 }), 201).body;
    expect(alert.status).toBe('ACTIVE');
    expectStatus(await ph.client.post(`/api/v1/orgs/${ph.orgId}/inventory/${item.id}/adjustments`, { type: 'RECEIVE_EXTERNAL', qty: 6 }), 201);
    await db.exec(`UPDATE jobs SET run_at = now() WHERE type = 'alerts.match'`);
    await drainJobs(app);
    const notes = expectStatus(await patient.get('/api/v1/me/notifications'), 200).body as Array<{ type: string; body: string }>;
    expect(notes.filter((x) => x.type === 'AVAILABILITY_ALERT')).toHaveLength(1);
    expect(notes[0].body).toMatch(/Call to confirm/);
    const alerts = expectStatus(await patient.get('/api/v1/me/alerts'), 200).body;
    expect(alerts[0].status).toBe('TRIGGERED');
  });

  it('runs the confirmation request lifecycle including expiry', async () => {
    const med = await createMedicine(admin);
    await addStock(ph, med.id, 5);
    const patient = await registerPatient(server, 'req-life@test.local');
    const r1 = expectStatus(await patient.post('/api/v1/me/requests', { pharmacyOrgId: ph.orgId, medicineId: med.id, quantity: 2 }), 201).body;
    expect((await patient.post('/api/v1/me/requests', { pharmacyOrgId: ph.orgId, medicineId: med.id, quantity: 2 })).status).toBe(409); // duplicate pending
    const resp = expectStatus(await ph.client.post(`/api/v1/orgs/${ph.orgId}/confirmation-requests/${r1.id}/respond`, { outcome: 'CONFIRMED_AVAILABLE' }), 200).body;
    expect(resp.status).toBe('CONFIRMED_AVAILABLE');
    expect((await ph.client.post(`/api/v1/orgs/${ph.orgId}/confirmation-requests/${r1.id}/respond`, { outcome: 'NOT_AVAILABLE' })).status).toBe(409);
    const notes = expectStatus(await patient.get('/api/v1/me/notifications'), 200).body as Array<{ type: string; body: string }>;
    expect(notes[0]).toMatchObject({ type: 'CONFIRMATION_RESPONSE' });
    expect(notes[0].body).toMatch(/can change/);

    const med2 = await createMedicine(admin);
    const r2 = expectStatus(await patient.post('/api/v1/me/requests', { pharmacyOrgId: ph.orgId, medicineId: med2.id, quantity: 1 }), 201).body;
    await db.exec(`UPDATE stock_confirmation_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r2.id]);
    expect((await app.get(RequestsService).expireDue()).requests).toBe(1);
    expect(expectStatus(await patient.get(`/api/v1/me/requests/${r2.id}`), 200).body.status).toBe('EXPIRED');
  });
});
