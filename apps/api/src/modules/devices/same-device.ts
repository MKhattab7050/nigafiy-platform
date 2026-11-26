import type { Db } from '../../infrastructure/db.ts';

/**
 * "Is this the same device under another address?" — a device that comes back with a new private
 * (randomized) MAC, or a computer seen once on Wi-Fi and once on Ethernet, gets a new row because its
 * MAC differs. Inventory tools treat a shared name as a *suggestion*, never as proof on its own
 * (Palo Alto IoT "multi-interface devices", Tenable dedupe, runZero): two phones of the same model can
 * announce the same name. So the rule here is deliberately narrow:
 *   - the names match after normalizing ("DESKTOP-1.home" = "desktop-1");
 *   - the name is specific (not "android", "iphone", an address, ...);
 *   - the other device was NOT seen in the same sweep (two devices online together are two devices).
 * Evidence and confidence are always returned so the screen can say why.
 */

/** Names that many different devices announce: never evidence of identity. */
const GENERIC = new Set([
  'android', 'iphone', 'ipad', 'localhost', 'unknown', 'phone', 'tablet', 'laptop', 'pc', 'desktop', 'computer',
  'tv', 'smarttv', 'printer', 'camera', 'router', 'gateway', 'esp', 'espressif', 'esp32', 'esp8266', 'wlan0', 'eth0',
  'raspberrypi', 'ubuntu', 'debian', 'linux', 'windows', 'mac', 'macbook', 'macbook-pro', 'macbook-air', 'imac',
  'chromecast', 'amazon', 'echo', 'kindle', 'roku', 'xbox', 'playstation', 'galaxy', 'samsung', 'xiaomi', 'redmi',
  'huawei', 'oppo', 'vivo', 'realme', 'honor', 'nokia', 'device', 'client', 'host', 'none', 'null',
]);

/** "DESKTOP-U1QD285.home" → "desktop-u1qd285"; null when the name says nothing about identity. */
export function identityName(name: string | null | undefined): string | null {
  if (!name) return null;
  const first = name.trim().toLowerCase().split('.')[0]!.trim();
  if (first.length < 4) return null;
  if (/^[0-9a-f:-]+$/.test(first) && /\d/.test(first)) return null; // an address or bare hex
  if (/^\d+(-\d+){3}$/.test(first)) return null; // 192-168-1-5
  if (GENERIC.has(first)) return null;
  return first;
}

export interface SameNameDevice {
  id: string;
  label: string;
  ip: string | null;
  mac: string | null;
  mac_randomized: boolean;
  status: 'online' | 'offline' | 'unknown';
  trust: 'unreviewed' | 'known' | 'unwanted';
  display_name: string | null;
  owner: string | null;
  owner_source: 'name' | 'manual' | null;
  is_critical: boolean;
  alerts_muted: boolean;
  last_seen_at: Date;
}

/** Other devices of the site that announce the same specific name (newest first). */
export async function devicesWithSameName(db: Db, siteId: string, name: string | null, exceptIds: Iterable<string> = []): Promise<SameNameDevice[]> {
  const key = identityName(name);
  if (!key) return [];
  const rows = await db.query<SameNameDevice>(
    `SELECT id, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label, host(current_ip) AS ip,
            primary_mac::text AS mac, mac_randomized, status, trust, display_name, owner, owner_source, is_critical, alerts_muted, last_seen_at
       FROM devices
      WHERE site_id = $1 AND lower(split_part(hostname, '.', 1)) = $2 AND NOT (id = ANY($3::uuid[]))
      ORDER BY last_seen_at DESC LIMIT 5`,
    [siteId, key, [...exceptIds]],
  );
  return rows.rows;
}

/**
 * A device just created in a sweep: when a *known* device announcing the same specific name was not
 * seen in this sweep, the new one is that device under a new address. It inherits what the owner set
 * (known, its name, owner, importance, mute) so they are not asked again and no "new device" alarm is
 * raised. Returns the device it was matched to, or null.
 */
export async function inheritFromSameName(
  db: Db,
  site: string,
  deviceId: string,
  name: string | null,
  seenThisSweep: Set<string>,
): Promise<SameNameDevice | null> {
  const candidates = await devicesWithSameName(db, site, name, [deviceId]);
  if (candidates.some((c) => seenThisSweep.has(c.id) && c.status === 'online')) return null; // both here now: two devices
  const match = candidates.find((c) => c.trust === 'known' && !seenThisSweep.has(c.id));
  if (!match) return null;
  await db.query(
    `UPDATE devices SET trust = 'known', trust_reason = 'same_name', trust_changed_at = now(),
            display_name = coalesce(display_name, $2), owner = coalesce($3, owner),
            owner_source = CASE WHEN $3::text IS NOT NULL THEN $6 ELSE owner_source END,
            is_critical = is_critical OR $4, alerts_muted = alerts_muted OR $5
      WHERE id = $1 AND trust = 'unreviewed'`,
    [deviceId, match.display_name, match.owner, match.is_critical, match.alerts_muted, match.owner_source],
  );
  return match;
}
