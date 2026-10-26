import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { SessionService } from '../../common/auth/session.service';
import { Errors } from '../../common/errors';
import { zText } from '../../common/zod';
import { Database } from '../../database/db';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';

export const VerificationDecisionSchema = z.object({
  decision: z.enum(['VERIFIED', 'REJECTED']),
  notes: zText(1000).optional(),
}).strict().refine((v) => v.decision === 'VERIFIED' || (v.notes && v.notes.length >= 3), 'A reason is required when rejecting');

export const OrgStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']), reason: z.string().trim().min(3).max(500) }).strict();
export const UserStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3).max(500) }).strict();
export const AuditQuerySchema = z.object({
  organizationId: z.uuid().optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(80).optional(),
  action: z.string().max(80).optional(),
  actorUserId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export const OrgQuerySchema = z.object({
  type: z.enum(['PHARMACY', 'WAREHOUSE']).optional(),
  verificationStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@Injectable()
export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly sessions: SessionService,
    private readonly jobs: JobsService,
  ) {}

  async overview() {
    return this.db.one(
      `SELECT (SELECT count(*)::int FROM organizations WHERE type = 'PHARMACY' AND verification_status = 'VERIFIED' AND status = 'ACTIVE') AS active_pharmacies,
              (SELECT count(*)::int FROM organizations WHERE type = 'WAREHOUSE' AND verification_status = 'VERIFIED' AND status = 'ACTIVE') AS active_warehouses,
              (SELECT count(*)::int FROM verification_requests WHERE status = 'PENDING') AS pending_verifications,
              (SELECT count(*)::int FROM organizations WHERE status = 'SUSPENDED') AS suspended_organizations,
              (SELECT count(*)::int FROM users) AS users,
              (SELECT count(*)::int FROM medicines WHERE status = 'ACTIVE') AS active_medicines,
              (SELECT count(*)::int FROM medicines WHERE status = 'RECALLED') AS recalled_medicines,
              (SELECT count(*)::int FROM purchase_orders WHERE status IN ('SUBMITTED','CONFIRMED','PARTIALLY_CONFIRMED','IN_FULFILLMENT','PARTIALLY_DELIVERED')) AS open_purchase_orders,
              (SELECT count(*)::int FROM jobs WHERE status = 'DEAD') AS dead_jobs,
              (SELECT count(*)::int FROM jobs WHERE status IN ('PENDING','FAILED') AND run_at < now() - interval '5 minutes') AS delayed_jobs,
              (SELECT count(*)::int FROM integration_configs WHERE status = 'ACTIVE' AND health IN ('FAILING','STALE')) AS unhealthy_integrations,
              (SELECT count(*)::int FROM security_events WHERE occurred_at > now() - interval '24 hours' AND severity <> 'INFO') AS security_warnings_24h,
              (SELECT count(*)::int FROM search_events WHERE occurred_at > now() - interval '24 hours') AS searches_24h`);
  }

  verificationQueue() {
    return this.db.query(
      `SELECT v.id, v.status, v.submission_notes, v.submitted_at, o.id AS organization_id, o.type, o.name_en, o.name_ar, o.legal_name, o.license_number,
              o.registration_number, o.tax_id, o.address_line, o.phone, o.email, ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng,
              c.name_en AS city_name_en, u.email AS submitted_by_email, u.full_name AS submitted_by_name
         FROM verification_requests v JOIN organizations o ON o.id = v.organization_id LEFT JOIN cities c ON c.id = o.city_id
         LEFT JOIN users u ON u.id = v.submitted_by WHERE v.status = 'PENDING' ORDER BY v.submitted_at`);
  }

  async decideVerification(orgId: string, actorUserId: string, input: z.infer<typeof VerificationDecisionSchema>) {
    return this.db.tx(async (tx) => {
      const org = await tx.maybeOne<{ nameEn: string; verificationStatus: string }>('SELECT name_en, verification_status FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      if (!org) throw Errors.notFound('Organization');
      if (org.verificationStatus === input.decision) throw Errors.invalidState(`Organization is already ${input.decision}`);
      await tx.exec(
        `UPDATE organizations SET verification_status = $2, verified_at = CASE WHEN $2 = 'VERIFIED' THEN now() ELSE NULL END,
                verified_by = CASE WHEN $2 = 'VERIFIED' THEN $3::uuid ELSE NULL END WHERE id = $1`, [orgId, input.decision, actorUserId]);
      await tx.exec(`UPDATE verification_requests SET status = $2, reviewed_by = $3, reviewed_at = now(), decision_notes = $4 WHERE organization_id = $1 AND status = 'PENDING'`,
        [orgId, input.decision === 'VERIFIED' ? 'APPROVED' : 'REJECTED', actorUserId, input.notes ?? null]);
      await this.audit.record(tx, { action: `ORG_${input.decision}`, entityType: 'organization', entityId: orgId, organizationId: orgId, changes: { from: org.verificationStatus, to: input.decision, notes: input.notes } });
      await this.notifications.toOrg(tx, orgId, { type: 'ORG_VERIFICATION_DECIDED', dedupeKey: `verification:${orgId}:${input.decision}:${Date.now()}`, data: { org: org.nameEn, decision: input.decision, notes: input.notes ?? '' } }, ['ORG_OWNER', 'ORG_MANAGER']);
      return { id: orgId, verificationStatus: input.decision };
    });
  }

  async setOrgStatus(orgId: string, input: z.infer<typeof OrgStatusSchema>) {
    return this.db.tx(async (tx) => {
      const org = await tx.maybeOne<{ nameEn: string; status: string }>('SELECT name_en, status FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      if (!org) throw Errors.notFound('Organization');
      if (org.status === input.status) throw Errors.invalidState(`Organization is already ${input.status}`);
      await tx.exec(`UPDATE organizations SET status = $2, suspension_reason = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE $3 END,
                       suspended_at = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE now() END WHERE id = $1`, [orgId, input.status, input.reason]);
      await this.audit.record(tx, { action: 'ORG_STATUS_CHANGED', entityType: 'organization', entityId: orgId, organizationId: orgId, changes: { from: org.status, to: input.status, reason: input.reason } });
      await this.notifications.toOrg(tx, orgId, { type: 'ORG_STATUS_CHANGED', dedupeKey: `org-status:${orgId}:${input.status}:${Date.now()}`, data: { org: org.nameEn, status: input.status, reason: input.reason } });
      return { id: orgId, status: input.status };
    });
  }

  async organizations(f: z.infer<typeof OrgQuerySchema>) {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT o.id, o.type, o.name_en, o.name_ar, o.verification_status, o.status, o.license_number, o.phone, o.is_demo, o.created_at, c.name_en AS city_name_en,
              (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id AND m.status = 'ACTIVE') AS member_count,
              count(*) OVER()::int AS total
         FROM organizations o LEFT JOIN cities c ON c.id = o.city_id
        WHERE ($1::text IS NULL OR o.type = $1) AND ($2::text IS NULL OR o.verification_status = $2) AND ($3::text IS NULL OR o.status = $3)
          AND ($4::text IS NULL OR sp_normalize_text(o.name_en || ' ' || coalesce(o.name_ar,'')) LIKE '%' || sp_normalize_text($4) || '%')
        ORDER BY o.created_at DESC LIMIT $5 OFFSET $6`,
      [f.type ?? null, f.verificationStatus ?? null, f.status ?? null, f.q ?? null, f.pageSize, (f.page - 1) * f.pageSize]);
    return { items: rows, total: (rows[0]?.total as number) ?? 0, page: f.page, pageSize: f.pageSize };
  }

  async users(q: string | undefined, page: number, pageSize: number) {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT u.id, u.email, u.full_name, u.platform_role, u.status, u.mfa_enabled, u.last_login_at, u.created_at,
              (SELECT json_agg(json_build_object('organizationId', m.organization_id, 'role', m.role)) FROM organization_members m WHERE m.user_id = u.id AND m.status = 'ACTIVE') AS memberships,
              count(*) OVER()::int AS total
         FROM users u WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.full_name ILIKE '%' || $1 || '%')
        ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`, [q ?? null, pageSize, (page - 1) * pageSize]);
    return { items: rows, total: (rows[0]?.total as number) ?? 0, page, pageSize };
  }

  async setUserStatus(userId: string, actorUserId: string, input: z.infer<typeof UserStatusSchema>) {
    if (userId === actorUserId) throw Errors.badRequest('You cannot change your own account status');
    return this.db.tx(async (tx) => {
      const n = await tx.exec('UPDATE users SET status = $2 WHERE id = $1', [userId, input.status]);
      if (!n) throw Errors.notFound('User');
      if (input.status === 'SUSPENDED') await tx.exec(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'account_suspended' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await this.audit.record(tx, { action: 'USER_STATUS_CHANGED', entityType: 'user', entityId: userId, changes: input as Record<string, unknown> });
      return { id: userId, status: input.status };
    });
  }

  async auditLogs(f: z.infer<typeof AuditQuerySchema>) {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT a.id, a.occurred_at, a.actor_user_id, u.email AS actor_email, a.actor_type, a.organization_id, a.action, a.entity_type, a.entity_id, a.summary, a.changes, a.request_id,
              count(*) OVER()::int AS total
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::uuid IS NULL OR a.organization_id = $1) AND ($2::text IS NULL OR a.entity_type = $2) AND ($3::text IS NULL OR a.entity_id = $3)
          AND ($4::text IS NULL OR a.action = $4) AND ($5::uuid IS NULL OR a.actor_user_id = $5)
          AND ($6::timestamptz IS NULL OR a.occurred_at >= $6) AND ($7::timestamptz IS NULL OR a.occurred_at <= $7)
        ORDER BY a.id DESC LIMIT $8 OFFSET $9`,
      [f.organizationId ?? null, f.entityType ?? null, f.entityId ?? null, f.action ?? null, f.actorUserId ?? null, f.from ?? null, f.to ?? null, f.pageSize, (f.page - 1) * f.pageSize]);
    return { items: rows, total: (rows[0]?.total as number) ?? 0, page: f.page, pageSize: f.pageSize };
  }

  securityEvents(limit = 200) {
    return this.db.query('SELECT id, occurred_at, type, severity, user_id, path, details, request_id FROM security_events ORDER BY id DESC LIMIT $1', [limit]);
  }

  async jobsSummary() {
    const counts = await this.db.query('SELECT type, status, count(*)::int AS count FROM jobs GROUP BY type, status ORDER BY type, status');
    const dead = await this.db.query(`SELECT id, type, attempts, last_error, updated_at FROM jobs WHERE status = 'DEAD' ORDER BY updated_at DESC LIMIT 100`);
    return { counts, dead };
  }

  async retryJob(jobId: number) {
    if (!(await this.jobs.retryDead(jobId))) throw Errors.notFound('Dead job');
    await this.db.tx((tx) => this.audit.record(tx, { action: 'JOB_RETRIED', entityType: 'job', entityId: String(jobId) }));
    return { id: jobId, status: 'PENDING' };
  }

  integrationsHealth() {
    return this.db.query(
      `SELECT c.id, c.display_name, c.kind, c.status, c.health, c.last_success_at, c.last_failure_at, c.consecutive_failures, c.last_error,
              o.id AS organization_id, o.name_en AS organization_name, o.type AS organization_type
         FROM integration_configs c JOIN organizations o ON o.id = c.organization_id ORDER BY (c.health IN ('FAILING','STALE')) DESC, o.name_en`);
  }

  async ledgerCheck() {
    const mismatches = await this.db.query('SELECT * FROM sp_inventory_ledger_mismatches()');
    const negative = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM inventory_items WHERE available_qty < 0');
    return { checkedAt: new Date().toISOString(), mismatches, negativeAvailable: negative.n, ok: mismatches.length === 0 && negative.n === 0 };
  }

  revokeSessions(userId: string) {
    return this.sessions.revokeAllForUser(userId, 'revoked_by_admin');
  }
}
