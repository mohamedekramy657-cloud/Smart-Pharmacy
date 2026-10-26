import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { OrgContext } from '../../common/auth/decorators';
import { randomCode, safeEqual } from '../../common/crypto';
import { Errors } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency.service';
import { SettingsService } from '../../common/settings.service';
import { zText } from '../../common/zod';
import { Database, Tx } from '../../database/db';
import { LedgerService } from '../inventory/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';

export const CreateRequestSchema = z.object({
  pharmacyOrgId: z.uuid(),
  medicineId: z.uuid(),
  quantity: z.number().int().min(1).max(100).default(1),
  wantsHold: z.boolean().default(false),
}).strict();

export const RespondSchema = z.object({
  outcome: z.enum(['CONFIRMED_AVAILABLE', 'NOT_AVAILABLE', 'HOLD']),
  holdMinutes: z.number().int().min(10).max(2880).optional(),
  note: zText(300).optional(),
}).strict();

export const FulfillHoldSchema = z.object({ pickupCode: z.string().trim().min(4).max(12) }).strict();

/**
 * Patient stock-confirmation requests and pharmacist-controlled holds. Patients never reserve
 * stock directly; a hold is created only by authorized pharmacy staff, atomically through the
 * ledger (reserved += qty), expires automatically and is fully audited.
 */
