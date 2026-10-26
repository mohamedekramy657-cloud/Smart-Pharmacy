export interface OpeningHour { dayOfWeek: number; opensAt: string; closesAt: string }

const toMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Local weekday (0=Sunday) and minutes since midnight in an IANA timezone. */
export function localClock(timeZone: string, now = new Date()): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/**
 * Open-now evaluation supporting overnight ranges (e.g. 18:00-02:00 belongs to the opening day)
 * and 24h pharmacies. Returns null when no hours are recorded (unknown, never assumed open).
 */
export function isOpenNow(hours: OpeningHour[], is24h: boolean, timeZone: string, now = new Date()): boolean | null {
  if (is24h) return true;
  if (!hours.length) return null;
  const { day, minutes } = localClock(timeZone, now);
  const prevDay = (day + 6) % 7;
  return hours.some((h) => {
    const open = toMinutes(h.opensAt);
    const close = toMinutes(h.closesAt);
    const overnight = close <= open;
    if (h.dayOfWeek === day) return overnight ? minutes >= open : minutes >= open && minutes < close;
    if (overnight && h.dayOfWeek === prevDay) return minutes < close;
    return false;
  });
}
