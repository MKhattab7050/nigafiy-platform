import type { z } from 'zod';
import type { Db } from '../../infrastructure/db.ts';
import type { RuleLayer, scheduleSchema } from './policy.ts';

export interface SiteAccessRow extends RuleLayer {
  enabled: boolean;
  upstreams: string[];
  updated_at: string | null;
}

export interface ProfileRow extends RuleLayer {
  id: string;
  name: string;
  schedule: z.infer<typeof scheduleSchema>;
  paused_until: string | null;
}

export interface DeviceAccessRow {
  id: string;
  mac: string | null;
  ip: string | null;
  access_profile_id: string | null;
  internet_paused_until: string | null;
  access_blocked_domains: string[];
  access_allowed_domains: string[];
  access_schedule: z.infer<typeof scheduleSchema>;
}

/** The site-wide layer; a site that was never configured is "off" with empty lists. */
export async function siteAccess(db: Db, siteId: string): Promise<SiteAccessRow> {
  const row = (
    await db.query<SiteAccessRow>(
      `SELECT enabled, blocked_categories, blocked_domains, allowed_domains, upstreams, updated_at FROM site_access WHERE site_id = $1`,
      [siteId],
    )
  ).rows[0];
  return row ?? { enabled: false, blocked_categories: [], blocked_domains: [], allowed_domains: [], upstreams: [], updated_at: null };
}

/** The per-device layer of the rule stack (site → profile → device). */
export const deviceLayer = (d: DeviceAccessRow): RuleLayer => ({
  blocked_categories: [],
  blocked_domains: d.access_blocked_domains,
  allowed_domains: d.access_allowed_domains,
  schedule: d.access_schedule,
  paused_until: d.internet_paused_until,
});
