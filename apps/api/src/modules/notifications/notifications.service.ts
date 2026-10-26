import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { OrgRole } from '../../common/auth/permissions';
import { config } from '../../config/config';
import { Database, Queryable } from '../../database/db';
import { JobsService } from '../jobs/jobs.service';
import { render } from './templates';

export interface NotificationInput {
  type: string;
  data: Record<string, unknown>;
  dedupeKey?: string;
  organizationId?: string;
  channels?: Array<'EMAIL' | 'SMS'>;
}

/** Channel adapter contract. Real providers (SMTP/SES, SMS gateway) implement this. */
export interface MessageProvider {
  name: string;
  send(to: string, subject: string, body: string): Promise<{ delivered: boolean; info?: string }>;
}

/** DEVELOPMENT ONLY: writes the message to the server log. It does NOT deliver anything. */
class DevLogProvider implements MessageProvider {
  readonly name = 'dev-log';
  private readonly logger = new Logger('DevMessageLog');
  async send(to: string, subject: string): Promise<{ delivered: boolean; info?: string }> {
    this.logger.log({ toDomain: to.split('@')[1] ?? 'phone', subject }, '[DEV] message not delivered (dev-log provider)');
    return { delivered: false, info: 'dev-log provider: message logged, not delivered' };
  }
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly providers: Partial<Record<'EMAIL' | 'SMS', MessageProvider>> = {};

  constructor(private readonly db: Database, private readonly jobs: JobsService) {
    if (config().EMAIL_PROVIDER === 'dev-log') this.providers.EMAIL = new DevLogProvider();
    if (config().SMS_PROVIDER === 'dev-log') this.providers.SMS = new DevLogProvider();
  }

  onModuleInit(): void {
    this.jobs.register('notification.deliver', (p) => this.deliver(String(p.deliveryId)));
  }

  /** Creates an in-app notification (deduplicated per user) and queues external deliveries. */
  async toUser(tx: Queryable, userId: string, n: NotificationInput): Promise<boolean> {
    const user = await tx.maybeOne<{ preferredLocale: 'ar' | 'en'; inAppEnabled: boolean | null; emailEnabled: boolean | null; smsEnabled: boolean | null }>(
      `SELECT u.preferred_locale, p.in_app_enabled, p.email_enabled, p.sms_enabled
         FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id WHERE u.id = $1 AND u.status = 'ACTIVE'`,
      [userId],
    );
    if (!user) return false;
    const { title, body } = render(n.type, n.data, user.preferredLocale);
    const row = await tx.maybeOne<{ id: string }>(
      `INSERT INTO notifications (user_id, organization_id, type, title, body, data, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [userId, n.organizationId ?? null, n.type, title, body, JSON.stringify(n.data), n.dedupeKey ?? null],
    );
    if (!row) return false; // duplicate suppressed
    for (const channel of n.channels ?? []) {
      const allowed = channel === 'EMAIL' ? user.emailEnabled : user.smsEnabled;
      if (!allowed) continue;
      const d = await tx.one<{ id: string }>(
        `INSERT INTO notification_deliveries (notification_id, channel) VALUES ($1,$2) RETURNING id`, [row.id, channel]);
      await this.jobs.enqueue(tx, 'notification.deliver', { deliveryId: d.id }, { dedupeKey: `deliver:${d.id}` });
    }
    return true;
  }

  /** Fans out to active members of an organization (optionally only some roles). */
  async toOrg(tx: Queryable, organizationId: string, n: NotificationInput, roles?: OrgRole[]): Promise<number> {
    const members = await tx.query<{ userId: string }>(
      `SELECT m.user_id FROM organization_members m WHERE m.organization_id = $1 AND m.status = 'ACTIVE'
         AND ($2::text[] IS NULL OR m.role = ANY($2::text[]))`,
      [organizationId, roles ?? null],
    );
    let created = 0;
    for (const m of members) {
      if (await this.toUser(tx, m.userId, { ...n, organizationId })) created++;
    }
    return created;
  }

  async toAdmins(tx: Queryable, n: NotificationInput): Promise<void> {
    const admins = await tx.query<{ id: string }>(`SELECT id FROM users WHERE platform_role = 'SUPER_ADMIN' AND status = 'ACTIVE'`);
    for (const a of admins) await this.toUser(tx, a.id, n);
  }

  private async deliver(deliveryId: string): Promise<void> {
    const d = await this.db.maybeOne<{ id: string; channel: 'EMAIL' | 'SMS'; status: string; title: string; body: string; email: string; phone: string | null }>(
      `SELECT d.id, d.channel, d.status, n.title, n.body, u.email, u.phone
         FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id JOIN users u ON u.id = n.user_id
        WHERE d.id = $1`, [deliveryId]);
    if (!d || d.status !== 'PENDING') return; // idempotent: already handled
    const provider = this.providers[d.channel];
    const to = d.channel === 'EMAIL' ? d.email : d.phone;
    if (!provider || !to) {
      await this.db.exec(`UPDATE notification_deliveries SET status = 'SKIPPED', last_error = $2, attempts = attempts + 1 WHERE id = $1`,
        [d.id, !provider ? 'no provider configured for channel' : 'no destination address']);
      return;
    }
    try {
      const r = await provider.send(to, d.title, d.body);
      await this.db.exec(
        `UPDATE notification_deliveries SET status = $2, provider = $3, last_error = $4, attempts = attempts + 1, sent_at = CASE WHEN $2 = 'SENT' THEN now() END WHERE id = $1`,
        [d.id, r.delivered ? 'SENT' : 'SKIPPED', provider.name, r.info ?? null]);
    } catch (err) {
      await this.db.exec(`UPDATE notification_deliveries SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [d.id, (err as Error).message]);
      throw err; // job retries with backoff, then dead-letters
    }
  }
}
