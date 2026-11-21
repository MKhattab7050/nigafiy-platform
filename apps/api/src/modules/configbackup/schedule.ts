import { safeTimeZone } from '../../common/timezone.ts';

/** Milliseconds the zone's wall clock is ahead of UTC at instant `t`. */
function zoneOffsetMs(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(t / 1000) * 1000;
}

/** The local calendar date (y, m, d) of instant `t` in the zone. */
function localDate(t: number, timeZone: string): { y: number; m: number; d: number } {
  const local = new Date(t + zoneOffsetMs(t, timeZone));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() };
}

/** The UTC instant of local wall-clock time y-m-d hour:00 in the zone (DST-safe to the hour). */
function instantOf(y: number, m: number, d: number, hour: number, timeZone: string): number {
  const guess = Date.UTC(y, m, d, hour);
  let t = guess - zoneOffsetMs(guess, timeZone);
  t = guess - zoneOffsetMs(t, timeZone);
  return t;
}

/**
 * Next daily backup after `now`: `hour`:00 in the site's time zone, plus a stable per-device spread of
 * up to 30 minutes so that a site's devices do not all start in the same second.
 */
export function nextDailyRun(now: Date, timeZone: string | null | undefined, hour: number, spreadKey: string): Date {
  const tz = safeTimeZone(timeZone);
  let spread = 0;
  for (const ch of spreadKey) spread = (spread * 31 + ch.charCodeAt(0)) % 1800;
  const today = localDate(now.getTime(), tz);
  for (let add = 0; add < 3; add++) {
    const base = new Date(Date.UTC(today.y, today.m, today.d + add));
    const at = instantOf(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, tz) + spread * 1000;
    if (at > now.getTime()) return new Date(at);
  }
  return new Date(now.getTime() + 86_400_000);
}
