import { safeTimeZone } from '../../common/timezone.ts';
import type { ScheduleTrigger } from './schema.ts';

/**
 * The schedule slot due at `now`, or null. A slot is an instant; its ISO string is the run's trigger
 * key, so the same slot can never start the playbook twice (UNIQUE (playbook_id, trigger_key)).
 *
 *  - every N minutes: slots are multiples of N minutes since the Unix epoch (UTC), so they do not drift
 *    with restarts.
 *  - daily at HH:MM: that wall-clock time in `timeZone` (the site's zone), today in that zone.
 *
 * A slot is due when it is not in the future, not before `notBefore` (when the playbook was enabled or
 * its trigger changed), and at most `graceMinutes` late — a slot missed while the server was down is
 * skipped, not run hours late.
 */
export function dueScheduleSlot(trigger: ScheduleTrigger, timeZone: string | null | undefined, now: Date, notBefore: Date, graceMinutes: number): Date | null {
  let slot: Date;
  if (trigger.every_minutes) {
    const period = trigger.every_minutes * 60_000;
    slot = new Date(Math.floor(now.getTime() / period) * period);
  } else if (trigger.daily_at) {
    slot = zonedToday(trigger.daily_at, safeTimeZone(trigger.timezone ?? timeZone), now);
    if (slot.getTime() > now.getTime()) return null;
  } else {
    return null;
  }
  if (slot.getTime() < notBefore.getTime()) return null;
  if (now.getTime() - slot.getTime() > graceMinutes * 60_000) return null;
  return slot;
}

/** Offset (ms) of `timeZone` from UTC at `at`. */
function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Today's (in `timeZone`) occurrence of the wall-clock time HH:MM, as an instant. */
export function zonedToday(hhmm: string, timeZone: string, now: Date): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const local = new Date(now.getTime() + zoneOffsetMs(timeZone, now));
  const wallAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m, 0);
  // Two passes handle a day on which the zone's offset changes (daylight saving).
  let instant = wallAsUtc - zoneOffsetMs(timeZone, new Date(wallAsUtc));
  instant = wallAsUtc - zoneOffsetMs(timeZone, new Date(instant));
  return new Date(instant);
}

/** The next slot after `now` (for display only). */
export function nextScheduleSlot(trigger: ScheduleTrigger, timeZone: string | null | undefined, now: Date): Date | null {
  if (trigger.every_minutes) {
    const period = trigger.every_minutes * 60_000;
    return new Date((Math.floor(now.getTime() / period) + 1) * period);
  }
  if (trigger.daily_at) {
    const tz = safeTimeZone(trigger.timezone ?? timeZone);
    const today = zonedToday(trigger.daily_at, tz, now);
    return today.getTime() > now.getTime() ? today : zonedToday(trigger.daily_at, tz, new Date(now.getTime() + 24 * 3600_000));
  }
  return null;
}
