import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Database, Queryable } from '../database/db';
import { AuditService } from './audit.service';
import { Errors } from './errors';

const freshnessWindow = z.object({ confirmedMinutes: z.number().int().min(5).max(43200), staleMinutes: z.number().int().min(10).max(129600) })
  .refine((w) => w.confirmedMinutes < w.staleMinutes, 'confirmedMinutes must be less than staleMinutes');
const SOURCES = ['INTEGRATION', 'MANUAL', 'BARCODE', 'RECEIPT', 'SYSTEM', 'CSV_IMPORT'] as const;

/** Every runtime-configurable business rule, with its validation schema. */
export const SETTINGS_SCHEMA = {
  'finder.radiiKm': z.array(z.number().positive().max(200)).min(1).max(8)
    .refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]), 'radii must be strictly ascending'),
  'finder.maxRadiusKm': z.number().positive().max(200),
  'finder.maxCandidates': z.number().int().min(20).max(2000),
  'finder.resultLimit': z.number().int().min(1).max(100),
  'finder.includeControlled': z.boolean(),
  'finder.showPrices': z.boolean(),
  'finder.showExactQuantities': z.boolean(),
  'finder.showStaleSection': z.boolean(),
  'ranking.preferOpenNow': z.boolean(),
  'freshness.bySource': z.object(Object.fromEntries(SOURCES.map((s) => [s, freshnessWindow])) as Record<(typeof SOURCES)[number], typeof freshnessWindow>),
  'requests.responseTimeoutMinutes': z.number().int().min(10).max(1440),
  'requests.maxPendingPerPatient': z.number().int().min(1).max(50),
  'holds.defaultMinutes': z.number().int().min(10).max(1440),
  'holds.maxMinutes': z.number().int().min(10).max(2880),
  'alerts.defaultExpiryDays': z.number().int().min(1).max(365),
  'alerts.maxActivePerUser': z.number().int().min(1).max(100),
  'receiving.quarantineOnReceipt': z.boolean(),
  'inventory.expiryAlertDays': z.number().int().min(1).max(365),
  'integrations.failingAfterFailures': z.number().int().min(1).max(100),
  'integrations.staleAfterIntervals': z.number().int().min(1).max(100),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMA)[K]> };

const CACHE_MS = 5_000; // short TTL: settings changes propagate across instances within seconds

@Injectable()
export class SettingsService {
  private cache?: { at: number; values: Settings };
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  async all(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.values;
    const rows = await this.db.query<{ key: string; value: unknown }>('SELECT key, value FROM system_settings');
    const values = {} as Record<string, unknown>;
    for (const key of Object.keys(SETTINGS_SCHEMA) as SettingKey[]) {
      const row = rows.find((r) => r.key === key);
      const parsed = SETTINGS_SCHEMA[key].safeParse(row?.value);
      if (!parsed.success) throw new Error(`System setting ${key} is missing or invalid`);
      values[key] = parsed.data;
    }
    this.cache = { at: Date.now(), values: values as Settings };
    return this.cache.values;
  }

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    return (await this.all())[key];
  }

  async list(): Promise<Array<{ key: string; value: unknown; description: string | null; updatedAt: Date }>> {
    return this.db.query('SELECT key, value, description, updated_at FROM system_settings ORDER BY key');
  }

  async update(key: string, value: unknown, actorUserId: string, tx?: Queryable): Promise<void> {
    if (!(key in SETTINGS_SCHEMA)) throw Errors.notFound('Setting');
    const parsed = SETTINGS_SCHEMA[key as SettingKey].safeParse(value);
    if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    if (key === 'finder.radiiKm' || key === 'finder.maxRadiusKm') {
      const current = await this.all();
      const radii = key === 'finder.radiiKm' ? (parsed.data as number[]) : current['finder.radiiKm'];
      const max = key === 'finder.maxRadiusKm' ? (parsed.data as number) : current['finder.maxRadiusKm'];
      if (radii[radii.length - 1] > max) throw Errors.unprocessable('INVALID_SETTING', 'The largest radius band cannot exceed finder.maxRadiusKm');
    }
    const run = async (q: Queryable) => {
      const before = await q.maybeOne<{ value: unknown }>('SELECT value FROM system_settings WHERE key = $1 FOR UPDATE', [key]);
      await q.exec('UPDATE system_settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1', [key, JSON.stringify(parsed.data), actorUserId]);
      await this.audit.record(q, { action: 'SETTING_UPDATED', entityType: 'system_setting', entityId: key, changes: { before: before?.value, after: parsed.data } });
    };
    if (tx) await run(tx); else await this.db.tx(run);
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