@Injectable()
export class RequestsService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(patientUserId: string, input: z.infer<typeof CreateRequestSchema>, idemKey?: string) {
    const s = await this.settings.all();
    return this.idem.execute(`request-create:${patientUserId}`, idemKey, input, async (tx) => {
      const ph = await tx.maybeOne<{ nameEn: string; acceptsConfirmationRequests: boolean; acceptsHolds: boolean }>(
        `SELECT o.name_en, p.accepts_confirmation_requests, p.accepts_holds FROM organizations o JOIN pharmacies p ON p.organization_id = o.id
          WHERE o.id = $1 AND o.verification_status = 'VERIFIED' AND o.status = 'ACTIVE'`, [input.pharmacyOrgId]);
      if (!ph) throw Errors.notFound('Pharmacy');
      if (!ph.acceptsConfirmationRequests) throw Errors.unprocessable('REQUESTS_NOT_ACCEPTED', 'This pharmacy does not accept online confirmation requests; please call instead');
      if (input.wantsHold && !ph.acceptsHolds) throw Errors.unprocessable('HOLDS_NOT_ACCEPTED', 'This pharmacy does not offer holds');
      const med = await tx.maybeOne<{ brandNameEn: string; strength: string; status: string; prescriptionClass: string }>('SELECT brand_name_en, strength, status, prescription_class FROM medicines WHERE id = $1', [input.medicineId]);
      if (!med) throw Errors.notFound('Medicine');
      if (med.status !== 'ACTIVE') throw Errors.unprocessable('MEDICINE_NOT_ACTIVE', 'This product is not currently available');
      if (med.prescriptionClass === 'CONTROLLED' && !s['finder.includeControlled']) throw Errors.unprocessable('NOT_PUBLICLY_LISTED', 'Requests are not available for this medicine');
      // Serialize per patient so the pending-request limit cannot be bypassed concurrently.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`patient-requests:${patientUserId}`]);
      const pending = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM stock_confirmation_requests WHERE patient_user_id = $1 AND status = 'PENDING' AND expires_at > now()`, [patientUserId]);
      if (pending.n >= s['requests.maxPendingPerPatient']) throw Errors.tooMany('Too many pending requests; wait for replies or cancel some');
      const dup = await tx.maybeOne(`SELECT 1 FROM stock_confirmation_requests WHERE patient_user_id = $1 AND pharmacy_org_id = $2 AND medicine_id = $3 AND status = 'PENDING' AND expires_at > now()`,
        [patientUserId, input.pharmacyOrgId, input.medicineId]);
      if (dup) throw Errors.conflict('DUPLICATE_REQUEST', 'You already have a pending request for this medicine at this pharmacy');
      const req = await tx.one<{ id: string; referenceCode: string }>(
        `INSERT INTO stock_confirmation_requests (reference_code, patient_user_id, pharmacy_org_id, medicine_id, requested_qty, wants_hold, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7)) RETURNING id, reference_code`,
        [`RQ-${randomCode(6)}`, patientUserId, input.pharmacyOrgId, input.medicineId, input.quantity, input.wantsHold, s['requests.responseTimeoutMinutes']]);
      await this.audit.record(tx, { action: 'CONFIRMATION_REQUEST_CREATED', entityType: 'stock_confirmation_request', entityId: req.id, organizationId: input.pharmacyOrgId });
      await this.notifications.toOrg(tx, input.pharmacyOrgId, { type: 'CONFIRMATION_REQUEST_NEW', dedupeKey: `request:${req.id}`, data: { code: req.referenceCode, qty: input.quantity, medicine: `${med.brandNameEn} ${med.strength}`, requestId: req.id } });
      return this.getForPatient(tx, patientUserId, req.id);
    });
  }

  async getForPatient(q: Tx | Database, patientUserId: string, requestId: string) {
    const r = await q.maybeOne(
      `SELECT r.id, r.reference_code, r.status, r.requested_qty, r.wants_hold, r.response_note, r.responded_at, r.expires_at, r.created_at,
              o.id AS pharmacy_id, o.name_en AS pharmacy_name, o.name_ar AS pharmacy_name_ar, o.phone AS pharmacy_phone,
              m.id AS medicine_id, m.brand_name_en, m.brand_name_ar, m.strength, m.dosage_form,
              res.expires_at AS hold_expires_at, res.status AS hold_status, CASE WHEN res.status = 'ACTIVE' THEN res.pickup_code END AS pickup_code
         FROM stock_confirmation_requests r JOIN organizations o ON o.id = r.pharmacy_org_id JOIN medicines m ON m.id = r.medicine_id
         LEFT JOIN stock_reservations res ON res.id = r.reservation_id
        WHERE r.id = $1 AND r.patient_user_id = $2`, [requestId, patientUserId]);
    if (!r) throw Errors.notFound('Request');
    return r;
  }

  listForPatient(patientUserId: string) {
    return this.db.query(
      `SELECT r.id, r.reference_code, r.status, r.requested_qty, r.wants_hold, r.response_note, r.responded_at, r.expires_at, r.created_at,
              o.name_en AS pharmacy_name, o.name_ar AS pharmacy_name_ar, o.phone AS pharmacy_phone, m.brand_name_en, m.brand_name_ar, m.strength, m.dosage_form,
              res.expires_at AS hold_expires_at, res.status AS hold_status, CASE WHEN res.status = 'ACTIVE' THEN res.pickup_code END AS pickup_code
         FROM stock_confirmation_requests r JOIN organizations o ON o.id = r.pharmacy_org_id JOIN medicines m ON m.id = r.medicine_id
         LEFT JOIN stock_reservations res ON res.id = r.reservation_id
        WHERE r.patient_user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [patientUserId]);
  }

  async cancelByPatient(patientUserId: string, requestId: string) {
    return this.db.tx(async (tx) => {
      const r = await tx.maybeOne<{ status: string; reservationId: string | null }>('SELECT status, reservation_id FROM stock_confirmation_requests WHERE id = $1 AND patient_user_id = $2 FOR UPDATE', [requestId, patientUserId]);
      if (!r) throw Errors.notFound('Request');
      if (!['PENDING', 'HELD', 'CONFIRMED_AVAILABLE'].includes(r.status)) throw Errors.invalidState(`Request is ${r.status}`);
      if (r.reservationId) await this.closeHold(tx, r.reservationId, 'CANCELLED', 'cancelled by patient', null);
      await tx.exec(`UPDATE stock_confirmation_requests SET status = 'CANCELLED' WHERE id = $1`, [requestId]);
      return { id: requestId, status: 'CANCELLED' };
    });
  }

  listForPharmacy(orgId: string, status?: string) {
    return this.db.query(
      `SELECT r.id, r.reference_code, r.status, r.requested_qty, r.wants_hold, r.response_note, r.responded_at, r.expires_at, r.created_at,
              m.id AS medicine_id, m.brand_name_en, m.brand_name_ar, m.strength, m.dosage_form,
              i.available_qty, i.last_updated_at AS stock_updated_at, res.id AS reservation_id, res.status AS hold_status, res.expires_at AS hold_expires_at
         FROM stock_confirmation_requests r JOIN medicines m ON m.id = r.medicine_id
         LEFT JOIN inventory_items i ON i.organization_id = r.pharmacy_org_id AND i.medicine_id = r.medicine_id
         LEFT JOIN stock_reservations res ON res.id = r.reservation_id
        WHERE r.pharmacy_org_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC LIMIT 200`, [orgId, status ?? null]);
  }

  async respond(org: OrgContext, actorUserId: string, requestId: string, input: z.infer<typeof RespondSchema>, idemKey?: string) {
    const s = await this.settings.all();
    return this.idem.execute(`request-respond:${requestId}`, idemKey, input, async (tx) => {
      const r = await tx.maybeOne<{ id: string; status: string; expiresAt: Date; wantsHold: boolean; requestedQty: number; medicineId: string; patientUserId: string; referenceCode: string }>(
        'SELECT * FROM stock_confirmation_requests WHERE id = $1 AND pharmacy_org_id = $2 FOR UPDATE', [requestId, org.id]);
      if (!r) throw Errors.notFound('Request');
      if (r.status !== 'PENDING' || new Date(r.expiresAt) <= new Date()) throw Errors.invalidState('This request is no longer pending');
      const meta = await tx.one<{ pharmacy: string; medicine: string; acceptsHolds: boolean }>(
        `SELECT o.name_en AS pharmacy, m.brand_name_en || ' ' || m.strength AS medicine, p.accepts_holds FROM organizations o JOIN pharmacies p ON p.organization_id = o.id, medicines m
          WHERE o.id = $1 AND m.id = $2`, [org.id, r.medicineId]);
      let reservationId: string | null = null;
      let until: Date | null = null;
      let pickupCode: string | null = null;
      let status = input.outcome as string;
      if (input.outcome === 'HOLD') {
        if (!r.wantsHold || !meta.acceptsHolds) throw Errors.unprocessable('HOLD_NOT_APPLICABLE', 'The patient did not ask for a hold or holds are disabled');
        const minutes = Math.min(input.holdMinutes ?? s['holds.defaultMinutes'], s['holds.maxMinutes']);
        const item = await tx.maybeOne<{ id: string }>('SELECT id FROM inventory_items WHERE organization_id = $1 AND medicine_id = $2', [org.id, r.medicineId]);
        if (!item) throw Errors.conflict('INSUFFICIENT_STOCK', 'This medicine is not in your inventory');
        pickupCode = randomCode(6);
        const res = await tx.one<{ id: string; expiresAt: Date }>(
          `INSERT INTO stock_reservations (inventory_item_id, organization_id, medicine_id, quantity, confirmation_request_id, pickup_code, expires_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7), $8) RETURNING id, expires_at`,
          [item.id, org.id, r.medicineId, r.requestedQty, r.id, pickupCode, minutes, actorUserId]);
        // Atomic: fails with INSUFFICIENT_STOCK if available < qty (e.g. another hold took the last units).
        await this.ledger.apply(tx, { itemId: item.id, type: 'HOLD_CREATE', reservedDelta: r.requestedQty, source: 'MANUAL', actorUserId, referenceType: 'RESERVATION', referenceId: res.id, idempotencyKey: `hold:${res.id}` });
        reservationId = res.id;
        until = res.expiresAt;
        status = 'HELD';
      }
      await tx.exec(`UPDATE stock_confirmation_requests SET status = $2, response_note = $3, responded_by = $4, responded_at = now(), reservation_id = $5 WHERE id = $1`,
        [r.id, status, input.note ?? null, actorUserId, reservationId]);
      await this.audit.record(tx, { action: 'CONFIRMATION_REQUEST_RESPONDED', entityType: 'stock_confirmation_request', entityId: r.id, organizationId: org.id, changes: { outcome: status, reservationId } });
      await this.notifications.toUser(tx, r.patientUserId, {
        type: 'CONFIRMATION_RESPONSE', dedupeKey: `request-response:${r.id}`,
        data: { outcome: status, pharmacy: meta.pharmacy, medicine: meta.medicine, qty: r.requestedQty, until: until ? new Date(until).toISOString() : null, pickupCode, requestId: r.id },
      });
      return { id: r.id, status, reservationId, holdExpiresAt: until };
    });
  }

  private async closeHold(tx: Tx, reservationId: string, to: 'FULFILLED' | 'CANCELLED' | 'EXPIRED', reason: string, actorUserId: string | null) {
    const res = await tx.maybeOne<{ id: string; status: string; inventoryItemId: string; quantity: number }>('SELECT id, status, inventory_item_id, quantity FROM stock_reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!res || res.status !== 'ACTIVE') return false;
    await this.ledger.apply(tx, {
      itemId: res.inventoryItemId, type: to === 'FULFILLED' ? 'HOLD_FULFILL' : 'HOLD_RELEASE',
      physicalDelta: to === 'FULFILLED' ? -res.quantity : 0, reservedDelta: -res.quantity,
      source: actorUserId ? 'MANUAL' : 'SYSTEM', actorUserId, referenceType: 'RESERVATION', referenceId: res.id, note: reason, idempotencyKey: `hold-close:${res.id}`,
    });
    await tx.exec('UPDATE stock_reservations SET status = $2, closed_at = now(), close_reason = $3 WHERE id = $1', [res.id, to, reason]);
    return true;
  }

  async fulfillHold(org: OrgContext, actorUserId: string, reservationId: string, pickupCode: string) {
    return this.db.tx(async (tx) => {
      const res = await tx.maybeOne<{ id: string; status: string; pickupCode: string; expiresAt: Date; confirmationRequestId: string | null }>(
        'SELECT id, status, pickup_code, expires_at, confirmation_request_id FROM stock_reservations WHERE id = $1 AND organization_id = $2 FOR UPDATE', [reservationId, org.id]);
      if (!res) throw Errors.notFound('Hold');
      if (res.status !== 'ACTIVE') throw Errors.invalidState(`Hold is ${res.status}`);
      if (!safeEqual(res.pickupCode, pickupCode.toUpperCase())) throw Errors.badRequest('Pickup code does not match');
      await this.closeHold(tx, res.id, 'FULFILLED', 'picked up by patient', actorUserId);
      await this.audit.record(tx, { action: 'HOLD_FULFILLED', entityType: 'stock_reservation', entityId: res.id, organizationId: org.id });
      return { id: res.id, status: 'FULFILLED' };
    });
  }

  async releaseHold(org: OrgContext, actorUserId: string, reservationId: string) {
    return this.db.tx(async (tx) => {
      const owned = await tx.maybeOne('SELECT 1 FROM stock_reservations WHERE id = $1 AND organization_id = $2', [reservationId, org.id]);
      if (!owned) throw Errors.notFound('Hold');
      if (!(await this.closeHold(tx, reservationId, 'CANCELLED', 'released by pharmacy', actorUserId))) throw Errors.invalidState('Hold is not active');
      await this.audit.record(tx, { action: 'HOLD_RELEASED', entityType: 'stock_reservation', entityId: reservationId, organizationId: org.id });
      return { id: reservationId, status: 'CANCELLED' };
    });
  }

  activeHolds(orgId: string) {
    return this.db.query(
      `SELECT res.id, res.quantity, res.status, res.expires_at, res.created_at, m.brand_name_en, m.strength, r.reference_code
         FROM stock_reservations res JOIN medicines m ON m.id = res.medicine_id LEFT JOIN stock_confirmation_requests r ON r.id = res.confirmation_request_id
        WHERE res.organization_id = $1 AND res.status = 'ACTIVE' ORDER BY res.expires_at`, [orgId]);
  }

  /** Periodic: expire holds (releasing stock) and unanswered requests. Safe to run concurrently. */
  async expireDue(): Promise<{ holds: number; requests: number }> {
    let holds = 0;
    const due = await this.db.query<{ id: string }>(`SELECT id FROM stock_reservations WHERE status = 'ACTIVE' AND expires_at <= now() ORDER BY expires_at LIMIT 200`);
    for (const d of due) {
      await this.db.tx(async (tx) => {
        if (await this.closeHold(tx, d.id, 'EXPIRED', 'hold expired', null)) {
          holds++;
          const info = await tx.maybeOne<{ patientUserId: string; pharmacy: string; medicine: string; requestId: string }>(
            `SELECT r.patient_user_id, o.name_en AS pharmacy, m.brand_name_en || ' ' || m.strength AS medicine, r.id AS request_id
               FROM stock_reservations res JOIN stock_confirmation_requests r ON r.id = res.confirmation_request_id
               JOIN organizations o ON o.id = res.organization_id JOIN medicines m ON m.id = res.medicine_id WHERE res.id = $1`, [d.id]);
          if (info) {
            await tx.exec(`UPDATE stock_confirmation_requests SET status = 'EXPIRED' WHERE id = $1 AND status = 'HELD'`, [info.requestId]);
            await this.notifications.toUser(tx, info.patientUserId, { type: 'HOLD_EXPIRED', dedupeKey: `hold-expired:${d.id}`, data: { pharmacy: info.pharmacy, medicine: info.medicine } });
          }
        }
      });
    }
    const expired = await this.db.tx(async (tx) => {
      const rows = await tx.query<{ id: string; patientUserId: string; referenceCode: string; medicine: string }>(
        `UPDATE stock_confirmation_requests r SET status = 'EXPIRED' FROM medicines m
          WHERE m.id = r.medicine_id AND r.status = 'PENDING' AND r.expires_at <= now()
          RETURNING r.id, r.patient_user_id, r.reference_code, m.brand_name_en || ' ' || m.strength AS medicine`);
      for (const r of rows) await this.notifications.toUser(tx, r.patientUserId, { type: 'REQUEST_EXPIRED', dedupeKey: `request-expired:${r.id}`, data: { code: r.referenceCode, medicine: r.medicine } });
      return rows.length;
    });
    return { holds, requests: expired };
  }
}
