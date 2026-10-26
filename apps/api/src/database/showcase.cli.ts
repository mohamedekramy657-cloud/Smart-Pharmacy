/**
 * SHOWCASE DEMO DATA — development only. Layers a richer, clearly-labelled demo dataset on top of
 * the base dev seed (for demos, screenshots and the pitch deck):
 *   - 13 more catalog products (DEV_SEED: illustrative descriptors, NOT verified against the EDA registry)
 *   - 16 more "[DEMO]" pharmacies across Ismailia districts and nearby towns (approximate locations)
 *   - purchase orders in every state, shipments in transit / delayed / delivered with discrepancies
 *   - patient confirmation requests, a pharmacist hold, availability alerts, a signed integration feed
 *   - simulated patient searches run through the real finder (populates search analytics)
 * Every change goes through the real services (stock ledger, workflows, notifications, audit).
 *
 * Guards: refuses in production, requires ALLOW_DEMO_SEED=true, requires the base demo seed and
 * refuses if the database contains any non-demo organization. Safe to re-run (skips if present).
 */
import { NestFactory } from '@nestjs/core';
import * as argon2 from 'argon2';
import { AppModule } from '../app.module';
import { OrgContext } from '../common/auth/decorators';
import { requestContext } from '../common/request-context';
import { config } from '../config/config';
import { AdminService } from '../modules/admin/admin.service';
import { AuthService } from '../modules/auth/auth.service';
import { CatalogService, MedicineInput } from '../modules/catalog/catalog.service';
import { FinderSearchSchema, FinderService } from '../modules/finder/finder.service';
import { IntegrationsService, signWebhook } from '../modules/integrations/integrations.service';
import { InventoryService } from '../modules/inventory/inventory.service';
import { OrganizationsService } from '../modules/organizations/organizations.service';
import { AlertsService } from '../modules/patient/alerts.service';
import { RequestsService } from '../modules/patient/requests.service';
import { PurchaseOrdersService } from '../modules/supply/purchase-orders.service';
import { RelationshipsService } from '../modules/supply/relationships.service';
import { ShipmentsService } from '../modules/supply/shipments.service';
import { Database } from './db';

const PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPass#2026';
const MARKER_LICENSE = 'DEMO-SC-01';

