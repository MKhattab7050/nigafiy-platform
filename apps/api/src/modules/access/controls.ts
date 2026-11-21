import type { Db } from '../../infrastructure/db.ts';
import { siteAccess } from './repo.ts';

/**
 * The DNS-filter state of one device for GET /devices/:id/controls: whether filtering is on for its
 * site, whether the device is paused, its profile and own rules, and the pause action.
 */
export async function deviceAccessControl(db: Db, device: { id: string; site_id: string; mac: string | null; ip: string | null }, now: Date) {
  const site = await siteAccess(db, device.site_id);
  const row = (
    await db.query<{ paused_until: Date | null; profile_id: string | null; profile_name: string | null; profile_paused_until: Date | null; blocked: number; allowed: number; windows: number }>(
      `SELECT d.internet_paused_until AS paused_until, p.id AS profile_id, p.name AS profile_name, p.paused_until AS profile_paused_until,
              cardinality(d.access_blocked_domains) AS blocked, cardinality(d.access_allowed_domains) AS allowed, jsonb_array_length(d.access_schedule) AS windows
         FROM devices d LEFT JOIN access_profiles p ON p.id = d.access_profile_id WHERE d.id = $1`,
      [device.id],
    )
  ).rows[0]!;
  const collector = (
    await db.query<{ status: { listening?: boolean; error?: string } | null }>(
      `SELECT access_status AS status FROM collectors WHERE site_id = $1 AND status = 'active' ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1`,
      [device.site_id],
    )
  ).rows[0];
  const paused = Boolean(row.paused_until && row.paused_until > now) || Boolean(row.profile_paused_until && row.profile_paused_until > now);
  return {
    filter_enabled: site.enabled,
    filter_running: collector?.status ? Boolean(collector.status.listening) : null,
    paused,
    paused_until: row.paused_until && row.paused_until > now ? row.paused_until : null,
    profile: row.profile_id ? { id: row.profile_id, name: row.profile_name, paused_until: row.profile_paused_until } : null,
    own_rules: { blocked_domains: row.blocked, allowed_domains: row.allowed, schedule_windows: row.windows },
    // A device is recognised by MAC, or by IP when no MAC was observed.
    identifiable: Boolean(device.mac || device.ip),
    pause: site.enabled
      ? { possible: true, min_role: 'technician', method: 'POST', href: `/api/v1/devices/${device.id}/pause` }
      : { possible: false, reason: 'filter_off' },
    limits: 'DNS filtering does not stop a device that uses its own encrypted DNS, a VPN or a hard-coded resolver.',
  };
}
