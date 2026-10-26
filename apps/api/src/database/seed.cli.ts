/**
 * DEVELOPMENT SEED — demo data only. Every organization is named "[DEMO] …" and flagged is_demo;
 * catalog rows use data_source = DEV_SEED (illustrative product descriptors, NOT verified against
 * the Egyptian Drug Authority registry). No barcodes, registration numbers or prices are invented.
 * All records are created through the real services (ledger, workflows, audit), not raw inserts.
 * Area centroids are approximate reference points for local testing.
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
import { InventoryService } from '../modules/inventory/inventory.service';
import { OrganizationsService } from '../modules/organizations/organizations.service';
import { PurchaseOrdersService } from '../modules/supply/purchase-orders.service';
import { RelationshipsService } from '../modules/supply/relationships.service';
import { ShipmentsService } from '../modules/supply/shipments.service';
import { Database } from './db';

const PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPass#2026';

const CITIES = [
  { key: 'ismailia', gov: ['Ismailia', 'الإسماعيلية'], name: ['Ismailia', 'الإسماعيلية'], at: [30.5965, 32.2715], districts: [
    ['First District', 'الحي الأول', 30.5920, 32.2790], ['Second District', 'الحي الثاني', 30.6030, 32.2930], ['Third District', 'الحي الثالث', 30.6180, 32.2650],
    ['Sheikh Zayed', 'الشيخ زايد', 30.6110, 32.2510], ['Nemra 6', 'نمرة 6', 30.6290, 32.2790]] },
  { key: 'fayed', gov: ['Ismailia', 'الإسماعيلية'], name: ['Fayed', 'فايد'], at: [30.3266, 32.2988], districts: [] },
  { key: 'qantara', gov: ['Ismailia', 'الإسماعيلية'], name: ['Al Qantara Gharb', 'القنطرة غرب'], at: [30.8547, 32.3108], districts: [] },
  { key: 'cairo', gov: ['Cairo', 'القاهرة'], name: ['Cairo', 'القاهرة'], at: [30.0444, 31.2357], districts: [['Nasr City', 'مدينة نصر', 30.0566, 31.3301], ['Downtown', 'وسط البلد', 30.0478, 31.2385]] },
] as const;

const ing = (nameEn: string, nameAr: string, strengthValue: number, strengthUnit: MedicineInput['ingredients'][number]['strengthUnit'] = 'MG') => ({ nameEn, nameAr, strengthValue, strengthUnit });
const MEDICINES: Array<Omit<MedicineInput, 'confirmDistinct'> & { key: string }> = [
  { key: 'panadol', brandNameEn: 'Panadol', brandNameAr: 'بانادول', genericNameEn: 'Paracetamol', genericNameAr: 'باراسيتامول', strength: '500 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 24, packageUnit: 'TABLET', manufacturer: 'GSK', category: 'Analgesic', prescriptionClass: 'OTC', ingredients: [ing('Paracetamol', 'باراسيتامول', 500)], aliases: [{ alias: 'بنادول', language: 'ar' }, { alias: 'panadool', language: 'translit' }] },
  { key: 'panadolExtra', brandNameEn: 'Panadol Extra', brandNameAr: 'بانادول اكسترا', genericNameEn: 'Paracetamol + Caffeine', strength: '500 mg + 65 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 24, packageUnit: 'TABLET', manufacturer: 'GSK', category: 'Analgesic', prescriptionClass: 'OTC', ingredients: [ing('Paracetamol', 'باراسيتامول', 500), ing('Caffeine', 'كافيين', 65)] },
  { key: 'augmentin625', brandNameEn: 'Augmentin', brandNameAr: 'أوجمنتين', genericNameEn: 'Amoxicillin + Clavulanic acid', strength: '625 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 14, packageUnit: 'TABLET', manufacturer: 'GSK', category: 'Antibiotic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Amoxicillin', 'أموكسيسيلين', 500), ing('Clavulanic acid', 'حمض الكلافولانيك', 125)] },
  { key: 'augmentin1g', brandNameEn: 'Augmentin', brandNameAr: 'أوجمنتين', genericNameEn: 'Amoxicillin + Clavulanic acid', strength: '1 g', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 14, packageUnit: 'TABLET', manufacturer: 'GSK', category: 'Antibiotic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Amoxicillin', 'أموكسيسيلين', 875), ing('Clavulanic acid', 'حمض الكلافولانيك', 125)] },
  { key: 'brufen', brandNameEn: 'Brufen', brandNameAr: 'بروفين', genericNameEn: 'Ibuprofen', genericNameAr: 'ايبوبروفين', strength: '400 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 30, packageUnit: 'TABLET', manufacturer: 'Abbott', category: 'Analgesic', prescriptionClass: 'OTC', ingredients: [ing('Ibuprofen', 'ايبوبروفين', 400)] },
  { key: 'concor', brandNameEn: 'Concor', brandNameAr: 'كونكور', genericNameEn: 'Bisoprolol fumarate', strength: '5 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 30, packageUnit: 'TABLET', manufacturer: 'Merck', category: 'Cardiovascular', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Bisoprolol fumarate', 'بيسوبرولول', 5)] },
  { key: 'glucophage', brandNameEn: 'Glucophage', brandNameAr: 'جلوكوفاج', genericNameEn: 'Metformin hydrochloride', strength: '500 mg', dosageForm: 'FILM_COATED_TABLET', route: 'ORAL', packageSize: 50, packageUnit: 'TABLET', manufacturer: 'Merck', category: 'Antidiabetic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Metformin hydrochloride', 'ميتفورمين', 500)] },
  { key: 'cataflam', brandNameEn: 'Cataflam', brandNameAr: 'كتافلام', genericNameEn: 'Diclofenac potassium', strength: '50 mg', dosageForm: 'TABLET', route: 'ORAL', packageSize: 20, packageUnit: 'TABLET', manufacturer: 'Novartis', category: 'Analgesic', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Diclofenac potassium', 'ديكلوفيناك', 50)] },
  { key: 'ventolin', brandNameEn: 'Ventolin', brandNameAr: 'فنتولين', genericNameEn: 'Salbutamol', strength: '100 mcg/dose', dosageForm: 'INHALER', route: 'INHALATION', packageSize: 200, packageUnit: 'DOSE', manufacturer: 'GSK', category: 'Respiratory', prescriptionClass: 'PRESCRIPTION', ingredients: [ing('Salbutamol', 'سالبوتامول', 100, 'MCG_PER_DOSE')] },
];

// [name, nameAr, type, city, lat, lng, verify, is24h]
const ORGS = [
  ['ph1', '[DEMO] Al-Shifa Pharmacy', 'صيدلية الشفاء [تجريبي]', 'PHARMACY', 'ismailia', 30.6100, 32.2715, true, true],
  ['ph2', '[DEMO] Canal Pharmacy', 'صيدلية القناة [تجريبي]', 'PHARMACY', 'ismailia', 30.5965, 32.3029, true, false],
  ['ph3', '[DEMO] Nemra Pharmacy', 'صيدلية النمرة [تجريبي]', 'PHARMACY', 'ismailia', 30.6500, 32.2250, true, false],
  ['ph4', '[DEMO] Lake Timsah Pharmacy', 'صيدلية بحيرة التمساح [تجريبي]', 'PHARMACY', 'ismailia', 30.4839, 32.2715, true, false],
  ['ph5', '[DEMO] Fayed Central Pharmacy', 'صيدلية فايد المركزية [تجريبي]', 'PHARMACY', 'fayed', 30.3266, 32.2988, true, false],
  ['ph6', '[DEMO] Qantara Pharmacy', 'صيدلية القنطرة [تجريبي]', 'PHARMACY', 'qantara', 30.8547, 32.3108, true, false],
  ['ph7', '[DEMO] Cairo Downtown Pharmacy', 'صيدلية وسط القاهرة [تجريبي]', 'PHARMACY', 'cairo', 30.0478, 31.2385, true, false],
  ['ph8', '[DEMO] New Pharmacy (pending verification)', 'صيدلية جديدة [تجريبي]', 'PHARMACY', 'ismailia', 30.6050, 32.2850, false, false],
  ['wh1', '[DEMO] Suez Canal Medical Distribution', 'قناة السويس للتوزيع الطبي [تجريبي]', 'WAREHOUSE', 'ismailia', 30.5800, 32.2400, true, false],
  ['wh2', '[DEMO] Cairo Pharma Distribution', 'القاهرة لتوزيع الأدوية [تجريبي]', 'WAREHOUSE', 'cairo', 30.0800, 31.3300, true, false],
] as const;

// [org, medicine, qty, lowStockThreshold]
const STOCK: Array<[string, string, number, number | null]> = [
  ['ph1', 'panadol', 40, 10], ['ph1', 'augmentin625', 12, 5], ['ph1', 'concor', 3, 5],
  ['ph2', 'panadol', 25, 10], ['ph2', 'panadolExtra', 18, 5], ['ph2', 'brufen', 30, 8],
  ['ph3', 'augmentin1g', 10, 4], ['ph3', 'glucophage', 60, 15],
  ['ph4', 'cataflam', 15, 5], ['ph4', 'ventolin', 4, 2],
  ['ph5', 'augmentin1g', 6, 2], ['ph6', 'ventolin', 2, 1], ['ph7', 'panadol', 100, 20], ['ph8', 'concor', 20, 5],
  ...MEDICINES.map((m) => ['wh1', m.key, 500, 50] as [string, string, number, number]),
  ['wh2', 'panadol', 800, 100], ['wh2', 'glucophage', 600, 100],
];

async function main(): Promise<void> {
  if (config().NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const db = app.get(Database);
  try {
    if (await db.maybeOne(`SELECT 1 FROM users WHERE email = 'admin@demo.local'`)) {
      console.log('Demo data already present (admin@demo.local exists). Reset the database to re-seed.');
      return;
    }
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const admin = await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, full_name, platform_role, preferred_locale) VALUES ('admin@demo.local', $1, 'Demo Super Admin', 'SUPER_ADMIN', 'en') RETURNING id`, [hash]);
    await db.exec('INSERT INTO notification_preferences (user_id) VALUES ($1)', [admin.id]);

    await requestContext.run({ requestId: 'dev-seed', userId: admin.id }, async () => {
      const cityIds: Record<string, number> = {};
      const districtIds: Record<string, number[]> = {};
      for (const c of CITIES) {
        const row = await db.one<{ id: number }>(`INSERT INTO cities (governorate_en, governorate_ar, name_en, name_ar, centroid) VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($6,$5),4326)::geography) RETURNING id`,
          [c.gov[0], c.gov[1], c.name[0], c.name[1], c.at[0], c.at[1]]);
        cityIds[c.key] = row.id;
        districtIds[c.key] = [];
        for (const d of c.districts) {
          const dr = await db.one<{ id: number }>(`INSERT INTO districts (city_id, name_en, name_ar, centroid) VALUES ($1,$2,$3, ST_SetSRID(ST_MakePoint($5,$4),4326)::geography) RETURNING id`, [row.id, d[0], d[1], d[2], d[3]]);
          districtIds[c.key].push(dr.id);
        }
      }

      const catalog = app.get(CatalogService);
      const medIds: Record<string, string> = {};
      for (const { key, ...m } of MEDICINES) {
        const created = (await catalog.create({ ...m, confirmDistinct: true }, { dataSource: 'DEV_SEED' })) as { id: string };
        medIds[key] = created.id;
      }

      const auth = app.get(AuthService);
      const orgs = app.get(OrganizationsService);
      const adminSvc = app.get(AdminService);
      const handles: Record<string, { ctx: OrgContext; ownerId: string; email: string }> = {};
      for (const [key, nameEn, nameAr, type, city, lat, lng, verify, is24h] of ORGS) {
        const email = `${key}@demo.local`;
        const res = await db.tx(async (tx) => {
          const user = await auth.createUser(tx, { email, password: PASSWORD, fullName: `${nameEn.replace('[DEMO] ', '')} Owner`, preferredLocale: 'ar' });
          const org = await orgs.create(tx, user.id, { type, nameEn, nameAr, licenseNumber: `DEMO-${key.toUpperCase()}`, addressLine: `Demo address (${city})`, cityId: cityIds[city], lat, lng, phone: '+20 64 000 0000' }, true);
          return { userId: user.id, orgId: org.id };
        });
        if (verify) await adminSvc.decideVerification(res.orgId, admin.id, { decision: 'VERIFIED', notes: 'Demo verification (development seed)' });
        handles[key] = { ctx: { id: res.orgId, type, role: 'ORG_OWNER', verificationStatus: verify ? 'VERIFIED' : 'PENDING', status: 'ACTIVE' }, ownerId: res.userId, email };
        if (type === 'PHARMACY') {
          await orgs.update(res.orgId, { pharmacy: { is24h, acceptsHolds: key === 'ph1' || key === 'ph2', deliveryAvailable: key === 'ph2' } });
          if (!is24h) {
            const hours = key === 'ph4'
              ? Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, opensAt: '08:00', closesAt: '02:00' }))
              : Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, opensAt: '09:00', closesAt: '23:00' }));
            await orgs.setOpeningHours(res.orgId, hours);
          }
        }
      }
      // Staff accounts for the main demo pharmacy.
      await orgs.addMember(handles.ph1.ctx.id, { email: 'ph1.staff@demo.local', role: 'ORG_STAFF', fullName: 'Al-Shifa Staff', initialPassword: PASSWORD });

      const inventory = app.get(InventoryService);
      for (const [org, med, qty, threshold] of STOCK) {
        await inventory.addItem(handles[org].ctx.id, handles[org].ownerId, { medicineId: medIds[med], openingQty: qty, lowStockThreshold: threshold ?? undefined, source: 'MANUAL' });
      }
      // Demonstrate stale data: Fayed's Augmentin line was last updated 5 days ago.
      await db.exec(`UPDATE inventory_items SET last_updated_at = now() - interval '5 days' WHERE organization_id = $1`, [handles.ph5.ctx.id]);

      const rels = app.get(RelationshipsService);
      for (const ph of ['ph1', 'ph2']) {
        const r = await rels.request(handles[ph].ctx, handles[ph].ownerId, { warehouseOrgId: handles.wh1.ctx.id });
        await rels.decide(handles.wh1.ctx, handles.wh1.ownerId, r.id, { status: 'ACTIVE', paymentTerms: 'Demo terms' });
      }
      await rels.request(handles.ph3.ctx, handles.ph3.ownerId, { warehouseOrgId: handles.wh2.ctx.id });

      // A replenishment order in transit (demonstrates incoming stock shown separately).
      const orders = app.get(PurchaseOrdersService);
      const shipments = app.get(ShipmentsService);
      const po = (await orders.create(handles.ph1.ctx, handles.ph1.ownerId, { warehouseOrgId: handles.wh1.ctx.id, items: [{ medicineId: medIds.concor, quantity: 30 }], submit: true })) as unknown as { id: string; items: Array<{ id: string }> };
      await orders.confirm(handles.wh1.ctx, handles.wh1.ownerId, po.id, { items: [{ itemId: po.items[0].id, confirmedQty: 30 }] });
      const sh = (await shipments.create(handles.wh1.ctx, handles.wh1.ownerId, {
        purchaseOrderId: po.id, items: [{ purchaseOrderItemId: po.items[0].id, quantity: 30 }], carrier: 'Demo courier',
        estimatedDeliveryAt: new Date(Date.now() + 26 * 3600_000).toISOString(), scheduleConfidence: 'ESTIMATED',
      })) as { id: string };
      await shipments.dispatch(handles.wh1.ctx, handles.wh1.ownerId, sh.id);

      const patientHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
      const patient = await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, full_name, preferred_locale) VALUES ('patient@demo.local', $1, 'Demo Patient', 'ar') RETURNING id`, [patientHash]);
      await db.exec('INSERT INTO notification_preferences (user_id) VALUES ($1)', [patient.id]);
    });

    console.log('Demo data created (DEVELOPMENT ONLY). Accounts (password from SEED_PASSWORD or the dev default):');
    for (const e of ['admin@demo.local (super admin)', 'ph1@demo.local (pharmacy owner)', 'ph1.staff@demo.local (pharmacy staff)', 'wh1@demo.local (warehouse owner)', 'patient@demo.local (patient)']) console.log(`  - ${e}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
