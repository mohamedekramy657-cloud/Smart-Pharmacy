import { permissionsForRole, roleHasPermission, ORG_PERMISSIONS, READ_ONLY_PERMISSIONS } from '../../src/common/auth/permissions';
import { decryptSecret, encryptSecret, stableStringify } from '../../src/common/crypto';
import { isOpenNow } from '../../src/common/time';
import { loadConfig } from '../../src/config/config';
import { identityKey } from '../../src/modules/catalog/catalog.service';
import { classifyListing, freshnessTier, FreshnessSettings, quantityBucket, rankGroup } from '../../src/modules/inventory/freshness';
import { parseCsv } from '../../src/modules/inventory/import.service';
import { backoffMs } from '../../src/modules/jobs/jobs.service';
import { base32Decode, base32Encode, totp, verifyTotp } from '../../src/modules/auth/totp';
import { assertTransition, canTransition, deliveryDateStatus, PO_TRANSITIONS, SHIPMENT_TRANSITIONS } from '../../src/modules/supply/state-machines';
import { DEFAULT_SETTINGS } from '../../src/database/default-settings';
import { SETTINGS_SCHEMA } from '../../src/common/settings.service';

const windows = DEFAULT_SETTINGS['freshness.bySource'] as FreshnessSettings;
const now = new Date('2026-10-26T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60000);
const listing = (over: Partial<Parameters<typeof classifyListing>[0]> = {}) => ({
  availableQty: 10, lowStockThreshold: 3, lastUpdatedAt: minutesAgo(30), lastUpdateSource: 'MANUAL' as const,
  isListed: true, availabilityOverride: null, integrationHealth: null, ...over,
});

describe('freshness & availability classification', () => {
  it('classifies by source-aware freshness windows', () => {
    expect(freshnessTier(listing({ lastUpdatedAt: minutesAgo(700) }), windows, now).tier).toBe('CONFIRMED'); // manual: 12 h
    expect(freshnessTier(listing({ lastUpdatedAt: minutesAgo(800) }), windows, now).tier).toBe('RECENT_UNCONFIRMED');
    expect(freshnessTier(listing({ lastUpdatedAt: minutesAgo(4400) }), windows, now).tier).toBe('STALE'); // > 72 h
    expect(freshnessTier(listing({ lastUpdateSource: 'INTEGRATION', lastUpdatedAt: minutesAgo(150) }), windows, now).tier).toBe('RECENT_UNCONFIRMED'); // integration: 2 h
    expect(freshnessTier(listing({ lastUpdateSource: 'CSV_IMPORT', lastUpdatedAt: minutesAgo(1400) }), windows, now).tier).toBe('CONFIRMED'); // csv: 24 h
  });

  it('never shows a failing or stale integration as confirmed', () => {
    for (const health of ['FAILING', 'STALE']) {
      expect(freshnessTier(listing({ lastUpdateSource: 'INTEGRATION', lastUpdatedAt: minutesAgo(5), integrationHealth: health }), windows, now).tier).toBe('RECENT_UNCONFIRMED');
    }
    expect(freshnessTier(listing({ lastUpdateSource: 'INTEGRATION', lastUpdatedAt: minutesAgo(5), integrationHealth: 'HEALTHY' }), windows, now).tier).toBe('CONFIRMED');
  });

  it('honours per-pharmacy freshness overrides', () => {
    expect(freshnessTier(listing({ lastUpdatedAt: minutesAgo(90), pharmacyConfirmedMinutes: 60, pharmacyStaleMinutes: 120 }), windows, now).tier).toBe('RECENT_UNCONFIRMED');
    expect(freshnessTier(listing({ lastUpdatedAt: minutesAgo(130), pharmacyConfirmedMinutes: 60, pharmacyStaleMinutes: 120 }), windows, now).tier).toBe('STALE');
  });

  it('distinguishes availability statuses (insufficient, low, stale, unavailable)', () => {
    expect(classifyListing(listing(), 1, windows, now).status).toBe('AVAILABLE');
    expect(classifyListing(listing({ availableQty: 3 }), 1, windows, now).status).toBe('LOW_STOCK');
    expect(classifyListing(listing({ availableQty: 4 }), 5, windows, now).status).toBe('INSUFFICIENT_QUANTITY');
    expect(classifyListing(listing({ availableQty: 0 }), 1, windows, now).status).toBe('OUT_OF_STOCK');
    expect(classifyListing(listing({ lastUpdatedAt: minutesAgo(5000) }), 1, windows, now).status).toBe('STALE');
    expect(classifyListing(listing({ availabilityOverride: 'TEMPORARILY_UNAVAILABLE' }), 1, windows, now).status).toBe('TEMPORARILY_UNAVAILABLE');
    expect(classifyListing(listing({ isListed: false }), 1, windows, now).status).toBe('TEMPORARILY_UNAVAILABLE');
    expect(classifyListing(listing({ lastUpdatedAt: minutesAgo(800) }), 1, windows, now).status).toBe('RECENT_UNCONFIRMED');
  });

  it('ranks confirmed above unconfirmed above insufficient; stale/out-of-stock are not ranked', () => {
    expect(rankGroup('AVAILABLE')).toBe(0);
    expect(rankGroup('LOW_STOCK')).toBe(0);
    expect(rankGroup('RECENT_UNCONFIRMED')).toBe(1);
    expect(rankGroup('INSUFFICIENT_QUANTITY')).toBe(2);
    expect(rankGroup('STALE')).toBeNull();
    expect(rankGroup('OUT_OF_STOCK')).toBeNull();
  });

  it('discloses quantity as buckets', () => {
    expect(quantityBucket(0, 5)).toBe('NONE');
    expect(quantityBucket(5, 5)).toBe('LIMITED');
    expect(quantityBucket(6, 5)).toBe('PLENTY');
    expect(quantityBucket(2, null)).toBe('LIMITED');
  });
});

describe('state machines', () => {
  it('accepts valid and rejects invalid purchase order transitions', () => {
    expect(canTransition(PO_TRANSITIONS, 'SUBMITTED', 'CONFIRMED')).toBe(true);
    expect(canTransition(PO_TRANSITIONS, 'SUBMITTED', 'PARTIALLY_CONFIRMED')).toBe(true);
    expect(canTransition(PO_TRANSITIONS, 'DRAFT', 'CONFIRMED')).toBe(false);
    expect(canTransition(PO_TRANSITIONS, 'IN_FULFILLMENT', 'CANCELLED')).toBe(false); // no cancel after dispatch
    expect(canTransition(PO_TRANSITIONS, 'DELIVERED', 'CANCELLED')).toBe(false);
    expect(() => assertTransition(PO_TRANSITIONS, 'REJECTED', 'CONFIRMED', 'Purchase order')).toThrow(/cannot move from REJECTED to CONFIRMED/);
  });

  it('only allows receipt outcomes after dispatch', () => {
    expect(canTransition(SHIPMENT_TRANSITIONS, 'DRAFT', 'DELIVERED')).toBe(false);
    expect(canTransition(SHIPMENT_TRANSITIONS, 'IN_TRANSIT', 'PARTIALLY_DELIVERED')).toBe(true);
    expect(canTransition(SHIPMENT_TRANSITIONS, 'DELIVERED', 'IN_TRANSIT')).toBe(false);
    expect(canTransition(SHIPMENT_TRANSITIONS, 'DISPATCHED', 'CANCELLED')).toBe(false);
  });

  it('labels delivery dates consistently (overdue => DELAYED, missing => pending/unknown)', () => {
    const n = new Date('2026-10-26T12:00:00Z');
    expect(deliveryDateStatus({ status: 'IN_TRANSIT', estimatedDeliveryAt: '2026-10-27T12:00:00Z', scheduleConfidence: 'CONFIRMED' }, n)).toBe('CONFIRMED');
    expect(deliveryDateStatus({ status: 'IN_TRANSIT', estimatedDeliveryAt: '2026-10-25T12:00:00Z', scheduleConfidence: 'CONFIRMED' }, n)).toBe('DELAYED');
    expect(deliveryDateStatus({ status: 'DELAYED', estimatedDeliveryAt: '2026-10-28T12:00:00Z', scheduleConfidence: 'ESTIMATED' }, n)).toBe('DELAYED');
    expect(deliveryDateStatus({ status: 'DRAFT', estimatedDeliveryAt: null, scheduleConfidence: 'PENDING_CONFIRMATION' }, n)).toBe('PENDING_CONFIRMATION');
    expect(deliveryDateStatus({ status: 'DISPATCHED', estimatedDeliveryAt: null, scheduleConfidence: 'UNKNOWN' }, n)).toBe('UNKNOWN');
  });
});

describe('authorization matrix', () => {
  it('viewers are read-only; staff cannot order or manage; only owners manage members', () => {
    for (const p of Object.keys(ORG_PERMISSIONS) as Array<keyof typeof ORG_PERMISSIONS>) {
      if (!READ_ONLY_PERMISSIONS.has(p)) expect(roleHasPermission('ORG_VIEWER', p)).toBe(false);
    }
    expect(roleHasPermission('ORG_STAFF', 'inventory:write')).toBe(true);
    expect(roleHasPermission('ORG_STAFF', 'supply:receive')).toBe(true);
    expect(roleHasPermission('ORG_STAFF', 'supply:order')).toBe(false);
    expect(roleHasPermission('ORG_STAFF', 'inventory:price')).toBe(false);
    expect(roleHasPermission('ORG_MANAGER', 'members:manage')).toBe(false);
    expect(permissionsForRole('ORG_OWNER')).toHaveLength(Object.keys(ORG_PERMISSIONS).length);
  });
});

describe('security primitives', () => {
  it('TOTP matches the RFC 6238 SHA-1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totp(secret, 59_000, 30, 8)).toBe('94287082');
    expect(totp(secret, 1111111109_000, 30, 8)).toBe('07081804');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    const code = totp(secret, Date.now());
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, totp(secret, Date.now() - 10 * 60_000))).toBe(false); // outside drift window
  });

  it('encrypts secrets with authenticated encryption', () => {
    const enc = encryptSecret('whsec_example');
    expect(enc).not.toContain('whsec_example');
    expect(decryptSecret(enc)).toBe('whsec_example');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('rejects unsafe production configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/Unsafe production configuration/);
    expect(() => loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('hashes requests deterministically regardless of key order', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});

describe('domain helpers', () => {
  it('open-now handles overnight ranges, 24h pharmacies and unknown hours', () => {
    const hours = [{ dayOfWeek: 1, opensAt: '18:00', closesAt: '02:00' }]; // Monday evening to Tuesday 02:00
    expect(isOpenNow(hours, false, 'Africa/Cairo', new Date('2026-10-26T20:00:00Z'))).toBe(true); // Mon 23:00 Cairo
    expect(isOpenNow(hours, false, 'Africa/Cairo', new Date('2026-10-26T22:30:00Z'))).toBe(true); // Tue 01:30 Cairo
    expect(isOpenNow(hours, false, 'Africa/Cairo', new Date('2026-10-27T01:00:00Z'))).toBe(false); // Tue 04:00
    expect(isOpenNow([], true, 'Africa/Cairo')).toBe(true);
    expect(isOpenNow([], false, 'Africa/Cairo')).toBeNull();
  });

  it('medicine identity differs by strength/form/package, not by name casing', () => {
    const base = { brandNameEn: 'Augmentin', dosageForm: 'FILM_COATED_TABLET' as const, route: 'ORAL' as const, packageSize: 14, packageUnit: 'TABLET' as const, manufacturer: 'GSK',
      ingredients: [{ nameEn: 'Amoxicillin', strengthValue: 875, strengthUnit: 'MG' as const }, { nameEn: 'Clavulanic acid', strengthValue: 125, strengthUnit: 'MG' as const }] };
    const k1 = identityKey(base);
    expect(identityKey({ ...base, brandNameEn: 'AUGMENTIN', ingredients: [...base.ingredients].reverse() })).toBe(k1);
    expect(identityKey({ ...base, ingredients: [{ ...base.ingredients[0], strengthValue: 500 }, base.ingredients[1]] })).not.toBe(k1);
    expect(identityKey({ ...base, packageSize: 20 })).not.toBe(k1);
    expect(identityKey({ ...base, dosageForm: 'SUSPENSION' })).not.toBe(k1);
  });

  it('parses CSV with quotes, escaped quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n1,2')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(2500);
    expect(backoffMs(1)).toBeLessThanOrEqual(5000);
    expect(backoffMs(4)).toBeGreaterThanOrEqual(20000);
    expect(backoffMs(30)).toBeLessThanOrEqual(3_600_000);
  });

  it('default settings satisfy their validation schemas', () => {
    for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
      expect(schema.safeParse(DEFAULT_SETTINGS[key]).success).toBe(true);
    }
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(Object.keys(SETTINGS_SCHEMA).sort());
  });
});
