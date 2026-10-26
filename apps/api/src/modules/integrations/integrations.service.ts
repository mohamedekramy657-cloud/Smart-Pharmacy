import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { decryptSecret, encryptSecret, hmacHex, randomToken, safeEqual } from '../../common/crypto';
import { AppError, Errors } from '../../common/errors';
import { SecurityEventsService } from '../../common/security-events.service';
import { SettingsService } from '../../common/settings.service';
import { zText } from '../../common/zod';
import { Database } from '../../database/db';
import { LedgerService } from '../inventory/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';

export const CreateIntegrationSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  expectedIntervalMinutes: z.number().int().min(5).max(10080).default(60),
}).strict();

export const IntegrationStatusSchema = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']) }).strict();

export const WebhookPayloadSchema = z.object({
  eventId: z.string().min(1).max(128),
  type: z.literal('STOCK_SNAPSHOT'),
  occurredAt: z.iso.datetime({ offset: true }),
  items: z.array(z.object({
    medicineId: z.uuid().optional(),
    barcode: z.string().regex(/^[0-9]{8,14}$/).optional(),
    physicalQty: z.number().int().min(0).max(10_000_000),
  }).strict().refine((i) => i.medicineId || i.barcode, 'medicineId or barcode required')).min(1).max(1000),
  note: zText(200).optional(),
}).strict();

const SIGNATURE_WINDOW_SECONDS = 300;

