import type { FleetJobRecurEvery } from '@nigafiy/shared-types';

// When a recurring job runs next: wall-clock times in the job's IANA time zone (the site's zone by
// default), so "daily at 03:00" stays at 03:00 across daylight-saving changes. Pure and tested.

export interface Recurrence {
  every: FleetJobRecurEvery;
  /** "HH:MM"; for hourly only the minutes count. */
  time: string;
  /** weekly: 0 = Sunday … 6 = Saturday. */
  weekdays: number[] | null;
  /** monthly: 1–28 (every month has it). */
  monthday: number | null;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(at: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), hour: Number(get('hour')), minute: Number(get('minute')), weekday: WEEKDAY[get('weekday')] ?? 0 };
}

/** Offset of the zone from UTC at an instant, in minutes. */
function offsetMinutes(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/**
 * The instant of a wall-clock time in a zone. A time that does not exist (the hour skipped in
 * spring) moves forward by the gap; an ambiguous one (autumn) takes the first.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // The offsets in force around that day (both sides of a change), each giving one candidate.
  const offsets = new Set([-12, 0, 12].map((h) => offsetMinutes(new Date(guess + h * 3_600_000), tz)));
  const candidates = [...offsets].map((o) => guess - o * 60_000);
  const matching = candidates.filter((c) => {
    const p = localParts(new Date(c), tz);
    return p.day === day && p.hour === hour && p.minute === minute;
  });
  return new Date(matching.length ? Math.min(...matching) : Math.max(...candidates));
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(r: Recurrence, after: Date, tz: string): Date {
  const [hh, mm] = r.time.split(':').map(Number) as [number, number];
  if (r.every === 'hourly') {
    // Every hour at :mm (local minutes; zones with half-hour offsets keep their local minute).
    const base = new Date(Math.floor(after.getTime() / 60_000) * 60_000);
    for (let i = 0; i <= 120; i++) {
      const c = new Date(base.getTime() + i * 60_000);
      if (c > after && localParts(c, tz).minute === mm) return c;
    }
    return new Date(after.getTime() + 3_600_000);
  }
  const start = localParts(after, tz);
  // Walk local calendar days (at most ~13 months for monthly on any day).
  const day0 = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i <= 400; i++) {
    const d = new Date(day0 + i * 86_400_000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const dd = d.getUTCDate();
    const wd = d.getUTCDay();
    if (r.every === 'weekly' && !(r.weekdays ?? []).includes(wd)) continue;
    if (r.every === 'monthly' && dd !== (r.monthday ?? 1)) continue;
    const c = zonedTime(y, m, dd, hh, mm, tz);
    if (c > after) return c;
  }
  throw new Error('no next occurrence within 400 days');
}
