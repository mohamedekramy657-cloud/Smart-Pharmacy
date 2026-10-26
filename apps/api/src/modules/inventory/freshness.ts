/**
 * Inventory freshness & availability classification (pure, deterministic, unit-tested).
 * See docs/06-search-and-freshness.md for the normative rules.
 */
export type UpdateSource = 'MANUAL' | 'BARCODE' | 'CSV_IMPORT' | 'INTEGRATION' | 'RECEIPT' | 'SYSTEM';
export type FreshnessTier = 'CONFIRMED' | 'RECENT_UNCONFIRMED' | 'STALE';
export type AvailabilityStatus =
  | 'AVAILABLE' | 'LOW_STOCK' | 'RECENT_UNCONFIRMED' | 'INSUFFICIENT_QUANTITY'
  | 'STALE' | 'OUT_OF_STOCK' | 'TEMPORARILY_UNAVAILABLE';

export interface FreshnessWindow { confirmedMinutes: number; staleMinutes: number }
export type FreshnessSettings = Record<UpdateSource, FreshnessWindow>;

export interface ListingFacts {
  availableQty: number;
  lowStockThreshold: number | null;
  lastUpdatedAt: Date | string;
  lastUpdateSource: UpdateSource;
  isListed: boolean;
  availabilityOverride: string | null;
  /** Health of the integration that feeds this line (null when manually maintained). */
  integrationHealth?: string | null;
  pharmacyConfirmedMinutes?: number | null;
  pharmacyStaleMinutes?: number | null;
}

export function freshnessTier(f: ListingFacts, settings: FreshnessSettings, now = new Date()): { tier: FreshnessTier; ageMinutes: number } {
  const window = settings[f.lastUpdateSource] ?? settings.MANUAL;
  const confirmed = f.pharmacyConfirmedMinutes ?? window.confirmedMinutes;
  const stale = f.pharmacyStaleMinutes ?? window.staleMinutes;
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - new Date(f.lastUpdatedAt).getTime()) / 60000));
  let tier: FreshnessTier = ageMinutes <= confirmed ? 'CONFIRMED' : ageMinutes <= stale ? 'RECENT_UNCONFIRMED' : 'STALE';
  // A failing/stale integration can never produce "confirmed" availability.
  if (tier === 'CONFIRMED' && f.lastUpdateSource === 'INTEGRATION' && (f.integrationHealth === 'FAILING' || f.integrationHealth === 'STALE')) {
    tier = 'RECENT_UNCONFIRMED';
  }
  return { tier, ageMinutes };
}

export function classifyListing(f: ListingFacts, requestedQty: number, settings: FreshnessSettings, now = new Date()): { status: AvailabilityStatus; tier: FreshnessTier; ageMinutes: number } {
  const { tier, ageMinutes } = freshnessTier(f, settings, now);
  let status: AvailabilityStatus;
  if (!f.isListed || f.availabilityOverride === 'TEMPORARILY_UNAVAILABLE') status = 'TEMPORARILY_UNAVAILABLE';
  else if (tier === 'STALE') status = 'STALE';
  else if (f.availableQty <= 0) status = 'OUT_OF_STOCK';
  else if (f.availableQty < requestedQty) status = 'INSUFFICIENT_QUANTITY';
  else if (tier === 'RECENT_UNCONFIRMED') status = 'RECENT_UNCONFIRMED';
  else if (f.lowStockThreshold !== null && f.availableQty <= f.lowStockThreshold) status = 'LOW_STOCK';
  else status = 'AVAILABLE';
  return { status, tier, ageMinutes };
}

/** Rank group used for ordering (lower is better). Non-listable statuses return null. */
export function rankGroup(status: AvailabilityStatus): number | null {
  switch (status) {
    case 'AVAILABLE':
    case 'LOW_STOCK': return 0;
    case 'RECENT_UNCONFIRMED': return 1;
    case 'INSUFFICIENT_QUANTITY': return 2;
    default: return null;
  }
}

/** Patient-facing quantity disclosure (exact counts only when enabled by configuration). */
export function quantityBucket(available: number, lowStockThreshold: number | null): 'PLENTY' | 'LIMITED' | 'NONE' {
  if (available <= 0) return 'NONE';
  if (lowStockThreshold !== null ? available <= lowStockThreshold : available <= 3) return 'LIMITED';
  return 'PLENTY';
}
