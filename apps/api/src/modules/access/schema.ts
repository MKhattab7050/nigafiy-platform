import { z } from 'zod';
import { ACCESS_CATEGORIES, domainList, scheduleSchema } from './policy.ts';

export const siteQuery = z.object({ site_id: z.uuid() });

export const settingsBody = z
  .object({
    site_id: z.uuid(),
    enabled: z.boolean().optional(),
    blocked_categories: z.array(z.enum(ACCESS_CATEGORIES)).max(ACCESS_CATEGORIES.length).optional(),
    blocked_domains: domainList.optional(),
    allowed_domains: domainList.optional(),
    upstreams: z.array(z.ipv4()).max(4).optional(),
  })
  .strict();
export type SettingsBody = z.infer<typeof settingsBody>;

export const profileBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    blocked_categories: z.array(z.enum(ACCESS_CATEGORIES)).max(ACCESS_CATEGORIES.length).default([]),
    blocked_domains: domainList.default([]),
    allowed_domains: domainList.default([]),
    schedule: scheduleSchema.default([]),
  })
  .strict();
export const profilePatchBody = profileBody.partial();
export type ProfileBody = z.infer<typeof profileBody>;
export type ProfilePatchBody = z.infer<typeof profilePatchBody>;

/** minutes: pause the internet for that long; null: resume now. */
export const pauseBody = z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60).nullable() }).strict();

export function pauseUntil(minutes: number | null, now: Date): Date | null {
  return minutes === null ? null : new Date(now.getTime() + minutes * 60_000);
}

export const deviceAccessBody = z
  .object({
    profile_id: z.uuid().nullable().optional(),
    blocked_domains: domainList.optional(),
    allowed_domains: domainList.optional(),
    schedule: scheduleSchema.optional(),
  })
  .strict();
export type DeviceAccessBody = z.infer<typeof deviceAccessBody>;

export const activityQuery = z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) });
