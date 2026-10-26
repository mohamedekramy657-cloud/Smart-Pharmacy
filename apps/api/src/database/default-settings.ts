import type { Queryable } from './db';

/**
 * Default platform settings (mirrors the initial values inserted by migration 0005).
 * Used by tests to restore a known state and by the seed to ensure presence.
 */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'finder.radiiKm': [5, 10, 20, 40],
  'finder.maxRadiusKm': 40,
  'finder.maxCandidates': 300,
  'finder.resultLimit': 20,
  'finder.includeControlled': false,
  'finder.showPrices': false,
  'finder.showExactQuantities': false,
  'finder.showStaleSection': true,
  'ranking.preferOpenNow': true,
  'freshness.bySource': {
    INTEGRATION: { confirmedMinutes: 120, staleMinutes: 1440 },
    MANUAL: { confirmedMinutes: 720, staleMinutes: 4320 },
    BARCODE: { confirmedMinutes: 720, staleMinutes: 4320 },
    RECEIPT: { confirmedMinutes: 720, staleMinutes: 4320 },
    SYSTEM: { confirmedMinutes: 720, staleMinutes: 4320 },
    CSV_IMPORT: { confirmedMinutes: 1440, staleMinutes: 10080 },
  },
  'requests.responseTimeoutMinutes': 120,
  'requests.maxPendingPerPatient': 5,
  'holds.defaultMinutes': 60,
  'holds.maxMinutes': 240,
  'alerts.defaultExpiryDays': 30,
  'alerts.maxActivePerUser': 10,
  'receiving.quarantineOnReceipt': false,
  'inventory.expiryAlertDays': 60,
  'integrations.failingAfterFailures': 3,
  'integrations.staleAfterIntervals': 3,
};

export async function resetSettingsToDefaults(db: Queryable): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.exec(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = NULL, updated_at = now()`,
      [key, JSON.stringify(value)]);
  }
}
