import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { Errors } from '../../common/errors';
import { SettingsService } from '../../common/settings.service';
import { isOpenNow, OpeningHour } from '../../common/time';
import { Database } from '../../database/db';
import { metrics } from '../health/metrics';
import { classifyListing, FreshnessSettings, quantityBucket, rankGroup } from '../inventory/freshness';
import { deliveryDateStatus } from '../supply/state-machines';

export const FinderSearchSchema = z.object({
  medicineId: z.uuid(),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  cityId: z.coerce.number().int().positive().optional(),
  districtId: z.coerce.number().int().positive().optional(),
  locationMethod: z.enum(['GPS', 'MAP_PIN', 'DISTRICT', 'CITY']).optional(),
  openNow: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  expandToMax: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  page: z.coerce.number().int().min(1).max(50).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).refine((v) => (v.lat === undefined) === (v.lng === undefined), 'lat and lng must be provided together')
  .refine((v) => v.lat !== undefined || v.cityId !== undefined || v.districtId !== undefined, 'Provide a location: coordinates, a district or a city');

export type FinderSearchInput = z.infer<typeof FinderSearchSchema>;
export type SearchOutcome = 'FOUND' | 'PARTIAL_QUANTITY_ONLY' | 'NO_MATCHING_STOCK' | 'NO_VERIFIED_STOCK' | 'INVENTORY_DATA_UNAVAILABLE'
  | 'PRODUCT_UNAVAILABLE' | 'NOT_PUBLICLY_LISTED';

const STALE_DISPLAY_MAX_DAYS = 30; // older listings are "unknown" and never shown

interface Candidate {
  pharmacyId: string; nameEn: string; nameAr: string | null; addressLine: string; phone: string | null; timezone: string;
  lat: number; lng: number; distanceM: number; cityNameEn: string | null; cityNameAr: string | null; districtNameEn: string | null; districtNameAr: string | null;
  is24h: boolean; deliveryAvailable: boolean; acceptsConfirmationRequests: boolean; isDemo: boolean;
  freshnessConfirmedMinutes: number | null; freshnessStaleMinutes: number | null;
  availableQty: number; lowStockThreshold: number | null; lastUpdatedAt: Date; lastUpdateSource: never; isListed: boolean;
  availabilityOverride: string | null; unitPrice: string | null; priceVerifiedAt: Date | null; integrationHealth: string | null;
  hours: Array<{ d: number; o: string; c: string }> | null;
}

@Injectable()
export class FinderService {
  private readonly logger = new Logger('Finder');
  constructor(private readonly db: Database, private readonly settings: SettingsService) {}

  private async resolveOrigin(input: FinderSearchInput): Promise<{ lat: number; lng: number; precision: 'EXACT' | 'DISTRICT' | 'CITY'; method: string }> {
    if (input.lat !== undefined && input.lng !== undefined) return { lat: input.lat, lng: input.lng, precision: 'EXACT', method: input.locationMethod ?? 'MAP_PIN' };
    if (input.districtId !== undefined) {
      const d = await this.db.maybeOne<{ lat: number; lng: number }>('SELECT ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lng FROM districts WHERE id = $1', [input.districtId]);
      if (!d) throw Errors.badRequest('Unknown district');
      return { ...d, precision: 'DISTRICT', method: 'DISTRICT' };
    }
    const c = await this.db.maybeOne<{ lat: number; lng: number }>('SELECT ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lng FROM cities WHERE id = $1', [input.cityId]);
    if (!c) throw Errors.badRequest('Unknown city');
    return { ...c, precision: 'CITY', method: 'CITY' };
  }

  async search(input: FinderSearchInput) {
    const started = Date.now();
    const s = await this.settings.all();
    const medicine = await this.db.maybeOne<{ id: string; status: string; statusReason: string | null; prescriptionClass: string } & Record<string, unknown>>(
      `SELECT id, brand_name_en, brand_name_ar, generic_name_en, generic_name_ar, strength, concentration, dosage_form, route, package_size::float AS package_size,
              package_unit, manufacturer, prescription_class, status, status_reason, category FROM medicines WHERE id = $1`, [input.medicineId]);
    if (!medicine) throw Errors.notFound('Medicine');
    const origin = await this.resolveOrigin(input);
    const radii = [...s['finder.radiiKm'].filter((r) => r <= s['finder.maxRadiusKm'])];
    if (!radii.length || radii[radii.length - 1] < s['finder.maxRadiusKm']) radii.push(s['finder.maxRadiusKm']);
    const maxKm = radii[radii.length - 1];
    const base = { medicine, origin: { lat: origin.lat, lng: origin.lng, precision: origin.precision }, radiiKm: radii, requestedQty: input.quantity };

    if (medicine.status !== 'ACTIVE') {
      return this.finish(started, input, origin, { ...base, outcome: 'PRODUCT_UNAVAILABLE' as SearchOutcome, productStatus: medicine.status, productStatusReason: medicine.statusReason, results: [], stale: [], incoming: [], total: 0, matchedRadiusKm: null, searchedRadiusKm: null });
    }
    if (medicine.prescriptionClass === 'CONTROLLED' && !s['finder.includeControlled']) {
      return this.finish(started, input, origin, { ...base, outcome: 'NOT_PUBLICLY_LISTED' as SearchOutcome, results: [], stale: [], incoming: [], total: 0, matchedRadiusKm: null, searchedRadiusKm: null });
    }

    // ONE indexed spatial query bounded by the maximum radius and a candidate limit.
    const candidates = await this.db.query<Candidate>(
      `SELECT o.id AS pharmacy_id, o.name_en, o.name_ar, o.address_line, o.phone, o.timezone, o.is_demo,
              ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng,
              ST_Distance(o.location, g.origin) AS distance_m,
              c.name_en AS city_name_en, c.name_ar AS city_name_ar, d.name_en AS district_name_en, d.name_ar AS district_name_ar,
              p.is_24h, p.delivery_available, p.accepts_confirmation_requests, p.freshness_confirmed_minutes, p.freshness_stale_minutes,
              i.available_qty, i.low_stock_threshold, i.last_updated_at, i.last_update_source, i.is_listed, i.availability_override,
              i.unit_price, i.price_verified_at, ic.health AS integration_health,
              (SELECT json_agg(json_build_object('d', oh.day_of_week, 'o', to_char(oh.opens_at,'HH24:MI'), 'c', to_char(oh.closes_at,'HH24:MI')))
                 FROM opening_hours oh WHERE oh.organization_id = o.id) AS hours
         FROM (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS origin) g
         JOIN organizations o ON ST_DWithin(o.location, g.origin, $4)
         JOIN pharmacies p ON p.organization_id = o.id
         JOIN inventory_items i ON i.organization_id = o.id AND i.medicine_id = $1
         LEFT JOIN integration_configs ic ON ic.id = i.integration_config_id
         LEFT JOIN cities c ON c.id = o.city_id LEFT JOIN districts d ON d.id = o.district_id
        WHERE o.type = 'PHARMACY' AND o.verification_status = 'VERIFIED' AND o.status = 'ACTIVE'
          AND i.is_listed AND i.availability_override IS NULL AND i.available_qty > 0
          AND i.last_updated_at > now() - make_interval(days => $5)
        ORDER BY distance_m
        LIMIT $6`,
      [input.medicineId, origin.lng, origin.lat, maxKm * 1000, STALE_DISPLAY_MAX_DAYS, s['finder.maxCandidates']]);

    const windows = s['freshness.bySource'] as FreshnessSettings;
    const now = new Date();
    const enriched = candidates.map((c) => {
      const cls = classifyListing({ ...c, pharmacyConfirmedMinutes: c.freshnessConfirmedMinutes, pharmacyStaleMinutes: c.freshnessStaleMinutes }, input.quantity, windows, now);
      const hours: OpeningHour[] = (c.hours ?? []).map((h) => ({ dayOfWeek: h.d, opensAt: h.o, closesAt: h.c }));
      const distanceKm = Math.round((c.distanceM / 1000) * 10) / 10;
      return { c, cls, group: rankGroup(cls.status), openNow: isOpenNow(hours, c.is24h, c.timezone, now), distanceKm, band: radii.find((r) => c.distanceM <= r * 1000) ?? maxKm, hours };
    });
    const filtered = input.openNow ? enriched.filter((e) => e.openNow === true) : enriched;

    // Progressive radius bands: stop at the first band containing a qualifying listing (group 0/1).
    const qualifies = (e: (typeof enriched)[number]) => e.group === 0 || e.group === 1;
    const matchedRadiusKm = radii.find((r) => filtered.some((e) => qualifies(e) && e.c.distanceM <= r * 1000)) ?? null;
    const searchedRadiusKm = input.expandToMax || matchedRadiusKm === null ? maxKm : matchedRadiusKm;
    const inRange = filtered.filter((e) => e.c.distanceM <= searchedRadiusKm * 1000);
    const preferOpen = s['ranking.preferOpenNow'];
    const openRank = (o: boolean | null) => (o === true ? 0 : o === null ? 1 : 2);
    const ranked = inRange.filter((e) => e.group !== null).sort((a, b) =>
      a.group! - b.group! || (preferOpen ? openRank(a.openNow) - openRank(b.openNow) : 0) || a.c.distanceM - b.c.distanceM ||
      new Date(b.c.lastUpdatedAt).getTime() - new Date(a.c.lastUpdatedAt).getTime());
    const staleList = s['finder.showStaleSection'] ? inRange.filter((e) => e.cls.status === 'STALE').slice(0, 5) : [];

    let outcome: SearchOutcome;
    if (ranked.some(qualifies)) outcome = 'FOUND';
    else if (ranked.length) outcome = 'PARTIAL_QUANTITY_ONLY';
    else if (inRange.some((e) => e.cls.status === 'STALE')) outcome = 'INVENTORY_DATA_UNAVAILABLE';
    else {
      const unverified = await this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM organizations o JOIN inventory_items i ON i.organization_id = o.id AND i.medicine_id = $1
          WHERE o.type = 'PHARMACY' AND o.verification_status <> 'VERIFIED' AND o.status = 'ACTIVE' AND i.available_qty > 0
            AND ST_DWithin(o.location, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, $4)`, [input.medicineId, origin.lng, origin.lat, maxKm * 1000]);
      outcome = unverified.n > 0 ? 'NO_VERIFIED_STOCK' : 'NO_MATCHING_STOCK';
    }
    const coverage = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM organizations o WHERE o.type = 'PHARMACY' AND o.verification_status = 'VERIFIED' AND o.status = 'ACTIVE'
         AND ST_DWithin(o.location, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)`, [origin.lng, origin.lat, maxKm * 1000]);

    const showQty = s['finder.showExactQuantities'];
    const showPrices = s['finder.showPrices'];
    const toResult = (e: (typeof enriched)[number]) => ({
      pharmacy: {
        id: e.c.pharmacyId, nameEn: e.c.nameEn, nameAr: e.c.nameAr, addressLine: e.c.addressLine, phone: e.c.phone,
        cityNameEn: e.c.cityNameEn, cityNameAr: e.c.cityNameAr, districtNameEn: e.c.districtNameEn, districtNameAr: e.c.districtNameAr,
        lat: e.c.lat, lng: e.c.lng, verified: true, is24h: e.c.is24h, openNow: e.openNow, deliveryAvailable: e.c.deliveryAvailable,
        acceptsConfirmationRequests: e.c.acceptsConfirmationRequests, isDemo: e.c.isDemo,
      },
      distanceKm: e.distanceKm,
      bandKm: e.band,
      availability: {
        status: e.cls.status, freshness: e.cls.tier, lastUpdatedAt: e.c.lastUpdatedAt, ageMinutes: e.cls.ageMinutes, source: e.c.lastUpdateSource,
        quantity: showQty ? e.c.availableQty : null, quantityBucket: quantityBucket(e.c.availableQty, e.c.lowStockThreshold),
        sufficientForRequest: e.c.availableQty >= input.quantity,
      },
      price: showPrices && e.c.unitPrice && e.c.priceVerifiedAt ? { amount: e.c.unitPrice, currency: 'EGP', verifiedAt: e.c.priceVerifiedAt } : null,
      directions: {
        google: `https://www.google.com/maps/dir/?api=1&destination=${e.c.lat},${e.c.lng}`,
        osm: `https://www.openstreetmap.org/directions?to=${e.c.lat}%2C${e.c.lng}`,
      },
    });

    const incoming = await this.incoming(input.medicineId, origin, searchedRadiusKm);
    const start = (input.page - 1) * input.pageSize;
    return this.finish(started, input, origin, {
      ...base, outcome, matchedRadiusKm, searchedRadiusKm, total: ranked.length, page: input.page, pageSize: input.pageSize,
      results: ranked.slice(start, start + input.pageSize).map(toResult),
      stale: staleList.map(toResult),
      incoming,
      coverage: { verifiedPharmaciesWithinMaxRadius: coverage.n },
      candidateLimitReached: candidates.length >= s['finder.maxCandidates'],
      generatedAt: now.toISOString(),
      disclaimer: 'Availability is reported by pharmacies and may change. Call or request confirmation before travelling. Stock is not reserved.',
    });
  }

  /** Expected incoming stock (dispatched shipments), shown separately and never as current stock. */
  private async incoming(medicineId: string, origin: { lat: number; lng: number }, radiusKm: number) {
    const rows = await this.db.query<{ status: string; estimatedDeliveryAt: Date | null; scheduleConfidence: string; distanceM: number } & Record<string, unknown>>(
      `SELECT DISTINCT ON (o.id) o.id AS pharmacy_id, o.name_en, o.name_ar, o.phone, ST_Distance(o.location, g.origin) AS distance_m,
              s.status, s.estimated_delivery_at, s.schedule_confidence, s.schedule_updated_at
         FROM (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS origin) g
         JOIN organizations o ON ST_DWithin(o.location, g.origin, $4)
         JOIN shipments s ON s.pharmacy_org_id = o.id AND s.status IN ('DISPATCHED','IN_TRANSIT','DELAYED','ARRIVED')
         JOIN shipment_items si ON si.shipment_id = s.id AND si.medicine_id = $1
        WHERE o.type = 'PHARMACY' AND o.verification_status = 'VERIFIED' AND o.status = 'ACTIVE'
        ORDER BY o.id, s.estimated_delivery_at NULLS LAST LIMIT 50`,
      [medicineId, origin.lng, origin.lat, radiusKm * 1000]);
    return rows
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 5)
      .map(({ distanceM, ...r }) => ({ ...r, distanceKm: Math.round((distanceM / 1000) * 10) / 10, deliveryDateStatus: deliveryDateStatus(r), label: 'EXPECTED_INCOMING' }));
  }

  private async finish<T extends { outcome: SearchOutcome; results: unknown[]; matchedRadiusKm: number | null; searchedRadiusKm: number | null }>(
    started: number, input: FinderSearchInput, origin: { lat: number; lng: number; method: string }, body: T): Promise<T & { latencyMs: number }> {
    const latencyMs = Date.now() - started;
    metrics.searchDuration.observe({ outcome: body.outcome }, latencyMs / 1000);
    try {
      // Privacy: coarse ~1.1 km cell, no user id, no exact coordinates.
      await this.db.exec(
        `INSERT INTO search_events (medicine_id, requested_qty, outcome, matched_radius_km, searched_radius_km, result_count, confirmed_count, latency_ms, area_cell, location_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [input.medicineId, input.quantity, body.outcome, body.matchedRadiusKm, body.searchedRadiusKm, body.results.length,
         (body.results as Array<{ availability: { freshness: string } }>).filter((r) => r.availability.freshness === 'CONFIRMED').length,
         latencyMs, `${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}`, origin.method]);
    } catch (err) {
      this.logger.warn({ err }, 'failed to record search event');
    }
    return { ...body, latencyMs };
  }

  cities() {
    return this.db.query('SELECT id, governorate_en, governorate_ar, name_en, name_ar, ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lng FROM cities ORDER BY governorate_en, name_en');
  }

  districts(cityId: number) {
    return this.db.query('SELECT id, city_id, name_en, name_ar, ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lng FROM districts WHERE city_id = $1 ORDER BY name_en', [cityId]);
  }
}
