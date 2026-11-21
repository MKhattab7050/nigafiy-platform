import type { Db } from '../../infrastructure/db.ts';
import { safeTimeZone } from '../../common/timezone.ts';
import { mergeRules } from './policy.ts';
import { type DeviceAccessRow, type ProfileRow, deviceLayer, siteAccess } from './repo.ts';

/** The policy delivered to the site's collector in every heartbeat. */
export async function buildAccessPolicy(db: Db, siteId: string, now: Date) {
  const site = await siteAccess(db, siteId);
  if (!site.enabled) return { enabled: false };
  const profiles = new Map(
    (
      await db.query<ProfileRow>(
        `SELECT id, name, blocked_categories, blocked_domains, allowed_domains, schedule, paused_until FROM access_profiles WHERE site_id = $1`,
        [siteId],
      )
    ).rows.map((p) => [p.id, p]),
  );
  const devices = (
    await db.query<DeviceAccessRow>(
      `SELECT id, primary_mac::text AS mac, host(current_ip) AS ip, access_profile_id, internet_paused_until,
              access_blocked_domains, access_allowed_domains, access_schedule
         FROM devices
        WHERE site_id = $1 AND (access_profile_id IS NOT NULL OR internet_paused_until > $2 OR access_blocked_domains <> '{}'
              OR access_allowed_domains <> '{}' OR access_schedule <> '[]'::jsonb)`,
      [siteId, now],
    )
  ).rows;
  const clients = devices
    .filter((d) => d.mac || d.ip)
    .map((d) => ({
      mac: d.mac ?? '',
      // A MAC identifies a device across IP changes; the IP is only a fallback when the MAC is unknown.
      ip: d.mac ? '' : (d.ip ?? ''),
      rule: mergeRules(now, site, d.access_profile_id ? profiles.get(d.access_profile_id) : null, deviceLayer(d)),
    }));
  const tz = (await db.query<{ timezone: string }>(`SELECT timezone FROM sites WHERE id = $1`, [siteId])).rows[0]?.timezone;
  return {
    enabled: true,
    // Schedules (bedtimes) are wall-clock times of the SITE, not of the collector host: the collector
    // must evaluate them in this IANA zone (the API evaluates them the same way, see internetOff()).
    timezone: safeTimeZone(tz),
    upstreams: site.upstreams,
    default: mergeRules(now, site),
    clients,
  };
}
