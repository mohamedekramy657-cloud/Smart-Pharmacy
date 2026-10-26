import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import type { OrgRole } from '../../common/auth/permissions';
import { Errors } from '../../common/errors';
import { isOpenNow, OpeningHour } from '../../common/time';
import { zLat, zLng, zText } from '../../common/zod';
import { Database, Queryable, Tx } from '../../database/db';
import { NotificationsService } from '../notifications/notifications.service';

const zPhone = z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'Invalid phone number');

export const OrganizationInputSchema = z.object({
  type: z.enum(['PHARMACY', 'WAREHOUSE']),
  nameEn: z.string().trim().min(2).max(160),
  nameAr: z.string().trim().max(160).optional(),
  legalName: zText(200).optional(),
  registrationNumber: zText(64).optional(),
  licenseNumber: z.string().trim().min(3).max(64),
  taxId: zText(64).optional(),
  addressLine: z.string().trim().min(5).max(300),
  cityId: z.number().int().positive().optional(),
  districtId: z.number().int().positive().optional(),
  lat: zLat,
  lng: zLng,
  phone: zPhone,
  email: z.email().optional(),
  submissionNotes: zText(1000).optional(),
}).strict();

export const ProfileUpdateSchema = z.object({
  nameAr: z.string().trim().max(160).nullable().optional(),
  phone: zPhone.optional(),
  email: z.email().nullable().optional(),
  // Identity & location: editable only while verification is pending (admins can always edit).
  nameEn: z.string().trim().min(2).max(160).optional(),
  legalName: zText(200).nullable().optional(),
  registrationNumber: zText(64).nullable().optional(),
  licenseNumber: z.string().trim().min(3).max(64).optional(),
  addressLine: z.string().trim().min(5).max(300).optional(),
  cityId: z.number().int().positive().nullable().optional(),
  districtId: z.number().int().positive().nullable().optional(),
  lat: zLat.optional(),
  lng: zLng.optional(),
  pharmacy: z.object({
    is24h: z.boolean().optional(),
    deliveryAvailable: z.boolean().optional(),
    acceptsConfirmationRequests: z.boolean().optional(),
    acceptsHolds: z.boolean().optional(),
    pharmacistInCharge: zText(120).nullable().optional(),
  }).strict().optional(),
  warehouse: z.object({
    defaultLeadTimeHours: z.number().int().min(1).max(720).optional(),
    minOrderValue: z.number().min(0).max(10_000_000).nullable().optional(),
    coldChainCapable: z.boolean().optional(),
    distributionNotes: zText(1000).nullable().optional(),
    serviceCityIds: z.array(z.number().int().positive()).max(50).optional(),
  }).strict().optional(),
}).strict().refine((v) => (v.lat === undefined) === (v.lng === undefined), 'lat and lng must be provided together');

export const OpeningHoursSchema = z.object({
  hours: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }).strict()).max(21),
}).strict();

export const AddMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(['ORG_MANAGER', 'ORG_STAFF', 'ORG_VIEWER', 'ORG_OWNER']),
  fullName: z.string().trim().min(2).max(120).optional(),
  initialPassword: z.string().min(10).max(128).optional(),
}).strict();

const LOCKED_AFTER_VERIFICATION = ['nameEn', 'legalName', 'registrationNumber', 'licenseNumber', 'addressLine', 'cityId', 'districtId', 'lat', 'lng'] as const;
const COLUMN: Record<string, string> = {
  nameAr: 'name_ar', phone: 'phone', email: 'email', nameEn: 'name_en', legalName: 'legal_name',
  registrationNumber: 'registration_number', licenseNumber: 'license_number', addressLine: 'address_line',
  cityId: 'city_id', districtId: 'district_id',
};

