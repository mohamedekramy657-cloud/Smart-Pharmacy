import { Controller, Delete, Get, Headers, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthContext, CurrentAuth } from '../../common/auth/decorators';
import { UuidParam, ZBody, ZQuery } from '../../common/zod';
import { Database } from '../../database/db';
import { AlertsService, CreateAlertSchema } from './alerts.service';
import { CreateRequestSchema, RequestsService } from './requests.service';

const PrefsSchema = z.object({ inAppEnabled: z.boolean().optional(), emailEnabled: z.boolean().optional(), smsEnabled: z.boolean().optional(), preferredLocale: z.enum(['ar', 'en']).optional() }).strict();

/** Signed-in user's own resources. Every query is scoped by the session user id. */
@ApiTags('me')
@Controller('v1/me')
export class MeController {
  constructor(private readonly db: Database, private readonly requests: RequestsService, private readonly alerts: AlertsService) {}

  @Get('notifications')
  notifications(@CurrentAuth() auth: AuthContext, @ZQuery(z.object({ unreadOnly: z.enum(['true', 'false']).optional() })) q: { unreadOnly?: string }) {
    return this.db.query(
      `SELECT id, type, title, body, data, organization_id, read_at, created_at FROM notifications
        WHERE user_id = $1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL) ORDER BY created_at DESC LIMIT 100`, [auth.user.id, q.unreadOnly === 'true']);
  }

  @Get('notifications/unread-count')
  async unread(@CurrentAuth() auth: AuthContext) {
    return this.db.one('SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL', [auth.user.id]);
  }

  @Post('notifications/read')
  @HttpCode(200)
  async markRead(@CurrentAuth() auth: AuthContext, @ZBody(z.object({ ids: z.array(z.uuid()).max(200).optional(), all: z.boolean().optional() }).strict()) body: { ids?: string[]; all?: boolean }) {
    const n = await this.db.exec(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::boolean OR id = ANY($3::uuid[]))`,
      [auth.user.id, body.all === true, body.ids ?? []]);
    return { updated: n };
  }

  @Get('preferences')
  preferences(@CurrentAuth() auth: AuthContext) {
    return this.db.one(
      `SELECT coalesce(p.in_app_enabled, true) AS in_app_enabled, coalesce(p.email_enabled, false) AS email_enabled, coalesce(p.sms_enabled, false) AS sms_enabled, u.preferred_locale
         FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id WHERE u.id = $1`, [auth.user.id]);
  }

  @Patch('preferences')
  async updatePreferences(@CurrentAuth() auth: AuthContext, @ZBody(PrefsSchema) body: z.infer<typeof PrefsSchema>) {
    await this.db.tx(async (tx) => {
      await tx.exec(
        `INSERT INTO notification_preferences (user_id, in_app_enabled, email_enabled, sms_enabled) VALUES ($1, coalesce($2,true), coalesce($3,false), coalesce($4,false))
         ON CONFLICT (user_id) DO UPDATE SET in_app_enabled = coalesce($2, notification_preferences.in_app_enabled),
           email_enabled = coalesce($3, notification_preferences.email_enabled), sms_enabled = coalesce($4, notification_preferences.sms_enabled), updated_at = now()`,
        [auth.user.id, body.inAppEnabled ?? null, body.emailEnabled ?? null, body.smsEnabled ?? null]);
      if (body.preferredLocale) await tx.exec('UPDATE users SET preferred_locale = $2 WHERE id = $1', [auth.user.id, body.preferredLocale]);
    });
    return this.preferences(auth);
  }

  @Post('requests')
  createRequest(@CurrentAuth() auth: AuthContext, @ZBody(CreateRequestSchema) body: z.infer<typeof CreateRequestSchema>, @Headers('idempotency-key') idem?: string) {
    return this.requests.create(auth.user.id, body, idem);
  }

  @Get('requests')
  listRequests(@CurrentAuth() auth: AuthContext) {
    return this.requests.listForPatient(auth.user.id);
  }

  @Get('requests/:id')
  getRequest(@CurrentAuth() auth: AuthContext, @UuidParam('id') id: string) {
    return this.requests.getForPatient(this.db, auth.user.id, id);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  cancelRequest(@CurrentAuth() auth: AuthContext, @UuidParam('id') id: string) {
    return this.requests.cancelByPatient(auth.user.id, id);
  }

  @Post('alerts')
  createAlert(@CurrentAuth() auth: AuthContext, @ZBody(CreateAlertSchema) body: z.infer<typeof CreateAlertSchema>) {
    return this.alerts.create(auth.user.id, body);
  }

  @Get('alerts')
  listAlerts(@CurrentAuth() auth: AuthContext) {
    return this.alerts.list(auth.user.id);
  }

  @Patch('alerts/:id')
  updateAlert(@CurrentAuth() auth: AuthContext, @UuidParam('id') id: string, @ZBody(z.object({ status: z.enum(['ACTIVE', 'PAUSED']) }).strict()) body: { status: 'ACTIVE' | 'PAUSED' }) {
    return this.alerts.setStatus(auth.user.id, id, body.status);
  }

  @Delete('alerts/:id')
  deleteAlert(@CurrentAuth() auth: AuthContext, @UuidParam('id') id: string) {
    return this.alerts.setStatus(auth.user.id, id, 'CANCELLED');
  }
}
