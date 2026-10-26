import { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import request from 'supertest';
import { Database } from '../src/database/db';
import { resetSettingsToDefaults } from '../src/database/default-settings';
import { createApp } from '../src/main';
import { JobsService } from '../src/modules/jobs/jobs.service';

export const PASSWORD = 'TestPassw0rd!2026';
/** Ismailia city centre (reference point for distance scenarios; test data only). */
export const ORIGIN = { lat: 30.5965, lng: 32.2715 };

/** Point at ~distanceKm north of the origin (1 deg latitude ~= 111.2 km). */
export const north = (km: number) => ({ lat: ORIGIN.lat + km / 111.2, lng: ORIGIN.lng });

export async function createTestApp(): Promise<{ app: INestApplication; db: Database; server: ReturnType<INestApplication['getHttpServer']> }> {
  const app = await createApp({ logger: false });
  await app.init();
  return { app, db: app.get(Database), server: app.getHttpServer() };
}

export async function truncateAll(db: Database): Promise<void> {
  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'system_settings', 'spatial_ref_sys')`);
  await db.exec(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await resetSettingsToDefaults(db);
}

/** Cookie + CSRF aware HTTP client acting as one browser session. */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  csrf = '';
  userId = '';
  constructor(server: Parameters<typeof request.agent>[0]) {
    this.agent = request.agent(server);
  }
  private capture(res: request.Response) {
    const cookies = ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []);
    const c = cookies.find((x) => x.startsWith('sp_csrf='));
    if (c) this.csrf = decodeURIComponent(c.split(';')[0].split('=')[1]);
    return res;
  }
  async login(email: string, password = PASSWORD) {
    const res = await this.agent.post('/api/v1/auth/login').send({ email, password });
    if (res.status === 200) this.userId = res.body.user.id;
    return this.capture(res);
  }
  get(url: string) { return this.agent.get(url); }
  async post(url: string, body: unknown = {}, headers: Record<string, string> = {}) {
    return this.capture(await this.agent.post(url).set('X-CSRF-Token', this.csrf).set(headers).send(body as object));
  }
  async patch(url: string, body: unknown = {}) { return this.capture(await this.agent.patch(url).set('X-CSRF-Token', this.csrf).send(body as object)); }
  async put(url: string, body: unknown = {}) { return this.capture(await this.agent.put(url).set('X-CSRF-Token', this.csrf).send(body as object)); }
  async del(url: string) { return this.capture(await this.agent.delete(url).set('X-CSRF-Token', this.csrf).send({})); }
}

export function expectStatus(res: request.Response, status: number): request.Response {
  if (res.status !== status) {
    throw new Error(`Expected HTTP ${status} but got ${res.status} for ${res.req?.method} ${res.req?.path}: ${JSON.stringify(res.body)}`);
  }
  return res;
}

export async function createAdmin(db: Database, server: Parameters<typeof request.agent>[0], email = 'admin@test.local'): Promise<Client> {
  await db.exec(`INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1,$2,'Test Admin','SUPER_ADMIN') ON CONFLICT (email) DO NOTHING`,
    [email, await argon2.hash(PASSWORD, { type: argon2.argon2id })]);
  const c = new Client(server);
  expectStatus(await c.login(email), 200);
  return c;
}

export async function registerPatient(server: Parameters<typeof request.agent>[0], email: string): Promise<Client> {
  const c = new Client(server);
  const res = await c.post('/api/v1/auth/register', { email, password: PASSWORD, fullName: 'Test Patient', preferredLocale: 'en' });
  expectStatus(res, 201);
  c.userId = res.body.userId;
  return c;
}

let counter = 0;
export interface OrgHandle { client: Client; orgId: string; userId: string; email: string }

/** Registers an organization through the public onboarding API (status PENDING). */
export async function registerOrg(server: Parameters<typeof request.agent>[0], type: 'PHARMACY' | 'WAREHOUSE', at: { lat: number; lng: number }, name?: string): Promise<OrgHandle> {
  counter++;
  const email = `${type.toLowerCase()}${counter}-${Date.now()}@test.local`;
  const c = new Client(server);
  const res = await c.post('/api/v1/auth/register-organization', {
    account: { email, password: PASSWORD, fullName: `${type} Owner ${counter}`, preferredLocale: 'en' },
    organization: { type, nameEn: name ?? `[TEST] ${type} ${counter}`, licenseNumber: `LIC-${counter}-${Date.now()}`, addressLine: `Test street ${counter}, Ismailia`, lat: at.lat, lng: at.lng, phone: '+20 64 000 0000' },
  });
  expectStatus(res, 201);
  await c.login(email); // refresh session memberships
  return { client: c, orgId: res.body.organizationId, userId: res.body.userId, email };
}

export async function verifyOrg(admin: Client, orgId: string): Promise<void> {
  expectStatus(await admin.post(`/api/v1/admin/organizations/${orgId}/verification`, { decision: 'VERIFIED', notes: 'license checked (test)' }), 200);
}

export async function createVerifiedOrg(server: Parameters<typeof request.agent>[0], admin: Client, type: 'PHARMACY' | 'WAREHOUSE', at: { lat: number; lng: number }, name?: string): Promise<OrgHandle> {
  const org = await registerOrg(server, type, at, name);
  await verifyOrg(admin, org.orgId);
  return org;
}

let medCounter = 0;
export async function createMedicine(admin: Client, overrides: Record<string, unknown> = {}): Promise<{ id: string; [k: string]: unknown }> {
  medCounter++;
  const res = await admin.post('/api/v1/admin/medicines', {
    brandNameEn: `Testamol ${medCounter}`, genericNameEn: 'Paracetamol', strength: '500 mg', dosageForm: 'TABLET', route: 'ORAL',
    packageSize: 20, packageUnit: 'TABLET', manufacturer: 'Test Pharma (TEST)', prescriptionClass: 'OTC',
    ingredients: [{ nameEn: 'Paracetamol', strengthValue: 500, strengthUnit: 'MG' }], confirmDistinct: true, ...overrides,
  });
  expectStatus(res, 201);
  return res.body;
}

export async function addStock(org: OrgHandle, medicineId: string, qty: number, extra: Record<string, unknown> = {}): Promise<{ id: string; [k: string]: unknown }> {
  const res = await org.client.post(`/api/v1/orgs/${org.orgId}/inventory`, { medicineId, openingQty: qty, ...extra });
  expectStatus(res, 201);
  return res.body;
}

export async function drainJobs(app: INestApplication): Promise<number> {
  const jobs = app.get(JobsService);
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const n = await jobs.drain(50);
    total += n;
    if (n === 0) break;
  }
  return total;
}

export function search(server: Parameters<typeof request.agent>[0], params: Record<string, string | number | boolean>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  return request(server).get(`/api/v1/finder/search?${qs}`);
}