@Injectable()
export class OrganizationsService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  async create(tx: Tx, ownerUserId: string, input: z.infer<typeof OrganizationInputSchema>, isDemo = false): Promise<{ id: string }> {
    const org = await tx.one<{ id: string }>(
      `INSERT INTO organizations (type, name_en, name_ar, legal_name, registration_number, license_number, tax_id, address_line,
                                  city_id, district_id, location, phone, email, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, ST_SetSRID(ST_MakePoint($11,$12),4326)::geography, $13,$14,$15) RETURNING id`,
      [input.type, input.nameEn, input.nameAr ?? null, input.legalName ?? null, input.registrationNumber ?? null, input.licenseNumber,
       input.taxId ?? null, input.addressLine, input.cityId ?? null, input.districtId ?? null, input.lng, input.lat, input.phone, input.email ?? null, isDemo],
    );
    await tx.exec(input.type === 'PHARMACY' ? 'INSERT INTO pharmacies (organization_id) VALUES ($1)' : 'INSERT INTO warehouses (organization_id) VALUES ($1)', [org.id]);
    await tx.exec(`INSERT INTO organization_members (organization_id, user_id, role, created_by) VALUES ($1,$2,'ORG_OWNER',$2)`, [org.id, ownerUserId]);
    await tx.exec(`INSERT INTO verification_requests (organization_id, submitted_by, submission_notes) VALUES ($1,$2,$3)`, [org.id, ownerUserId, input.submissionNotes ?? null]);
    await this.audit.record(tx, { action: 'ORG_REGISTERED', entityType: 'organization', entityId: org.id, organizationId: org.id, actorUserId: ownerUserId, summary: `${input.type} ${input.nameEn}` });
    await this.notifications.toAdmins(tx, { type: 'ORG_VERIFICATION_REQUESTED', data: { org: input.nameEn, type: input.type }, dedupeKey: `verify-request:${org.id}` });
    return org;
  }

  async profile(orgId: string, q: Queryable = this.db) {
    const org = await q.maybeOne<Record<string, unknown> & { type: string; timezone: string }>(
      `SELECT o.id, o.type, o.name_en, o.name_ar, o.legal_name, o.registration_number, o.license_number, o.tax_id, o.address_line,
              o.city_id, o.district_id, c.name_en AS city_name_en, c.name_ar AS city_name_ar, d.name_en AS district_name_en, d.name_ar AS district_name_ar,
              ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng, o.phone, o.email, o.timezone,
              o.verification_status, o.status, o.verified_at, o.suspension_reason, o.is_demo, o.created_at,
              CASE WHEN p.organization_id IS NOT NULL THEN json_build_object('is24h', p.is_24h, 'deliveryAvailable', p.delivery_available,
                'acceptsConfirmationRequests', p.accepts_confirmation_requests, 'acceptsHolds', p.accepts_holds,
                'pharmacistInCharge', p.pharmacist_in_charge, 'freshnessConfirmedMinutes', p.freshness_confirmed_minutes,
                'freshnessStaleMinutes', p.freshness_stale_minutes) END AS pharmacy,
              CASE WHEN w.organization_id IS NOT NULL THEN json_build_object('defaultLeadTimeHours', w.default_lead_time_hours,
                'minOrderValue', w.min_order_value, 'coldChainCapable', w.cold_chain_capable, 'distributionNotes', w.distribution_notes) END AS warehouse,
              (SELECT coalesce(json_agg(city_id), '[]') FROM warehouse_service_areas WHERE warehouse_org_id = o.id) AS service_city_ids
         FROM organizations o
         LEFT JOIN cities c ON c.id = o.city_id LEFT JOIN districts d ON d.id = o.district_id
         LEFT JOIN pharmacies p ON p.organization_id = o.id LEFT JOIN warehouses w ON w.organization_id = o.id
        WHERE o.id = $1`, [orgId]);
    if (!org) throw Errors.notFound('Organization');
    const hours = await q.query<OpeningHour>(`SELECT day_of_week, to_char(opens_at,'HH24:MI') AS opens_at, to_char(closes_at,'HH24:MI') AS closes_at FROM opening_hours WHERE organization_id = $1 ORDER BY day_of_week, opens_at`, [orgId]);
    const is24h = Boolean((org.pharmacy as { is24h?: boolean } | null)?.is24h);
    return { ...org, openingHours: hours, openNow: org.type === 'PHARMACY' ? isOpenNow(hours, is24h, org.timezone) : null };
  }

  async update(orgId: string, patch: z.infer<typeof ProfileUpdateSchema>, opts: { asAdmin?: boolean } = {}) {
    return this.db.tx(async (tx) => {
      const org = await tx.maybeOne<{ type: string; verificationStatus: string }>('SELECT type, verification_status FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      if (!org) throw Errors.notFound('Organization');
      if (!opts.asAdmin && org.verificationStatus === 'VERIFIED') {
        const locked = LOCKED_AFTER_VERIFICATION.filter((k) => patch[k] !== undefined);
        if (locked.length) throw Errors.forbidden(`These fields can only be changed by an administrator after verification: ${locked.join(', ')}`, 'FIELD_LOCKED');
      }
      const sets: string[] = [];
      const params: unknown[] = [orgId];
      for (const [k, col] of Object.entries(COLUMN)) {
        const v = (patch as Record<string, unknown>)[k];
        if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
      }
      if (patch.lat !== undefined && patch.lng !== undefined) {
        params.push(patch.lng, patch.lat);
        sets.push(`location = ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)::geography`);
      }
      if (sets.length) await tx.exec(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $1`, params);
      if (patch.pharmacy) {
        if (org.type !== 'PHARMACY') throw Errors.badRequest('pharmacy settings apply to pharmacies only');
        const p = patch.pharmacy;
        await tx.exec(
          `UPDATE pharmacies SET is_24h = coalesce($2, is_24h), delivery_available = coalesce($3, delivery_available),
                  accepts_confirmation_requests = coalesce($4, accepts_confirmation_requests), accepts_holds = coalesce($5, accepts_holds),
                  pharmacist_in_charge = CASE WHEN $6::boolean THEN $7 ELSE pharmacist_in_charge END
            WHERE organization_id = $1`,
          [orgId, p.is24h ?? null, p.deliveryAvailable ?? null, p.acceptsConfirmationRequests ?? null, p.acceptsHolds ?? null, p.pharmacistInCharge !== undefined, p.pharmacistInCharge ?? null]);
      }
      if (patch.warehouse) {
        if (org.type !== 'WAREHOUSE') throw Errors.badRequest('warehouse settings apply to warehouses only');
        const w = patch.warehouse;
        await tx.exec(
          `UPDATE warehouses SET default_lead_time_hours = coalesce($2, default_lead_time_hours),
                  min_order_value = CASE WHEN $3::boolean THEN $4::numeric ELSE min_order_value END,
                  cold_chain_capable = coalesce($5, cold_chain_capable),
                  distribution_notes = CASE WHEN $6::boolean THEN $7 ELSE distribution_notes END
            WHERE organization_id = $1`,
          [orgId, w.defaultLeadTimeHours ?? null, w.minOrderValue !== undefined, w.minOrderValue ?? null, w.coldChainCapable ?? null, w.distributionNotes !== undefined, w.distributionNotes ?? null]);
        if (w.serviceCityIds) {
          await tx.exec('DELETE FROM warehouse_service_areas WHERE warehouse_org_id = $1', [orgId]);
          for (const cityId of new Set(w.serviceCityIds)) await tx.exec('INSERT INTO warehouse_service_areas (warehouse_org_id, city_id) VALUES ($1,$2)', [orgId, cityId]);
        }
      }
      await this.audit.record(tx, { action: opts.asAdmin ? 'ORG_UPDATED_BY_ADMIN' : 'ORG_PROFILE_UPDATED', entityType: 'organization', entityId: orgId, organizationId: orgId, changes: patch as Record<string, unknown> });
      return this.profile(orgId, tx);
    });
  }

  async setOpeningHours(orgId: string, hours: z.infer<typeof OpeningHoursSchema>['hours']) {
    return this.db.tx(async (tx) => {
      await tx.exec('DELETE FROM opening_hours WHERE organization_id = $1', [orgId]);
      for (const h of hours) {
        await tx.exec('INSERT INTO opening_hours (organization_id, day_of_week, opens_at, closes_at) VALUES ($1,$2,$3,$4)', [orgId, h.dayOfWeek, h.opensAt, h.closesAt]);
      }
      await this.audit.record(tx, { action: 'OPENING_HOURS_UPDATED', entityType: 'organization', entityId: orgId, organizationId: orgId, changes: { hours } });
      return { hours };
    });
  }

  members(orgId: string) {
    return this.db.query(
      `SELECT m.id, m.user_id, u.email, u.full_name, m.role, m.status, m.created_at FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.status = 'ACTIVE' ORDER BY m.created_at`, [orgId]);
  }

  async addMember(orgId: string, input: z.infer<typeof AddMemberSchema>) {
    return this.db.tx(async (tx) => {
      let user = await tx.maybeOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [input.email]);
      let created = false;
      if (!user) {
        if (!input.fullName || !input.initialPassword) {
          throw Errors.unprocessable('USER_NOT_FOUND', 'No account exists for this email; provide fullName and initialPassword to create one');
        }
        user = await tx.one<{ id: string }>(`INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`,
          [input.email, await argon2.hash(input.initialPassword, { type: argon2.argon2id }), input.fullName]);
        await tx.exec('INSERT INTO notification_preferences (user_id) VALUES ($1)', [user.id]);
        created = true;
      }
      await tx.exec(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'ACTIVE'`, [orgId, user.id, input.role]);
      await this.audit.record(tx, { action: 'MEMBER_ADDED', entityType: 'organization_member', entityId: user.id, organizationId: orgId, changes: { email: input.email, role: input.role, accountCreated: created } });
      return { userId: user.id, role: input.role, accountCreated: created };
    });
  }

  async updateMember(orgId: string, memberUserId: string, role: OrgRole | 'REMOVE') {
    return this.db.tx(async (tx) => {
      const owners = await tx.query<{ userId: string }>(`SELECT user_id FROM organization_members WHERE organization_id = $1 AND role = 'ORG_OWNER' AND status = 'ACTIVE' FOR UPDATE`, [orgId]);
      const target = await tx.maybeOne<{ role: string }>(`SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`, [orgId, memberUserId]);
      if (!target) throw Errors.notFound('Member');
      if (target.role === 'ORG_OWNER' && role !== 'ORG_OWNER' && owners.length <= 1) {
        throw Errors.conflict('LAST_OWNER', 'An organization must keep at least one owner');
      }
      if (role === 'REMOVE') {
        await tx.exec(`UPDATE organization_members SET status = 'REMOVED' WHERE organization_id = $1 AND user_id = $2`, [orgId, memberUserId]);
      } else {
        await tx.exec(`UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2`, [orgId, memberUserId, role]);
      }
      await this.audit.record(tx, { action: role === 'REMOVE' ? 'MEMBER_REMOVED' : 'MEMBER_ROLE_CHANGED', entityType: 'organization_member', entityId: memberUserId, organizationId: orgId, changes: { from: target.role, to: role } });
      return { userId: memberUserId, role };
    });
  }

  /** Public, patient-facing pharmacy profile: only verified & active pharmacies are visible. */
  async publicPharmacy(orgId: string) {
    const p = (await this.profile(orgId).catch(() => null)) as Record<string, unknown> | null;
    if (!p || p.type !== 'PHARMACY' || p.verificationStatus !== 'VERIFIED' || p.status !== 'ACTIVE') throw Errors.notFound('Pharmacy');
    const ph = p.pharmacy as Record<string, unknown>;
    return {
      id: p.id, nameEn: p.nameEn, nameAr: p.nameAr, addressLine: p.addressLine, cityNameEn: p.cityNameEn, cityNameAr: p.cityNameAr,
      districtNameEn: p.districtNameEn, districtNameAr: p.districtNameAr, lat: p.lat, lng: p.lng, phone: p.phone,
      is24h: ph.is24h, deliveryAvailable: ph.deliveryAvailable, acceptsConfirmationRequests: ph.acceptsConfirmationRequests,
      openingHours: p.openingHours, openNow: p.openNow, verified: true, isDemo: p.isDemo,
    };
  }
}