/** Deterministic PRNG so the showcase dataset is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261026);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const between = (a: number, b: number) => Math.floor(a + rnd() * (b - a + 1));

const ing = (nameEn: string, nameAr: string, strengthValue: number, strengthUnit: MedicineInput['ingredients'][number]['strengthUnit'] = 'MG') => ({ nameEn, nameAr, strengthValue, strengthUnit });
const NEW_MEDICINES: Array<Omit<MedicineInput, 'confirmDistinct'>> = [
  { brandNameEn: 'Nexium', brandNameAr: 'نكسيوم', genericNameEn: 'Esomeprazole', strength: '40 mg', dosageForm: 'TABLET', route: 'ORAL', packageSize: 14, packageUnit: 'TABLET', manufacturer: 'AstraZeneca', category: 'Gastro', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Esomeprazole', 'إيزوميبرازول', 40)] },
  { brandNameEn: 'Lipitor', brandNameAr: 'ليبيتور', genericNameEn: 'Atorvastatin', strength: '20 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 30, packageUnit: 'TABLET', manufacturer: 'Pfizer', category: 'Cardiovascular', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Atorvastatin', 'أتورفاستاتين', 20)] },
  { brandNameEn: 'Amaryl', brandNameAr: 'أماريل', genericNameEn: 'Glimepiride', strength: '2 mg', dosageForm: 'TABLET', route: 'ORAL', packageSize: 30, packageUnit: 'TABLET', manufacturer: 'Sanofi', category: 'Antidiabetic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Glimepiride', 'جليميبرايد', 2)] },
  { brandNameEn: 'Antinal', brandNameAr: 'أنتينال', genericNameEn: 'Nifuroxazide', strength: '200 mg', dosageForm: 'CAPSULE', route: 'ORAL', packageSize: 24, packageUnit: 'CAPSULE', manufacturer: 'Amoun', category: 'Gastro', prescriptionClass: 'OTC', ingredients: [ing('Nifuroxazide', 'نيفوروكسازيد', 200)] },
  { brandNameEn: 'Congestal', brandNameAr: 'كونجستال', genericNameEn: 'Paracetamol + Pseudoephedrine + Chlorpheniramine', strength: '650 mg + 60 mg + 4 mg', dosageForm: 'TABLET', route: 'ORAL', packageSize: 20, packageUnit: 'TABLET', manufacturer: 'Sigma', category: 'Cold & flu', prescriptionClass: 'OTC', ingredients: [ing('Paracetamol', 'باراسيتامول', 650), ing('Pseudoephedrine', 'سودوإيفيدرين', 60), ing('Chlorpheniramine', 'كلورفينيرامين', 4)] },
  { brandNameEn: 'Zithromax', brandNameAr: 'زيثروماكس', genericNameEn: 'Azithromycin', strength: '500 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 3, packageUnit: 'TABLET', manufacturer: 'Pfizer', category: 'Antibiotic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Azithromycin', 'أزيثرومايسين', 500)] },
  { brandNameEn: 'Flagyl', brandNameAr: 'فلاجيل', genericNameEn: 'Metronidazole', strength: '500 mg', dosageForm: 'TABLET', route: 'ORAL', packageSize: 20, packageUnit: 'TABLET', manufacturer: 'Sanofi', category: 'Antibiotic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Metronidazole', 'ميترونيدازول', 500)] },
  { brandNameEn: 'Ciprofar', brandNameAr: 'سيبروفار', genericNameEn: 'Ciprofloxacin', strength: '500 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 10, packageUnit: 'TABLET', manufacturer: 'Pharco', category: 'Antibiotic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Ciprofloxacin', 'سيبروفلوكساسين', 500)] },
  { brandNameEn: 'Capoten', brandNameAr: 'كابوتين', genericNameEn: 'Captopril', strength: '25 mg', dosageForm: 'TABLET', route: 'ORAL', packageSize: 20, packageUnit: 'TABLET', manufacturer: 'Bristol-Myers Squibb', category: 'Cardiovascular', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Captopril', 'كابتوبريل', 25)] },
  { brandNameEn: 'Lasix', brandNameAr: 'لازكس', genericNameEn: 'Furosemide', strength: '40 mg', dosageForm: 'TABLET', route: 'ORAL', packageSize: 20, packageUnit: 'TABLET', manufacturer: 'Sanofi', category: 'Cardiovascular', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Furosemide', 'فوروسيميد', 40)] },
  { brandNameEn: 'Concor', brandNameAr: 'كونكور', genericNameEn: 'Bisoprolol fumarate', strength: '2.5 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 30, packageUnit: 'TABLET', manufacturer: 'Merck', category: 'Cardiovascular', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Bisoprolol fumarate', 'بيسوبرولول', 2.5)] },
  { brandNameEn: 'Glucophage', brandNameAr: 'جلوكوفاج', genericNameEn: 'Metformin hydrochloride', strength: '1000 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 30, packageUnit: 'TABLET', manufacturer: 'Merck', category: 'Antidiabetic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Metformin hydrochloride', 'ميتفورمين', 1000)] },
  { brandNameEn: 'Mixtard 30', brandNameAr: 'ميكستارد 30', genericNameEn: 'Insulin human (30% soluble / 70% isophane)', strength: '100 IU/mL', dosageForm: 'INJECTION', route: 'SUBCUTANEOUS', packageSize: 1, packageUnit: 'VIAL', manufacturer: 'Novo Nordisk', category: 'Antidiabetic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Insulin human', 'إنسولين بشري', 100, 'IU')] },
];

// [key, nameEn, nameAr, city, district|null, lat, lng, is24h, acceptsHolds, delivery]
const NEW_PHARMACIES = [
  ['sc01', '[DEMO] Al-Salam Pharmacy', 'صيدلية السلام [تجريبي]', 'Ismailia', 'Sheikh Zayed', 30.6125, 32.2498, true, true, true],
  ['sc02', '[DEMO] Al-Nour Pharmacy', 'صيدلية النور [تجريبي]', 'Ismailia', 'Third District', 30.6190, 32.2668, false, true, false],
  ['sc03', '[DEMO] Al-Hayah Pharmacy', 'صيدلية الحياة [تجريبي]', 'Ismailia', 'Nemra 6', 30.6302, 32.2805, true, false, true],
  ['sc04', '[DEMO] Al-Rahma Pharmacy', 'صيدلية الرحمة [تجريبي]', 'Ismailia', 'Second District', 30.6041, 32.2918, false, true, false],
  ['sc05', '[DEMO] Al-Amal Pharmacy', 'صيدلية الأمل [تجريبي]', 'Ismailia', 'First District', 30.5931, 32.2779, false, false, true],
  ['sc06', '[DEMO] Misr Pharmacy', 'صيدلية مصر [تجريبي]', 'Ismailia', 'First District', 30.6002, 32.2705, true, true, false],
  ['sc07', '[DEMO] Al-Shorouk Pharmacy', 'صيدلية الشروق [تجريبي]', 'Ismailia', 'Sheikh Zayed', 30.6083, 32.2586, false, false, false],
  ['sc08', '[DEMO] Al-Hekma Pharmacy', 'صيدلية الحكمة [تجريبي]', 'Ismailia', 'Third District', 30.6236, 32.2552, false, true, true],
  ['sc09', '[DEMO] Al-Fayrouz Pharmacy', 'صيدلية الفيروز [تجريبي]', 'Ismailia', 'Second District', 30.6158, 32.2799, false, false, true],
  ['sc10', '[DEMO] University Pharmacy', 'صيدلية الجامعة [تجريبي]', 'Ismailia', 'Third District', 30.6215, 32.2708, false, true, false],
  ['sc11', '[DEMO] Corniche Pharmacy', 'صيدلية الكورنيش [تجريبي]', 'Ismailia', 'First District', 30.5899, 32.2694, false, false, false],
  ['sc12', '[DEMO] Al-Mostakbal Pharmacy', 'صيدلية المستقبل [تجريبي]', 'Ismailia', null, 30.6440, 32.2390, false, false, true],
  ['sc13', '[DEMO] Abu Suwir Pharmacy', 'صيدلية أبو صوير [تجريبي]', 'Abu Suwir', null, 30.5552, 32.0838, false, false, false],
  ['sc14', '[DEMO] Al-Qassasin Pharmacy', 'صيدلية القصاصين [تجريبي]', 'Al-Qassasin', null, 30.5590, 31.9300, false, false, false],
  ['sc15', '[DEMO] Fayed Canal Pharmacy', 'صيدلية قناة فايد [تجريبي]', 'Fayed', null, 30.3330, 32.3050, false, false, false],
  ['sc16', '[DEMO] Qantara East Pharmacy', 'صيدلية القنطرة شرق [تجريبي]', 'Al Qantara Gharb', null, 30.8600, 32.3220, false, false, false],
] as const;

async function main(): Promise<void> {
  if (config().NODE_ENV === 'production') throw new Error('Refusing to load demo data in production');
  if (process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Set ALLOW_DEMO_SEED=true to load the demo showcase data (development only)');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const db = app.get(Database);
  try {
    if (await db.maybeOne('SELECT 1 FROM organizations WHERE NOT is_demo LIMIT 1')) throw new Error('Refusing: the database contains non-demo organizations');
    const admin = await db.maybeOne<{ id: string }>(`SELECT id FROM users WHERE email = 'admin@demo.local'`);
    if (!admin) throw new Error('Run the base demo seed first (db:seed)');
    if (await db.maybeOne('SELECT 1 FROM organizations WHERE license_number = $1', [MARKER_LICENSE])) {
      console.log('Showcase demo data already loaded.');
      return;
    }

    await requestContext.run({ requestId: 'demo-showcase', userId: admin.id }, async () => {
      const catalog = app.get(CatalogService);
      for (const m of NEW_MEDICINES) await catalog.create({ ...m, confirmDistinct: true }, { dataSource: 'DEV_SEED' });
      const meds = new Map((await db.query<{ id: string; brandNameEn: string; strength: string }>('SELECT id, brand_name_en, strength FROM medicines')).map((m) => [`${m.brandNameEn}|${m.strength}`, m.id]));
      const med = (k: string) => { const id = meds.get(k); if (!id) throw new Error(`missing medicine ${k}`); return id; };

      // Reference areas for the new towns (approximate centroids, dev data).
      for (const [en, ar, lat, lng] of [['Abu Suwir', 'أبو صوير', 30.5552, 32.0838], ['Al-Qassasin', 'القصاصين', 30.5590, 31.9300]] as const) {
        await db.exec(`INSERT INTO cities (governorate_en, governorate_ar, name_en, name_ar, centroid) VALUES ('Ismailia','الإسماعيلية',$1,$2, ST_SetSRID(ST_MakePoint($4,$3),4326)::geography)`, [en, ar, lat, lng]);
      }
      const cities = new Map((await db.query<{ id: number; nameEn: string }>('SELECT id, name_en FROM cities')).map((c) => [c.nameEn, c.id]));
      const districts = new Map((await db.query<{ id: number; nameEn: string }>('SELECT id, name_en FROM districts')).map((d) => [d.nameEn, d.id]));

      // Existing demo organizations from the base seed.
      const existing = await db.query<{ id: string; type: 'PHARMACY' | 'WAREHOUSE'; licenseNumber: string; ownerId: string }>(
        `SELECT o.id, o.type, o.license_number, m.user_id AS owner_id FROM organizations o
           JOIN organization_members m ON m.organization_id = o.id AND m.role = 'ORG_OWNER' WHERE o.is_demo`);
      const H: Record<string, { ctx: OrgContext; ownerId: string }> = {};
      for (const o of existing) H[o.licenseNumber.replace('DEMO-', '').toLowerCase()] = { ctx: { id: o.id, type: o.type, role: 'ORG_OWNER', verificationStatus: 'VERIFIED', status: 'ACTIVE' }, ownerId: o.ownerId };

      const auth = app.get(AuthService);
      const orgs = app.get(OrganizationsService);
      const adminSvc = app.get(AdminService);
      const inventory = app.get(InventoryService);

      for (const [key, nameEn, nameAr, city, district, lat, lng, is24h, acceptsHolds, delivery] of NEW_PHARMACIES) {
        const res = await db.tx(async (tx) => {
          const user = await auth.createUser(tx, { email: `${key}@demo.local`, password: PASSWORD, fullName: `${nameEn.replace('[DEMO] ', '')} Owner`, preferredLocale: 'ar' });
          const org = await orgs.create(tx, user.id, {
            type: 'PHARMACY', nameEn, nameAr, licenseNumber: `DEMO-${key.toUpperCase()}`, addressLine: `Demo address, ${district ?? city}`,
            cityId: cities.get(city), districtId: district ? districts.get(district) : undefined, lat, lng, phone: '+20 64 000 0000',
          }, true);
          return { userId: user.id, orgId: org.id };
        });
        await adminSvc.decideVerification(res.orgId, admin.id, { decision: 'VERIFIED', notes: 'Demo verification (showcase data)' });
        await orgs.update(res.orgId, { pharmacy: { is24h, acceptsHolds, deliveryAvailable: delivery } });
        if (!is24h) {
          const [open, close] = key === 'sc11' ? ['10:00', '02:00'] : ['09:00', '23:00'];
          await orgs.setOpeningHours(res.orgId, Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, opensAt: open, closesAt: close })));
        }
        H[key] = { ctx: { id: res.orgId, type: 'PHARMACY', role: 'ORG_OWNER', verificationStatus: 'VERIFIED', status: 'ACTIVE' }, ownerId: res.userId };
      }

      // Stock: common products are widespread; products reported short in 2024 (Concor, Augmentin) are scarce;
      // insulin (Mixtard 30) exists only in a warehouse, which patients never see as pharmacy stock.
      const common = ['Panadol|500 mg', 'Panadol Extra|500 mg + 65 mg', 'Brufen|400 mg', 'Glucophage|500 mg', 'Cataflam|50 mg', 'Antinal|200 mg', 'Congestal|650 mg + 60 mg + 4 mg',
        'Nexium|40 mg', 'Lipitor|20 mg', 'Amaryl|2 mg', 'Flagyl|500 mg', 'Ciprofar|500 mg', 'Lasix|40 mg', 'Zithromax|500 mg', 'Capoten|25 mg', 'Glucophage|1000 mg', 'Concor|2.5 mg', 'Ventolin|100 mcg/dose'];
      const scarce: Record<string, string[]> = { 'Concor|5 mg': ['sc07', 'sc12'], 'Augmentin|1 g': ['sc04', 'sc13'], 'Augmentin|625 mg': ['sc03', 'sc09'] };
      const itemIds: Array<{ org: string; itemId: string; key: string }> = [];
      for (const [key] of NEW_PHARMACIES) {
        const chosen = new Set<string>();
        const n = between(9, 13);
        while (chosen.size < n) chosen.add(pick(common));
        for (const [k, holders] of Object.entries(scarce)) if (holders.includes(key)) chosen.add(k);
        for (const k of chosen) {
          const qty = rnd() < 0.08 ? 0 : between(2, 70);
          const item = await inventory.addItem(H[key].ctx.id, H[key].ownerId, { medicineId: med(k), openingQty: qty, lowStockThreshold: between(3, 10), source: 'MANUAL' }) as unknown as { id: string };
          itemIds.push({ org: key, itemId: item.id, key: k });
        }
      }
      // Warehouse stock for the new products (Mixtard only at the Cairo warehouse).
      for (const m of NEW_MEDICINES) {
        const k = `${m.brandNameEn}|${m.strength}`;
        if (k !== 'Mixtard 30|100 IU/mL') await inventory.addItem(H.wh1.ctx.id, H.wh1.ownerId, { medicineId: med(k), openingQty: 300, lowStockThreshold: 40, source: 'MANUAL' });
      }
      await inventory.addItem(H.wh2.ctx.id, H.wh2.ownerId, { medicineId: med('Mixtard 30|100 IU/mL'), openingQty: 40, lowStockThreshold: 10, source: 'MANUAL' });

      // Day-to-day activity on the flagship pharmacy (sales, a count) so the ledger tells a story.
      const ph1Items = await db.query<{ id: string; brandNameEn: string; physicalQty: number }>(
        `SELECT i.id, m.brand_name_en, i.physical_qty FROM inventory_items i JOIN medicines m ON m.id = i.medicine_id WHERE i.organization_id = $1`, [H.ph1.ctx.id]);
      const panadol = ph1Items.find((i) => i.brandNameEn === 'Panadol');
      if (panadol) {
        await inventory.adjust(H.ph1.ctx.id, panadol.id, H.ph1.ownerId, { type: 'SALE', qty: 3, source: 'BARCODE' });
        await inventory.adjust(H.ph1.ctx.id, panadol.id, H.ph1.ownerId, { type: 'SALE', qty: 2, source: 'MANUAL' });
        await inventory.adjust(H.ph1.ctx.id, panadol.id, H.ph1.ownerId, { type: 'MARK_UNAVAILABLE', qty: 1, reasonCode: 'DAMAGED', note: 'Crushed box', source: 'MANUAL' });
        await inventory.adjust(H.ph1.ctx.id, panadol.id, H.ph1.ownerId, { type: 'STOCK_COUNT', countedQty: 33, note: 'Evening count', source: 'MANUAL' });
      }

      // Freshness variety: some lines reported 18 h ago (unconfirmed), a few stale (5 days).
      for (const it of itemIds) {
        const r = rnd();
        if (r < 0.14) await db.exec(`UPDATE inventory_items SET last_updated_at = now() - interval '18 hours' WHERE id = $1`, [it.itemId]);
        else if (r < 0.2) await db.exec(`UPDATE inventory_items SET last_updated_at = now() - interval '5 days' WHERE id = $1`, [it.itemId]);
      }

      // A pharmacy feeding stock from its POS through a signed webhook (INTEGRATION freshness source).
      const integrations = app.get(IntegrationsService);
      const integ = await integrations.create(H.sc09.ctx.id, H.sc09.ownerId, { displayName: 'POS sync (demo)', expectedIntervalMinutes: 30 });
      const snapshot = JSON.stringify({ eventId: 'demo-pos-0001', type: 'STOCK_SNAPSHOT', occurredAt: new Date().toISOString(),
        items: [{ medicineId: med('Panadol|500 mg'), physicalQty: 48 }, { medicineId: med('Brufen|400 mg'), physicalQty: 22 }, { medicineId: med('Nexium|40 mg'), physicalQty: 9 }, { medicineId: med('Augmentin|625 mg'), physicalQty: 6 }] });
      const ts = String(Math.floor(Date.now() / 1000));
      await integrations.handleWebhook(integ.id, { timestamp: ts, signature: signWebhook(integ.secret, ts, snapshot) }, Buffer.from(snapshot), JSON.parse(snapshot));

      // Supply relationships.
      const rels = app.get(RelationshipsService);
      for (const k of ['sc01', 'sc02', 'sc03', 'sc04', 'sc05']) {
        const r = await rels.request(H[k].ctx, H[k].ownerId, { warehouseOrgId: H.wh1.ctx.id });
        await rels.decide(H.wh1.ctx, H.wh1.ownerId, r.id, { status: 'ACTIVE', paymentTerms: 'Net 30 (demo)' });
      }
      const pending = await db.maybeOne<{ id: string }>(`SELECT id FROM supply_relationships WHERE pharmacy_org_id = $1 AND warehouse_org_id = $2`, [H.ph3.ctx.id, H.wh2.ctx.id]);
      if (pending) await rels.decide(H.wh2.ctx, H.wh2.ownerId, pending.id, { status: 'ACTIVE', paymentTerms: 'Cash on delivery (demo)' });

      // Purchase orders in every state.
      const orders = app.get(PurchaseOrdersService);
      const shipments = app.get(ShipmentsService);
      type Po = { id: string; items: Array<{ id: string; requestedQty: number }> };
      type Sh = { id: string; items: Array<{ id: string; quantity: number }> };
      const createPo = async (k: string, wh: string, items: Array<[string, number]>, notes?: string) =>
        (await orders.create(H[k].ctx, H[k].ownerId, { warehouseOrgId: H[wh].ctx.id, items: items.map(([m, q]) => ({ medicineId: med(m), quantity: q })), notes, submit: true })) as unknown as Po;
      const confirmAll = (wh: string, po: Po, ratio = 1) => orders.confirm(H[wh].ctx, H[wh].ownerId, po.id, { items: po.items.map((i) => ({ itemId: i.id, confirmedQty: Math.floor(i.requestedQty * ratio) })) });
      const ship = async (po: Po, etaHours: number, confidence: 'CONFIRMED' | 'ESTIMATED', batch?: [string, string]) =>
        (await shipments.create(H.wh1.ctx, H.wh1.ownerId, { purchaseOrderId: po.id, carrier: 'Canal Express (demo)', trackingNumber: `TRK-${between(10000, 99999)}`,
          estimatedDeliveryAt: new Date(Date.now() + etaHours * 3600_000).toISOString(), scheduleConfidence: confidence,
          items: po.items.map((i) => ({ purchaseOrderItemId: i.id, quantity: Math.floor(i.requestedQty), batchNumber: batch?.[0], expiryDate: batch?.[1] })) })) as unknown as Sh;

      await createPo('ph2', 'wh1', [['Augmentin|625 mg', 40], ['Brufen|400 mg', 20]], 'Weekly replenishment');                       // SUBMITTED
      const poA = await createPo('sc01', 'wh1', [['Panadol|500 mg', 60], ['Nexium|40 mg', 20]]);                                        // IN TRANSIT
      await confirmAll('wh1', poA);
      const shA = await ship(poA, 20, 'CONFIRMED');
      await shipments.dispatch(H.wh1.ctx, H.wh1.ownerId, shA.id);
      await shipments.updateStatus(H.wh1.ctx, H.wh1.ownerId, shA.id, { status: 'IN_TRANSIT' });
      const poB = await createPo('sc02', 'wh1', [['Concor|5 mg', 30]], 'Patients waiting for Concor 5');                              // DELAYED
      await confirmAll('wh1', poB);
      const shB = await ship(poB, 6, 'ESTIMATED');
      await shipments.dispatch(H.wh1.ctx, H.wh1.ownerId, shB.id);
      await shipments.updateStatus(H.wh1.ctx, H.wh1.ownerId, shB.id, { status: 'DELAYED', reason: 'Vehicle maintenance — new ETA shared' });
      await shipments.updateSchedule(H.wh1.ctx, H.wh1.ownerId, shB.id, { estimatedDeliveryAt: new Date(Date.now() + 30 * 3600_000).toISOString(), confidence: 'ESTIMATED', reason: 'Vehicle maintenance' });
      const poC = await createPo('sc03', 'wh1', [['Glucophage|500 mg', 50]]);                                                        // PARTIALLY CONFIRMED
      await confirmAll('wh1', poC, 0.6);
      const poD = await createPo('ph2', 'wh1', [['Cataflam|50 mg', 20]]);                                                            // PARTIALLY DELIVERED (discrepancies)
      await confirmAll('wh1', poD);
      const shD = await ship(poD, 2, 'CONFIRMED', ['CF-2611', '2027-11-30']);
      await shipments.dispatch(H.wh1.ctx, H.wh1.ownerId, shD.id);
      await shipments.receive(H.ph2.ctx, H.ph2.ownerId, shD.id, { items: [{ shipmentItemId: shD.items[0].id, receivedQty: 17, damagedQty: 2, note: '2 boxes crushed, 1 missing' }], note: 'Checked at delivery' });
      const poE = await createPo('sc04', 'wh1', [['Lipitor|20 mg', 25]]);                                                            // DELIVERED
      await confirmAll('wh1', poE);
      const shE = await ship(poE, 1, 'CONFIRMED', ['LP-2610', '2028-03-31']);
      await shipments.dispatch(H.wh1.ctx, H.wh1.ownerId, shE.id);
      await shipments.receive(H.sc04.ctx, H.sc04.ownerId, shE.id, { items: [{ shipmentItemId: shE.items[0].id, receivedQty: 25, damagedQty: 0 }] });
      await createPo('ph3', 'wh2', [['Glucophage|500 mg', 100]]);                                                                    // SUBMITTED (Cairo warehouse)
      const poF = await createPo('sc05', 'wh1', [['Brufen|400 mg', 15]]);                                                            // CANCELLED after allocation
      await confirmAll('wh1', poF);
      await orders.cancel(H.sc05.ctx, H.sc05.ownerId, poF.id, 'Found stock at another supplier');

      // Patients: requests, a pharmacist hold with pickup code, alerts.
      const patient = await db.one<{ id: string }>(`SELECT id FROM users WHERE email = 'patient@demo.local'`);
      const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
      const patient2 = await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, full_name, preferred_locale) VALUES ('patient2@demo.local', $1, 'Demo Patient 2', 'ar') RETURNING id`, [hash]);
      await db.exec('INSERT INTO notification_preferences (user_id) VALUES ($1)', [patient2.id]);
      const requests = app.get(RequestsService);
      const held = await requests.create(patient.id, { pharmacyOrgId: H.ph1.ctx.id, medicineId: med('Augmentin|625 mg'), quantity: 1, wantsHold: true }) as { id: string };
      await requests.respond(H.ph1.ctx, H.ph1.ownerId, held.id, { outcome: 'HOLD', holdMinutes: 120, note: 'Ready at the counter' });
      await requests.create(patient.id, { pharmacyOrgId: H.ph2.ctx.id, medicineId: med('Panadol Extra|500 mg + 65 mg'), quantity: 2, wantsHold: false });
      const conf = await requests.create(patient.id, { pharmacyOrgId: H.sc01.ctx.id, medicineId: med('Nexium|40 mg'), quantity: 1, wantsHold: false }) as { id: string };
      const sc01HasNexium = await db.maybeOne(`SELECT 1 FROM inventory_items WHERE organization_id = $1 AND medicine_id = $2 AND available_qty > 0`, [H.sc01.ctx.id, med('Nexium|40 mg')]);
      await requests.respond(H.sc01.ctx, H.sc01.ownerId, conf.id, { outcome: sc01HasNexium ? 'CONFIRMED_AVAILABLE' : 'NOT_AVAILABLE' });
      await requests.create(patient2.id, { pharmacyOrgId: H.ph1.ctx.id, medicineId: med('Concor|5 mg'), quantity: 1, wantsHold: true });
      await requests.create(patient2.id, { pharmacyOrgId: H.ph1.ctx.id, medicineId: med('Panadol|500 mg'), quantity: 2, wantsHold: false });
      const alerts = app.get(AlertsService);
      await alerts.create(patient.id, { medicineId: med('Mixtard 30|100 IU/mL'), lat: 30.6, lng: 32.27, radiusKm: 20, minQty: 1, channels: ['IN_APP'], areaLabel: 'Ismailia' });
      await alerts.create(patient2.id, { medicineId: med('Concor|5 mg'), lat: 30.61, lng: 32.26, radiusKm: 10, minQty: 1, channels: ['IN_APP'], areaLabel: 'Sheikh Zayed' });

      // Simulated patient searches through the real finder (fills search analytics; demo traffic only).
      const finder = app.get(FinderService);
      const weighted: Array<[string, number]> = [['Concor|5 mg', 15], ['Panadol|500 mg', 12], ['Augmentin|1 g', 10], ['Augmentin|625 mg', 8], ['Brufen|400 mg', 8], ['Glucophage|500 mg', 8],
        ['Mixtard 30|100 IU/mL', 7], ['Ventolin|100 mcg/dose', 6], ['Nexium|40 mg', 5], ['Cataflam|50 mg', 5], ['Lipitor|20 mg', 4], ['Capoten|25 mg', 4], ['Amaryl|2 mg', 3], ['Zithromax|500 mg', 3], ['Antinal|200 mg', 2]];
      const total = weighted.reduce((a, [, w]) => a + w, 0);
      const origins = [[30.6110, 32.2510], [30.6030, 32.2930], [30.6180, 32.2650], [30.6290, 32.2790], [30.5920, 32.2790], [30.5965, 32.2715], [30.3266, 32.2988], [30.8547, 32.3108], [30.5552, 32.0838]];
      for (let i = 0; i < 400; i++) {
        let r = rnd() * total; let key = weighted[0][0];
        for (const [k, w] of weighted) { if ((r -= w) <= 0) { key = k; break; } }
        const [olat, olng] = pick(origins);
        await finder.search(FinderSearchSchema.parse({ medicineId: med(key), quantity: rnd() < 0.85 ? 1 : between(2, 4), lat: +(olat + (rnd() - 0.5) * 0.02).toFixed(4), lng: +(olng + (rnd() - 0.5) * 0.02).toFixed(4), locationMethod: pick(['GPS', 'MAP_PIN', 'GPS']) }));
      }
    });
    const counts = await db.one(`SELECT (SELECT count(*)::int FROM organizations) AS organizations, (SELECT count(*)::int FROM medicines) AS medicines,
      (SELECT count(*)::int FROM inventory_items) AS stock_lines, (SELECT count(*)::int FROM inventory_movements) AS movements,
      (SELECT count(*)::int FROM purchase_orders) AS purchase_orders, (SELECT count(*)::int FROM shipments) AS shipments,
      (SELECT count(*)::int FROM search_events) AS searches, (SELECT count(*)::int FROM sp_inventory_ledger_mismatches()) AS ledger_mismatches`);
    console.log('Showcase demo data loaded (DEVELOPMENT ONLY):', JSON.stringify(counts));
  } finally {
    await app.close();
  }
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