/** Signature scheme documented for partners: hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)). */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return hmacHex(`${timestamp}.${rawBody}`, secret);
}

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  list(orgId: string) {
    return this.db.query(
      `SELECT id, kind, display_name, status, health, secret_last4, expected_interval_minutes, last_event_at, last_success_at, last_failure_at,
              consecutive_failures, last_error, created_at,
              (SELECT count(*)::int FROM inventory_items WHERE integration_config_id = c.id) AS linked_items
         FROM integration_configs c WHERE organization_id = $1 ORDER BY created_at`, [orgId]);
  }

  async create(orgId: string, actorUserId: string, input: z.infer<typeof CreateIntegrationSchema>) {
    const secret = `whsec_${randomToken(32)}`;
    return this.db.tx(async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO integration_configs (organization_id, kind, display_name, secret_enc, secret_last4, expected_interval_minutes, created_by)
         VALUES ($1,'INVENTORY_WEBHOOK',$2,$3,$4,$5,$6) RETURNING id`, [orgId, input.displayName, encryptSecret(secret), secret.slice(-4), input.expectedIntervalMinutes, actorUserId]);
      await this.audit.record(tx, { action: 'INTEGRATION_CREATED', entityType: 'integration_config', entityId: row.id, organizationId: orgId });
      // The secret is returned exactly once; only an encrypted copy is stored.
      return { id: row.id, secret, webhookPath: `/api/v1/integrations/webhooks/${row.id}`, signature: 'X-SP-Signature: hex(HMAC_SHA256(secret, X-SP-Timestamp + "." + rawBody))' };
    });
  }

  async rotateSecret(orgId: string, integrationId: string) {
    const secret = `whsec_${randomToken(32)}`;
    return this.db.tx(async (tx) => {
      const n = await tx.exec('UPDATE integration_configs SET secret_enc = $3, secret_last4 = $4 WHERE id = $1 AND organization_id = $2', [integrationId, orgId, encryptSecret(secret), secret.slice(-4)]);
      if (!n) throw Errors.notFound('Integration');
      await this.audit.record(tx, { action: 'INTEGRATION_SECRET_ROTATED', entityType: 'integration_config', entityId: integrationId, organizationId: orgId });
      return { id: integrationId, secret };
    });
  }

  async setStatus(orgId: string, integrationId: string, status: 'ACTIVE' | 'PAUSED' | 'DISABLED') {
    return this.db.tx(async (tx) => {
      const n = await tx.exec('UPDATE integration_configs SET status = $3 WHERE id = $1 AND organization_id = $2', [integrationId, orgId, status]);
      if (!n) throw Errors.notFound('Integration');
      await this.audit.record(tx, { action: 'INTEGRATION_STATUS_CHANGED', entityType: 'integration_config', entityId: integrationId, organizationId: orgId, changes: { status } });
      return { id: integrationId, status };
    });
  }

  events(orgId: string, integrationId: string) {
    return this.db.query(
      `SELECT e.id, e.external_event_id, e.event_type, e.occurred_at, e.received_at, e.status, e.result, e.last_error
         FROM integration_events e JOIN integration_configs c ON c.id = e.integration_config_id
        WHERE c.id = $1 AND c.organization_id = $2 ORDER BY e.received_at DESC LIMIT 100`, [integrationId, orgId]);
  }

  private async recordFailure(configId: string, error: string) {
    const threshold = await this.settings.get('integrations.failingAfterFailures');
    const row = await this.db.maybeOne<{ consecutiveFailures: number; health: string; organizationId: string; displayName: string }>(
      `UPDATE integration_configs SET consecutive_failures = consecutive_failures + 1, last_failure_at = now(), last_error = $2,
              health = CASE WHEN consecutive_failures + 1 >= $3 THEN 'FAILING' ELSE health END
        WHERE id = $1 RETURNING consecutive_failures, health, organization_id, display_name`, [configId, error.slice(0, 500), threshold]);
    if (row && row.health === 'FAILING' && row.consecutiveFailures === threshold) {
      await this.db.tx((tx) => this.notifications.toOrg(tx, row.organizationId, { type: 'INTEGRATION_FAILING', dedupeKey: `integration-failing:${configId}:${new Date().toISOString().slice(0, 13)}`, data: { name: row.displayName, health: 'FAILING' } }, ['ORG_OWNER', 'ORG_MANAGER']));
    }
  }

  /** Signed, idempotent stock snapshot webhook. Duplicate events are acknowledged and NOT re-applied. */
  async handleWebhook(integrationId: string, headers: { timestamp?: string; signature?: string }, rawBody: Buffer | undefined, body: unknown) {
    const cfg = await this.db.maybeOne<{ id: string; organizationId: string; status: string; secretEnc: string | null }>(
      'SELECT id, organization_id, status, secret_enc FROM integration_configs WHERE id = $1', [integrationId]);
    if (!cfg || !cfg.secretEnc) throw Errors.notFound('Integration');
    const ts = headers.timestamp ?? '';
    const sig = headers.signature ?? '';
    const tsNum = Number(ts);
    const raw = rawBody?.toString('utf8') ?? '';
    const expected = signWebhook(decryptSecret(cfg.secretEnc), ts, raw);
    if (!/^\d{10}$/.test(ts) || Math.abs(Date.now() / 1000 - tsNum) > SIGNATURE_WINDOW_SECONDS || !safeEqual(sig, expected)) {
      await this.security.record('WEBHOOK_SIGNATURE_INVALID', 'WARNING', { integrationId });
      await this.recordFailure(cfg.id, 'invalid signature or timestamp');
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature or timestamp');
    }
    if (cfg.status !== 'ACTIVE') throw new AppError(423, 'INTEGRATION_INACTIVE', `Integration is ${cfg.status}`);
    const parsed = WebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      await this.recordFailure(cfg.id, 'invalid payload');
      throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const p = parsed.data;
    const occurredAt = new Date(p.occurredAt);

    const outcome = await this.db.tx(async (tx) => {
      const ev = await tx.maybeOne<{ id: string }>(
        `INSERT INTO integration_events (integration_config_id, organization_id, external_event_id, event_type, occurred_at, payload, status, attempts)
         VALUES ($1,$2,$3,$4,$5,$6,'RECEIVED',1) ON CONFLICT (integration_config_id, external_event_id) DO NOTHING RETURNING id`,
        [cfg.id, cfg.organizationId, p.eventId, p.type, occurredAt, JSON.stringify(p)]);
      if (!ev) return { status: 'DUPLICATE' as const, eventId: p.eventId, applied: 0, skipped: 0, errors: [] as unknown[] };
      let applied = 0, skippedOlder = 0;
      const errors: Array<{ index: number; error: string }> = [];
      for (const [index, it] of p.items.entries()) {
        const med = await tx.maybeOne<{ id: string; status: string }>(
          it.medicineId ? 'SELECT id, status FROM medicines WHERE id = $1' : 'SELECT id, status FROM medicines WHERE barcode = $1', [it.medicineId ?? it.barcode]);
        if (!med) { errors.push({ index, error: 'unknown product' }); continue; }
        const { id: itemId } = await this.ledger.ensureItem(tx, cfg.organizationId, med.id);
        const cur = await tx.one<{ physicalQty: number; reservedQty: number; unavailableQty: number; lastExternalEventAt: Date | null }>(
          'SELECT physical_qty, reserved_qty, unavailable_qty, last_external_event_at FROM inventory_items WHERE id = $1 FOR UPDATE', [itemId]);
        if (cur.lastExternalEventAt && new Date(cur.lastExternalEventAt) >= occurredAt) { skippedOlder++; continue; } // out-of-order snapshot
        if (it.physicalQty < cur.reservedQty + cur.unavailableQty) { errors.push({ index, error: 'physicalQty below reserved + unavailable units' }); continue; }
        await this.ledger.apply(tx, { itemId, type: 'INTEGRATION_SYNC', physicalDelta: it.physicalQty - cur.physicalQty, source: 'INTEGRATION', referenceType: 'INTEGRATION_EVENT', referenceId: ev.id, idempotencyKey: `event:${ev.id}` });
        await tx.exec('UPDATE inventory_items SET last_external_event_at = $2, integration_config_id = $3 WHERE id = $1', [itemId, occurredAt, cfg.id]);
        applied++;
      }
      const status = errors.length ? (applied ? 'PARTIALLY_APPLIED' : 'FAILED') : 'PROCESSED';
      const result = { applied, skippedOlder, errors };
      await tx.exec('UPDATE integration_events SET status = $2, result = $3, processed_at = now() WHERE id = $1', [ev.id, status, JSON.stringify(result)]);
      await tx.exec(`UPDATE integration_configs SET last_event_at = now(), last_success_at = CASE WHEN $2 THEN now() ELSE last_success_at END,
                       consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures END, health = CASE WHEN $2 THEN 'HEALTHY' ELSE health END, last_error = $3 WHERE id = $1`,
        [cfg.id, applied > 0 || errors.length === 0, errors.length ? `${errors.length} item(s) rejected` : null]);
      return { status, eventId: p.eventId, applied, skipped: skippedOlder, errors };
    });
    return outcome;
  }

  /** Periodic: mark integrations STALE when expected updates stop arriving (sync service down). */
  async evaluateHealth(): Promise<number> {
    const intervals = await this.settings.get('integrations.staleAfterIntervals');
    const stale = await this.db.query<{ id: string; organizationId: string; displayName: string }>(
      `UPDATE integration_configs SET health = 'STALE'
        WHERE status = 'ACTIVE' AND health IN ('HEALTHY','UNKNOWN')
          AND coalesce(last_success_at, created_at) < now() - make_interval(mins => expected_interval_minutes * $1)
        RETURNING id, organization_id, display_name`, [intervals]);
    for (const c of stale) {
      await this.db.tx((tx) => this.notifications.toOrg(tx, c.organizationId, { type: 'INTEGRATION_FAILING', dedupeKey: `integration-stale:${c.id}:${new Date().toISOString().slice(0, 10)}`, data: { name: c.displayName, health: 'STALE' } }, ['ORG_OWNER', 'ORG_MANAGER']));
    }
    return stale.length;
  }
}
