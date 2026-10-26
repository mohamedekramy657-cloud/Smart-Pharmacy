import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Errors } from '../../common/errors';
import { requestContext } from '../../common/request-context';
import { zText } from '../../common/zod';
import { Database, Tx } from '../../database/db';
import { NotificationsService } from '../notifications/notifications.service';

export const DOSAGE_FORMS = ['TABLET', 'FILM_COATED_TABLET', 'EFFERVESCENT_TABLET', 'CHEWABLE_TABLET', 'EXTENDED_RELEASE_TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'ORAL_DROPS', 'SOLUTION', 'INJECTION', 'INFUSION', 'CREAM', 'OINTMENT', 'GEL', 'EYE_DROPS', 'EAR_DROPS', 'NASAL_SPRAY', 'INHALER', 'SUPPOSITORY', 'SACHET', 'POWDER', 'LOZENGE', 'PATCH', 'OTHER'] as const;
export const ROUTES = ['ORAL', 'TOPICAL', 'INTRAVENOUS', 'INTRAMUSCULAR', 'SUBCUTANEOUS', 'OPHTHALMIC', 'OTIC', 'NASAL', 'INHALATION', 'RECTAL', 'VAGINAL', 'SUBLINGUAL', 'TRANSDERMAL', 'OTHER'] as const;
export const PACKAGE_UNITS = ['TABLET', 'CAPSULE', 'ML', 'G', 'AMPOULE', 'VIAL', 'SACHET', 'SUPPOSITORY', 'DOSE', 'PATCH', 'UNIT'] as const;
export const STRENGTH_UNITS = ['MG', 'G', 'MCG', 'IU', 'ML', 'PERCENT', 'MG_PER_ML', 'MG_PER_5ML', 'MCG_PER_DOSE', 'UNIT'] as const;

export const MedicineInputSchema = z.object({
  brandNameEn: z.string().trim().min(1).max(160),
  brandNameAr: z.string().trim().max(160).optional(),
  genericNameEn: z.string().trim().min(2).max(200),
  genericNameAr: z.string().trim().max(200).optional(),
  strength: z.string().trim().min(1).max(80),
  concentration: zText(80).optional(),
  dosageForm: z.enum(DOSAGE_FORMS),
  route: z.enum(ROUTES),
  packageSize: z.number().positive().max(100000),
  packageUnit: z.enum(PACKAGE_UNITS),
  manufacturer: z.string().trim().min(2).max(160),
  barcode: z.string().regex(/^[0-9]{8,14}$/).optional(),
  registrationNumber: zText(64).optional(),
  category: zText(80).optional(),
  prescriptionClass: z.enum(['OTC', 'PRESCRIPTION', 'CONTROLLED']).default('PRESCRIPTION'),
  imageUrl: z.url().startsWith('https://').optional(),
  imageLicense: zText(200).optional(),
  ingredients: z.array(z.object({
    nameEn: z.string().trim().min(2).max(160),
    nameAr: z.string().trim().max(160).optional(),
    strengthValue: z.number().positive().max(1_000_000),
    strengthUnit: z.enum(STRENGTH_UNITS),
  }).strict()).min(1).max(10),
  aliases: z.array(z.object({ alias: z.string().trim().min(2).max(120), language: z.enum(['ar', 'en', 'translit']) }).strict()).max(30).optional(),
  confirmDistinct: z.boolean().default(false),
}).strict().refine((m) => !m.imageUrl || m.imageLicense, 'imageLicense is required when imageUrl is set');

export const CatalogSearchSchema = z.object({
  q: z.string().trim().min(2).max(100),
  dosageForm: z.enum(DOSAGE_FORMS).optional(),
  category: zText(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type MedicineInput = z.infer<typeof MedicineInputSchema>;

const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u0621-\u064a.]+/g, ' ').trim();

/** Canonical clinical identity: two products are the same only if ALL of these match. */
export function identityKey(m: Pick<MedicineInput, 'brandNameEn' | 'ingredients' | 'dosageForm' | 'route' | 'packageSize' | 'packageUnit' | 'manufacturer'>): string {
  const ingredients = m.ingredients.map((i) => `${norm(i.nameEn)}:${Number(i.strengthValue)}${i.strengthUnit}`).sort().join('+');
  return [norm(m.brandNameEn), ingredients, m.dosageForm, m.route, `${Number(m.packageSize)}${m.packageUnit}`, norm(m.manufacturer)].join('|');
}

const MEDICINE_COLUMNS = `m.id, m.brand_name_en, m.brand_name_ar, m.generic_name_en, m.generic_name_ar, m.strength, m.concentration,
  m.dosage_form, m.route, m.package_size::float AS package_size, m.package_unit, m.manufacturer, m.barcode, m.registration_number,
  m.category, m.prescription_class, m.status, m.status_reason, m.image_url, m.image_license, m.data_source, m.updated_at`;

@Injectable()
export class CatalogService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  /**
   * Candidate retrieval for AR/EN queries. Uses trigram similarity on normalized terms plus a
   * transliteration skeleton. It never auto-selects: callers must let the user pick a product.
   */
  async search(input: z.infer<typeof CatalogSearchSchema>) {
    if (/^[0-9]{8,14}$/.test(input.q)) {
      return this.db.query(`SELECT ${MEDICINE_COLUMNS}, 1.0::float AS score, 'BARCODE' AS matched_by FROM medicines m WHERE m.barcode = $1`, [input.q]);
    }
    return this.db.query(
      `WITH hits AS (
         SELECT t.medicine_id,
                max(t.weight * greatest(
                  CASE WHEN t.term_normalized = sp_normalize_text($1) THEN 1.0
                       WHEN t.term_normalized LIKE sp_normalize_text($1) || '%' THEN 0.92
                       ELSE word_similarity(sp_normalize_text($1), t.term_normalized) * 0.85 END,
                  CASE WHEN length(sp_search_skeleton($1)) >= 3 THEN similarity(sp_search_skeleton($1), t.term_skeleton) * 0.75 ELSE 0 END
                )) AS score,
                (array_agg(t.term ORDER BY t.weight DESC))[1] AS matched_term
           FROM medicine_search_terms t
          WHERE t.term_normalized LIKE sp_normalize_text($1) || '%'
             OR t.term_normalized %> sp_normalize_text($1)
             OR (length(sp_search_skeleton($1)) >= 3 AND t.term_skeleton % sp_search_skeleton($1))
          GROUP BY t.medicine_id)
       SELECT ${MEDICINE_COLUMNS}, round(h.score::numeric, 3)::float AS score, h.matched_term AS matched_by
         FROM hits h JOIN medicines m ON m.id = h.medicine_id
        WHERE h.score >= 0.3 AND ($2::text IS NULL OR m.dosage_form = $2) AND ($3::text IS NULL OR m.category ILIKE $3)
        ORDER BY (m.status = 'ACTIVE') DESC, h.score DESC, m.brand_name_en, m.strength
        LIMIT $4`,
      [input.q, input.dosageForm ?? null, input.category ?? null, input.limit],
    );
  }

  async get(id: string) {
    const m = await this.db.maybeOne<Record<string, unknown>>(`SELECT ${MEDICINE_COLUMNS}, m.identity_key, m.created_at FROM medicines m WHERE m.id = $1`, [id]);
    if (!m) throw Errors.notFound('Medicine');
    const ingredients = await this.db.query(
      `SELECT ai.id, ai.name_en, ai.name_ar, mi.strength_value::float AS strength_value, mi.strength_unit
         FROM medicine_ingredients mi JOIN active_ingredients ai ON ai.id = mi.ingredient_id WHERE mi.medicine_id = $1 ORDER BY ai.name_en`, [id]);
    const aliases = await this.db.query(`SELECT id, alias, language, approved FROM medicine_aliases WHERE medicine_id = $1 ORDER BY alias`, [id]);
    return { ...m, ingredients, aliases };
  }

  async create(input: MedicineInput, opts: { dataSource?: 'MANUAL' | 'DEV_SEED'; tx?: Tx } = {}) {
    const run = async (tx: Tx) => {
      const key = identityKey(input);
      const exact = await tx.maybeOne<{ id: string }>('SELECT id FROM medicines WHERE identity_key = $1', [key]);
      if (exact) throw Errors.conflict('DUPLICATE_MEDICINE', 'An identical product (same ingredients, strength, form, route, package and manufacturer) already exists', { existingId: exact.id });
      if (input.barcode && (await tx.maybeOne('SELECT 1 FROM medicines WHERE barcode = $1', [input.barcode]))) {
        throw Errors.conflict('DUPLICATE_BARCODE', 'Another product already uses this barcode');
      }
      if (!input.confirmDistinct) {
        const similar = await tx.query<{ id: string; brandNameEn: string; strength: string; dosageForm: string }>(
          `SELECT id, brand_name_en, strength, dosage_form FROM medicines
            WHERE (similarity(sp_normalize_text(brand_name_en), sp_normalize_text($1)) > 0.6 OR sp_normalize_text(generic_name_en) = sp_normalize_text($2))
              AND dosage_form = $3 AND strength = $4 LIMIT 5`,
          [input.brandNameEn, input.genericNameEn, input.dosageForm, input.strength]);
        if (similar.length) {
          throw Errors.conflict('POSSIBLE_DUPLICATE', 'Similar products exist. Review them and resubmit with confirmDistinct=true if this is a different product.', { candidates: similar });
        }
      }
      const med = await tx.one<{ id: string }>(
        `INSERT INTO medicines (brand_name_en, brand_name_ar, generic_name_en, generic_name_ar, strength, concentration, dosage_form, route,
                                package_size, package_unit, manufacturer, barcode, registration_number, category, prescription_class,
                                image_url, image_license, identity_key, data_source, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) RETURNING id`,
        [input.brandNameEn, input.brandNameAr ?? null, input.genericNameEn, input.genericNameAr ?? null, input.strength, input.concentration ?? null,
         input.dosageForm, input.route, input.packageSize, input.packageUnit, input.manufacturer, input.barcode ?? null, input.registrationNumber ?? null,
         input.category ?? null, input.prescriptionClass, input.imageUrl ?? null, input.imageLicense ?? null, key, opts.dataSource ?? 'MANUAL', requestContext.get()?.userId ?? null]);
      for (const ing of input.ingredients) {
        const ai = await tx.one<{ id: string }>(
          `INSERT INTO active_ingredients (name_en, name_ar) VALUES ($1,$2)
           ON CONFLICT (normalized_name) DO UPDATE SET name_ar = coalesce(active_ingredients.name_ar, EXCLUDED.name_ar) RETURNING id`,
          [ing.nameEn, ing.nameAr ?? null]);
        await tx.exec('INSERT INTO medicine_ingredients (medicine_id, ingredient_id, strength_value, strength_unit) VALUES ($1,$2,$3,$4)', [med.id, ai.id, ing.strengthValue, ing.strengthUnit]);
      }
      for (const a of input.aliases ?? []) {
        await tx.exec('INSERT INTO medicine_aliases (medicine_id, alias, language, approved) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING', [med.id, a.alias, a.language]);
      }
      await this.audit.record(tx, { action: 'MEDICINE_CREATED', entityType: 'medicine', entityId: med.id, summary: `${input.brandNameEn} ${input.strength} ${input.dosageForm}` });
      return med;
    };
    const med = opts.tx ? await run(opts.tx) : await this.db.tx(run);
    return opts.tx ? med : this.get(med.id);
  }

  /** Non-clinical edits only once a product is referenced; clinical identity changes need a new product. */
  async update(id: string, patch: Partial<Pick<MedicineInput, 'brandNameAr' | 'genericNameAr' | 'category' | 'registrationNumber' | 'barcode' | 'imageUrl' | 'imageLicense' | 'concentration'>>) {
    await this.db.tx(async (tx) => {
      const exists = await tx.maybeOne('SELECT 1 FROM medicines WHERE id = $1 FOR UPDATE', [id]);
      if (!exists) throw Errors.notFound('Medicine');
      await tx.exec(
        `UPDATE medicines SET brand_name_ar = coalesce($2, brand_name_ar), generic_name_ar = coalesce($3, generic_name_ar), category = coalesce($4, category),
                registration_number = coalesce($5, registration_number), barcode = coalesce($6, barcode), image_url = coalesce($7, image_url),
                image_license = coalesce($8, image_license), concentration = coalesce($9, concentration) WHERE id = $1`,
        [id, patch.brandNameAr ?? null, patch.genericNameAr ?? null, patch.category ?? null, patch.registrationNumber ?? null, patch.barcode ?? null, patch.imageUrl ?? null, patch.imageLicense ?? null, patch.concentration ?? null]);
      await this.audit.record(tx, { action: 'MEDICINE_UPDATED', entityType: 'medicine', entityId: id, changes: patch as Record<string, unknown> });
    });
    return this.get(id);
  }

  async setStatus(id: string, status: 'ACTIVE' | 'DISCONTINUED' | 'RECALLED' | 'SUSPENDED', reason: string, actorUserId: string) {
    await this.db.tx(async (tx) => {
      const before = await tx.maybeOne<{ status: string; brandNameEn: string; strength: string }>('SELECT status, brand_name_en, strength FROM medicines WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw Errors.notFound('Medicine');
      await tx.exec('UPDATE medicines SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4 WHERE id = $1', [id, status, reason, actorUserId]);
      await this.audit.record(tx, { action: 'MEDICINE_STATUS_CHANGED', entityType: 'medicine', entityId: id, changes: { from: before.status, to: status, reason } });
      if (status === 'RECALLED' || status === 'SUSPENDED') {
        const holders = await tx.query<{ organizationId: string }>('SELECT DISTINCT organization_id FROM inventory_items WHERE medicine_id = $1 AND physical_qty > 0', [id]);
        for (const h of holders) {
          await this.notifications.toOrg(tx, h.organizationId, {
            type: 'ORG_STATUS_CHANGED', dedupeKey: `medicine-status:${id}:${status}`,
            data: { org: `${before.brandNameEn} ${before.strength}`, status, reason },
          });
        }
      }
    });
    return this.get(id);
  }

  async addAlias(medicineId: string, alias: string, language: 'ar' | 'en' | 'translit') {
    return this.db.tx(async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO medicine_aliases (medicine_id, alias, language, approved) VALUES ($1,$2,$3,true)
         ON CONFLICT (medicine_id, alias) DO UPDATE SET approved = true RETURNING id`, [medicineId, alias, language]);
      await this.audit.record(tx, { action: 'MEDICINE_ALIAS_ADDED', entityType: 'medicine', entityId: medicineId, changes: { alias, language } });
      return row;
    });
  }

  async removeAlias(medicineId: string, aliasId: string) {
    await this.db.tx(async (tx) => {
      const n = await tx.exec('DELETE FROM medicine_aliases WHERE id = $1 AND medicine_id = $2', [aliasId, medicineId]);
      if (!n) throw Errors.notFound('Alias');
      await this.audit.record(tx, { action: 'MEDICINE_ALIAS_REMOVED', entityType: 'medicine', entityId: medicineId, changes: { aliasId } });
    });
  }

  async adminList(q: string | undefined, status: string | undefined, page: number, pageSize: number) {
    const rows = await this.db.query(
      `SELECT ${MEDICINE_COLUMNS}, count(*) OVER()::int AS total FROM medicines m
        WHERE ($1::text IS NULL OR sp_normalize_text(m.brand_name_en || ' ' || m.generic_name_en || ' ' || coalesce(m.brand_name_ar,'')) LIKE '%' || sp_normalize_text($1) || '%')
          AND ($2::text IS NULL OR m.status = $2)
        ORDER BY m.brand_name_en, m.strength LIMIT $3 OFFSET $4`,
      [q ?? null, status ?? null, pageSize, (page - 1) * pageSize]);
    return { items: rows, total: (rows[0] as { total?: number } | undefined)?.total ?? 0, page, pageSize };
  }
}
