import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { OrgContext } from '../../common/auth/decorators';
import { Errors } from '../../common/errors';
import { zText } from '../../common/zod';
import { Database } from '../../database/db';
import { NotificationsService } from '../notifications/notifications.service';

export const RelationshipRequestSchema = z.object({ warehouseOrgId: z.uuid(), notes: zText(500).optional() }).strict();
export const RelationshipDecisionSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'TERMINATED']),
  paymentTerms: zText(200).optional(),
  notes: zText(500).optional(),
}).strict();

@Injectable()
export class RelationshipsService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  /** Verified, active warehouses (directory for pharmacies), flagged if they serve the pharmacy's city. */
  async directory(org: OrgContext) {
    return this.db.query(
      `SELECT o.id, o.name_en, o.name_ar, o.phone, c.name_en AS city_name_en, c.name_ar AS city_name_ar,
              w.default_lead_time_hours, w.cold_chain_capable, w.min_order_value,
              EXISTS (SELECT 1 FROM warehouse_service_areas a WHERE a.warehouse_org_id = o.id AND a.city_id = me.city_id) AS serves_my_city,
              r.status AS relationship_status
         FROM organizations o JOIN warehouses w ON w.organization_id = o.id LEFT JOIN cities c ON c.id = o.city_id
         CROSS JOIN (SELECT city_id FROM organizations WHERE id = $1) me
         LEFT JOIN supply_relationships r ON r.warehouse_org_id = o.id AND r.pharmacy_org_id = $1
        WHERE o.type = 'WAREHOUSE' AND o.verification_status = 'VERIFIED' AND o.status = 'ACTIVE'
        ORDER BY serves_my_city DESC, o.name_en LIMIT 200`, [org.id]);
  }

  async list(org: OrgContext) {
    const mine = org.type === 'PHARMACY' ? 'r.pharmacy_org_id' : 'r.warehouse_org_id';
    const other = org.type === 'PHARMACY' ? 'r.warehouse_org_id' : 'r.pharmacy_org_id';
    return this.db.query(
      `SELECT r.id, r.status, r.payment_terms, r.notes, r.created_at, r.decided_at, o.id AS counterparty_id, o.name_en AS counterparty_name,
              o.name_ar AS counterparty_name_ar, o.phone AS counterparty_phone, o.verification_status AS counterparty_verification
         FROM supply_relationships r JOIN organizations o ON o.id = ${other} WHERE ${mine} = $1 ORDER BY r.status, o.name_en`, [org.id]);
  }

  async request(org: OrgContext, actorUserId: string, input: z.infer<typeof RelationshipRequestSchema>) {
    return this.db.tx(async (tx) => {
      const wh = await tx.maybeOne<{ type: string; verificationStatus: string; status: string }>('SELECT type, verification_status, status FROM organizations WHERE id = $1', [input.warehouseOrgId]);
      if (!wh || wh.type !== 'WAREHOUSE' || wh.verificationStatus !== 'VERIFIED' || wh.status !== 'ACTIVE') throw Errors.notFound('Warehouse');
      const existing = await tx.maybeOne<{ id: string; status: string }>('SELECT id, status FROM supply_relationships WHERE warehouse_org_id = $1 AND pharmacy_org_id = $2 FOR UPDATE', [input.warehouseOrgId, org.id]);
      let id: string;
      if (existing) {
        if (existing.status !== 'TERMINATED') throw Errors.conflict('RELATIONSHIP_EXISTS', `A relationship already exists (${existing.status})`);
        await tx.exec(`UPDATE supply_relationships SET status = 'PENDING', notes = $2, requested_by = $3, decided_by = NULL, decided_at = NULL WHERE id = $1`, [existing.id, input.notes ?? null, actorUserId]);
        id = existing.id;
      } else {
        id = (await tx.one<{ id: string }>(`INSERT INTO supply_relationships (warehouse_org_id, pharmacy_org_id, notes, requested_by) VALUES ($1,$2,$3,$4) RETURNING id`,
          [input.warehouseOrgId, org.id, input.notes ?? null, actorUserId])).id;
      }
      await this.audit.record(tx, { action: 'SUPPLY_RELATIONSHIP_REQUESTED', entityType: 'supply_relationship', entityId: id, organizationId: org.id });
      const ph = await tx.one<{ nameEn: string }>('SELECT name_en FROM organizations WHERE id = $1', [org.id]);
      await this.notifications.toOrg(tx, input.warehouseOrgId, { type: 'PO_SUBMITTED', dedupeKey: `rel-request:${id}:${Date.now()}`, data: { orderNumber: 'supply relationship request', pharmacy: ph.nameEn } }, ['ORG_OWNER', 'ORG_MANAGER']);
      return { id, status: 'PENDING' };
    });
  }

  async decide(org: OrgContext, actorUserId: string, relationshipId: string, input: z.infer<typeof RelationshipDecisionSchema>) {
    return this.db.tx(async (tx) => {
      const rel = await tx.maybeOne<{ id: string; status: string; pharmacyOrgId: string }>('SELECT id, status, pharmacy_org_id FROM supply_relationships WHERE id = $1 AND warehouse_org_id = $2 FOR UPDATE', [relationshipId, org.id]);
      if (!rel) throw Errors.notFound('Supply relationship');
      const allowed: Record<string, string[]> = { PENDING: ['ACTIVE', 'TERMINATED'], ACTIVE: ['SUSPENDED', 'TERMINATED'], SUSPENDED: ['ACTIVE', 'TERMINATED'], TERMINATED: [] };
      if (!allowed[rel.status].includes(input.status)) throw Errors.invalidState(`Relationship cannot move from ${rel.status} to ${input.status}`);
      await tx.exec('UPDATE supply_relationships SET status = $2, payment_terms = coalesce($3, payment_terms), notes = coalesce($4, notes), decided_by = $5, decided_at = now() WHERE id = $1',
        [rel.id, input.status, input.paymentTerms ?? null, input.notes ?? null, actorUserId]);
      await this.audit.record(tx, { action: 'SUPPLY_RELATIONSHIP_DECIDED', entityType: 'supply_relationship', entityId: rel.id, organizationId: org.id, changes: { from: rel.status, to: input.status } });
      const wh = await tx.one<{ nameEn: string }>('SELECT name_en FROM organizations WHERE id = $1', [org.id]);
      await this.notifications.toOrg(tx, rel.pharmacyOrgId, { type: 'ORG_STATUS_CHANGED', dedupeKey: `rel-decided:${rel.id}:${input.status}:${Date.now()}`, data: { org: `Supply relationship with ${wh.nameEn}`, status: input.status, reason: input.notes ?? '' } });
      return { id: rel.id, status: input.status };
    });
  }

  /** Products a pharmacy can order from a related warehouse (bucketed availability, wholesale price). */
  async warehouseProducts(org: OrgContext, warehouseOrgId: string, q?: string) {
    const rel = await this.db.maybeOne<{ status: string }>('SELECT status FROM supply_relationships WHERE pharmacy_org_id = $1 AND warehouse_org_id = $2', [org.id, warehouseOrgId]);
    if (!rel || rel.status !== 'ACTIVE') throw Errors.forbidden('No active supply relationship with this warehouse', 'NO_SUPPLY_RELATIONSHIP');
    return this.db.query(
      `SELECT m.id AS medicine_id, m.brand_name_en, m.brand_name_ar, m.generic_name_en, m.strength, m.dosage_form, m.package_size::float AS package_size,
              m.package_unit, m.manufacturer, i.unit_price, i.price_currency, i.last_updated_at,
              CASE WHEN i.available_qty <= 0 THEN 'OUT_OF_STOCK' WHEN i.low_stock_threshold IS NOT NULL AND i.available_qty <= i.low_stock_threshold THEN 'LIMITED' ELSE 'IN_STOCK' END AS availability
         FROM inventory_items i JOIN medicines m ON m.id = i.medicine_id
        WHERE i.organization_id = $1 AND i.is_listed AND m.status = 'ACTIVE'
          AND ($2::text IS NULL OR sp_normalize_text(m.brand_name_en || ' ' || m.generic_name_en || ' ' || coalesce(m.brand_name_ar,'')) LIKE '%' || sp_normalize_text($2) || '%')
        ORDER BY m.brand_name_en, m.strength LIMIT 200`, [warehouseOrgId, q ?? null]);
  }
}
