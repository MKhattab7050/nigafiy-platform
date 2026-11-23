import type { PortLocation as PortLocationDto } from '@nigafiy/shared-types';
import { notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { type Sighting, locate } from '../locate.ts';

// Port Detective search: which switch port is a device on? Evidence = the switches' forwarding
// tables; the decision rules are in locate.ts (pure).

async function sightingsFor(db: Db, deviceId: string): Promise<{ found: boolean; mac: string | null; sightings: Sighting[]; switches: number }> {
  const device = (await db.query<{ site_id: string; mac: string | null }>(`SELECT site_id, primary_mac::text AS mac FROM devices WHERE id = $1`, [deviceId])).rows[0];
  if (!device) return { found: false, mac: null, sightings: [], switches: 0 };
  const switches = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM snmp_targets WHERE site_id = $1 AND last_status = 'ok'`, [device.site_id])).rows[0]!.n;
  if (!device.mac) return { found: true, mac: null, sightings: [], switches };
  const rows = (
    await db.query<Sighting>(
      `SELECT t.id AS target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, host(t.host) AS switch_host, f.if_index, p.name AS port_name, p.alias AS port_alias,
              f.vlan, p.mac_count, p.neighbors, p.oper_up, p.speed_mbps::int AS speed_mbps, f.last_seen_at
         FROM switch_fdb f
         JOIN snmp_targets t ON t.id = f.target_id AND t.site_id = $1
         JOIN switch_ports p ON p.target_id = f.target_id AND p.if_index = f.if_index
        WHERE f.mac = $2::macaddr`,
      [device.site_id, device.mac],
    )
  ).rows;
  return { found: true, mac: device.mac, sightings: rows, switches };
}

/** Switch-port location of one device inside an existing transaction (GET /devices/:id/controls). */
export async function devicePortLocation(db: Db, deviceId: string) {
  const s = await sightingsFor(db, deviceId);
  const location = s.found ? (locate(s.sightings) as PortLocationDto | null) : null;
  return {
    location,
    switches_read: s.switches,
    reason: location ? null : !s.mac ? 'no_mac' : s.switches === 0 ? 'no_switches' : 'not_seen',
    evidence: 'switch forwarding tables (SNMP)',
  };
}

/** Where is this device? */
export function locateDevice(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    const s = await sightingsFor(db, id);
    if (!s.found) throw notFound('Device');
    const location = locate(s.sightings) as PortLocationDto | null;
    return {
      location,
      // Every switch that saw the address, so the path can be followed by hand.
      seen_on: s.sightings.map((x) => ({ target_id: x.target_id, switch_name: x.switch_name, port_name: x.port_name, mac_count: x.mac_count, vlan: x.vlan })),
      switches_read: s.switches,
      reason: location ? null : !s.mac ? 'no_mac' : s.switches === 0 ? 'no_switches' : 'not_seen',
    };
  });
}

/** A name, IP or MAC → the port(s) it is on. */
export function findPorts(organizationId: string, q: string, siteId: string | undefined) {
  return withTenant(organizationId, async (db) => {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const devices = (
      await db.query<{ id: string; site_id: string; label: string; ip: string | null; mac: string | null; status: string }>(
        `SELECT d.id, d.site_id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label,
                host(d.current_ip) AS ip, d.primary_mac::text AS mac, d.status
           FROM devices d
          WHERE ($2::uuid IS NULL OR d.site_id = $2)
            AND (d.display_name ILIKE $1 OR d.hostname ILIKE $1 OR host(d.current_ip) ILIKE $1 OR d.primary_mac::text ILIKE $1 OR d.vendor ILIKE $1)
          ORDER BY (d.status = 'online') DESC, d.current_ip NULLS LAST LIMIT 20`,
        [like, siteId ?? null],
      )
    ).rows;
    const withMac = devices.filter((d): d is typeof d & { mac: string } => d.mac !== null);
    const sightingsByKey = new Map<string, Sighting[]>();
    if (withMac.length > 0) {
      const rows = (
        await db.query<Sighting & { site_id: string; mac: string }>(
          `SELECT q.site_id, q.mac::text AS mac,
                  t.id AS target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, host(t.host) AS switch_host, f.if_index, p.name AS port_name, p.alias AS port_alias,
                  f.vlan, p.mac_count, p.neighbors, p.oper_up, p.speed_mbps::int AS speed_mbps, f.last_seen_at
             FROM switch_fdb f
             JOIN snmp_targets t ON t.id = f.target_id
             JOIN switch_ports p ON p.target_id = f.target_id AND p.if_index = f.if_index
             JOIN unnest($1::uuid[], $2::macaddr[]) AS q(site_id, mac) ON t.site_id = q.site_id AND f.mac = q.mac`,
          [withMac.map((d) => d.site_id), withMac.map((d) => d.mac)],
        )
      ).rows;
      for (const { site_id, mac, ...sighting } of rows) {
        const key = `${site_id}:${mac}`;
        const list = sightingsByKey.get(key);
        if (list) list.push(sighting);
        else sightingsByKey.set(key, [sighting]);
      }
    }
    return devices.map(({ site_id, ...device }) => ({
      device,
      location: locate(device.mac ? (sightingsByKey.get(`${site_id}:${device.mac}`) ?? []) : []),
    }));
  });
}
