import { z } from 'zod';

/** IANA zone names only ("Africa/Cairo", "UTC", "Etc/GMT-3") — not offsets like "+02:00" that some runtimes also accept. */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** The zone's canonical spelling, or null when it is not a time zone this runtime knows. */
export function canonicalTimeZone(value: string): string | null {
  if (!IANA_NAME.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** A validated IANA time zone, stored in its canonical spelling ("africa/cairo" → "Africa/Cairo"). */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value, ctx) => {
    const tz = canonicalTimeZone(value);
    if (!tz) {
      ctx.addIssue({ code: 'custom', message: 'Not a known IANA time zone (example: Africa/Cairo, Europe/Berlin, UTC)' });
      return z.NEVER;
    }
    return tz;
  });

/** Zone for evaluating local times; a stored value this runtime does not know falls back to UTC instead of failing. */
export function safeTimeZone(value: string | null | undefined): string {
  return (value && canonicalTimeZone(value)) || 'UTC';
}
