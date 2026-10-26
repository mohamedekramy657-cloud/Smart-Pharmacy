import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Errors } from '../../common/errors';
import { SettingsService } from '../../common/settings.service';
import { Database } from '../../database/db';
import { classifyListing, FreshnessSettings } from '../inventory/freshness';
import { NotificationsService } from '../notifications/notifications.service';

export const CreateAlertSchema = z.object({
  medicineId: z.uuid(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  cityId: z.number().int().positive().optional(),
  districtId: z.number().int().positive().optional(),
  areaLabel: z.string().trim().max(120).optional(),
  radiusKm: z.number().positive().max(100).default(10),
  minQty: z.number().int().min(1).max(100).default(1),
  channels: z.array(z.enum(['IN_APP', 'EMAIL', 'SMS'])).min(1).max(3).default(['IN_APP']),
}).strict().refine((v) => (v.lat === undefined) === (v.lng === undefined), 'lat and lng must be provided together')
  .refine((v) => v.lat !== undefined || v.cityId !== undefined || v.districtId !== undefined, 'A location is required');

@Injectable()
export class AlertsService {
  constructor(private readonly db: Database, private readonly settings: SettingsService, private readonly notifications: NotificationsService) {}

  async create(userId: string, input: z.infer<typeof CreateAlertSchema>) {
    const s = await this.settings.all();
    if (input.radiusKm > s['finder.maxRadiusKm']) throw Errors.unprocessable('RADIUS_TOO_LARGE', `Maximum alert radius is ${s['finder.maxRadiusKm']} km`);
    const med = await this.db.maybeOne<{ status: string }>('SELECT status FROM medicines WHERE id = $1', [input.medicineId]);
    if (!med) throw Errors.notFound('Medicine');
    if (med.status !== 'ACTIVE') throw Errors.unprocessable('MEDICINE_NOT_ACTIVE', 'Alerts cannot be created for this product');
    let lat = input.lat, lng = input.lng;
    if (lat === undefined) {
      const table = input.districtId !== undefined ? 'districts' : 'cities';
      const c = await this.db.maybeOne<{ lat: number; lng: number }>(`SELECT ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lng FROM ${table} WHERE id = $1`, [input.districtId ?? input.cityId]);
      if (!c) throw Errors.badRequest('Unknown area');
      ({ lat, lng } = c);
    }
    // Privacy: store a rounded location (~110 m), never the precise fix.
    const rLat = Math.round(lat! * 1000) / 1000;
    const rLng = Math.round(lng! * 1000) / 1000;
    return this.db.tx(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`alerts:${userId}`]);
      const active = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM availability_alerts WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
      if (active.n >= s['alerts.maxActivePerUser']) throw Errors.tooMany('Too many active alerts');
      return tx.one(
        `INSERT INTO availability_alerts (user_id, medicine_id, min_qty, location, radius_km, area_label, channels, expires_at)
         VALUES ($1,$2,$3, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6,$7,$8, now() + make_interval(days => $9))
         RETURNING id, medicine_id, min_qty, radius_km::float AS radius_km, area_label, channels, status, expires_at, created_at`,
        [userId, input.medicineId, input.minQty, rLng, rLat, input.radiusKm, input.areaLabel ?? null, input.channels, s['alerts.defaultExpiryDays']]);
    });
  }

  list(userId: string) {
    return this.db.query(
      `SELECT a.id, a.medicine_id, m.brand_name_en, m.brand_name_ar, m.strength, m.dosage_form, a.min_qty, a.radius_km::float AS radius_km, a.area_label,
              a.channels, a.status, a.last_triggered_at, a.trigger_count, a.expires_at, a.created_at
         FROM availability_alerts a JOIN medicines m ON m.id = a.medicine_id WHERE a.user_id = $1 AND a.status <> 'CANCELLED' ORDER BY a.created_at DESC`, [userId]);
  }

  async setStatus(userId: string, alertId: string, status: 'ACTIVE' | 'PAUSED' | 'CANCELLED') {
    const n = await this.db.exec(
      `UPDATE availability_alerts SET status = $3, expires_at = CASE WHEN $3 = 'ACTIVE' THEN greatest(expires_at, now() + interval '7 days') ELSE expires_at END
        WHERE id = $1 AND user_id = $2 AND status IN ('ACTIVE','TRIGGERED','PAUSED')`, [alertId, userId, status]);
    if (!n) throw Errors.notFound('Alert');
    return { id: alertId, status };
  }

  /** Job: stock increased at a pharmacy -> notify matching alerts (one-shot until re-armed). */
  async matchItem(itemId: string): Promise<number> {
    const windows = (await this.settings.get('freshness.bySource')) as FreshnessSettings;
    const item = await this.db.maybeOne<{ medicineId: string; organizationId: string; pharmacyName: string; medicine: string; availableQty: number; lowStockThreshold: number | null;
      lastUpdatedAt: Date; lastUpdateSource: never; isListed: boolean; availabilityOverride: string | null; integrationHealth: string | null; medicineStatus: string }>(
      `SELECT i.medicine_id, i.organization_id, o.name_en AS pharmacy_name, m.brand_name_en || ' ' || m.strength AS medicine, i.available_qty, i.low_stock_threshold,
              i.last_updated_at, i.last_update_source, i.is_listed, i.availability_override, ic.health AS integration_health, m.status AS medicine_status
         FROM inventory_items i JOIN organizations o ON o.id = i.organization_id JOIN medicines m ON m.id = i.medicine_id
         LEFT JOIN integration_configs ic ON ic.id = i.integration_config_id
        WHERE i.id = $1 AND o.type = 'PHARMACY' AND o.verification_status = 'VERIFIED' AND o.status = 'ACTIVE'`, [itemId]);
    if (!item || item.medicineStatus !== 'ACTIVE') return 0;
    const cls = classifyListing(item, 1, windows);
    if (cls.status !== 'AVAILABLE' && cls.status !== 'LOW_STOCK') return 0; // only fresh, confirmed stock triggers alerts
    return this.db.tx(async (tx) => {
      const alerts = await tx.query<{ id: string; userId: string; distanceM: number; channels: string[] }>(
        `SELECT a.id, a.user_id, a.channels, ST_Distance(a.location, o.location) AS distance_m
           FROM availability_alerts a, organizations o
          WHERE o.id = $2 AND a.medicine_id = $1 AND a.status = 'ACTIVE' AND a.expires_at > now() AND a.min_qty <= $3
            AND ST_DWithin(a.location, o.location, a.radius_km * 1000)
          FOR UPDATE OF a SKIP LOCKED`, [item.medicineId, item.organizationId, item.availableQty]);
      for (const a of alerts) {
        await this.notifications.toUser(tx, a.userId, {
          type: 'AVAILABILITY_ALERT', dedupeKey: `alert:${a.id}:${item.organizationId}:${new Date().toISOString().slice(0, 10)}`,
          data: { medicine: item.medicine, pharmacy: item.pharmacyName, distanceKm: (a.distanceM / 1000).toFixed(1), pharmacyId: item.organizationId, medicineId: item.medicineId },
          channels: a.channels.filter((c): c is 'EMAIL' | 'SMS' => c === 'EMAIL' || c === 'SMS'),
        });
        await tx.exec(`UPDATE availability_alerts SET status = 'TRIGGERED', last_triggered_at = now(), trigger_count = trigger_count + 1 WHERE id = $1`, [a.id]);
      }
      return alerts.length;
    });
  }
}
