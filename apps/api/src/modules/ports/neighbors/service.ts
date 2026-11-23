import type { Request } from 'express';
import type { MndpListenerStatus, MndpNeighbor, NeighborsReport, SwitchNeighborRow } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { type CollectorContext, ItemRejected, type MndpNeighborsItem } from '../../../common/collector-protocol.ts';
import { type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';

// Neighbour discovery beyond the forwarding table:
//  - switch neighbour tables read over SNMP (LLDP, CISCO-CDP-MIB, MIKROTIK-MIB), stored per port in
//    switch_ports.neighbors by ports/ingest.ts, each entry tagged with its protocol;
//  - MikroTik MNDP announcements heard by a collector's receive-only listener (mndp_neighbors).

/**
 * Stores what a collector's MNDP listener heard. Announcements from outside the site's authorized
 * ranges are dropped here too (the collector already refuses them). The device is matched by MAC,
 * then by the announced or source IPv4 address.
 */
export async function processMndpNeighbors(db: Db, c: CollectorContext, item: MndpNeighborsItem): Promise<void> {
  const site = await db.query<{ mndp_listen: boolean }>(`SELECT mndp_listen FROM sites WHERE id = $1`, [c.siteId]);
  if (!site.rows[0]?.mndp_listen) throw new ItemRejected('MikroTik neighbour discovery is turned off for this site');
  let stored = 0;
  for (const n of item.neighbors) {
    const r = await db.query(
      `INSERT INTO mndp_neighbors (collector_id, mac, organization_id, site_id, device_id, identity, platform, version, board, interface_name,
                                   ipv4, ipv6, uptime_seconds, source_ip, first_seen_at, last_seen_at)
       SELECT $1, $2::macaddr, $3, $4,
              (SELECT d.id FROM devices d
                WHERE d.site_id = $4 AND (d.primary_mac = $2::macaddr OR d.current_ip = coalesce($10::inet, $13::inet))
                ORDER BY (d.primary_mac = $2::macaddr) DESC NULLS LAST, d.last_seen_at DESC NULLS LAST LIMIT 1),
              $5, $6, $7, $8, $9, $10::inet, $11::inet, $12, $13::inet, $14, $15
        WHERE EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = $4 AND s.enabled AND $13::inet <<= s.cidr)
       ON CONFLICT (collector_id, mac) DO UPDATE
          SET device_id = EXCLUDED.device_id, identity = EXCLUDED.identity, platform = EXCLUDED.platform, version = EXCLUDED.version,
              board = EXCLUDED.board, interface_name = EXCLUDED.interface_name, ipv4 = EXCLUDED.ipv4, ipv6 = EXCLUDED.ipv6,
              uptime_seconds = EXCLUDED.uptime_seconds, source_ip = EXCLUDED.source_ip,
              first_seen_at = least(mndp_neighbors.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = greatest(mndp_neighbors.last_seen_at, EXCLUDED.last_seen_at)`,
      [
        c.id,
        n.mac,
        c.organizationId,
        c.siteId,
        n.identity ?? null,
        n.platform ?? null,
        n.version ?? null,
        n.board ?? null,
        n.interface_name ?? null,
        n.ipv4 ?? null,
        n.ipv6 ?? null,
        n.uptime_seconds ?? null,
        n.source_ip,
        n.first_seen_at,
        n.last_seen_at,
      ],
    );
    stored += r.rowCount ?? 0;
  }
  if (!stored) throw new ItemRejected('no MNDP announcement came from inside an authorized network range of the site');
  await notifyRealtime(db, c.organizationId, 'devices');
}

/** MNDP neighbours not heard for this long are no longer listed (they announce about every 60 s). */
export const MNDP_STALE_HOURS = 24;

export function neighborsReport(organizationId: string, siteId: string): Promise<NeighborsReport> {
  return withTenant(organizationId, async (db) => {
    const site = (await db.query<{ mndp_listen: boolean }>(`SELECT mndp_listen FROM sites WHERE id = $1`, [siteId])).rows[0];
    if (!site) throw notFound('Site');
    const listeners = (
      await db.query<MndpListenerStatus>(
        `SELECT id AS collector_id, name AS collector_name, connection_state, mndp_status AS status
           FROM collectors WHERE site_id = $1 AND revoked_at IS NULL ORDER BY name`,
        [siteId],
      )
    ).rows;
    const mndp = (
      await db.query<MndpNeighbor>(
        `SELECT n.collector_id, c.name AS collector_name, n.mac::text AS mac, n.device_id,
                coalesce(d.display_name, d.hostname, host(d.current_ip)) AS device_label,
                n.identity, n.platform, n.version, n.board, n.interface_name, host(n.ipv4) AS ipv4, host(n.ipv6) AS ipv6,
                n.uptime_seconds::float8 AS uptime_seconds, host(n.source_ip) AS source_ip, n.first_seen_at, n.last_seen_at
           FROM mndp_neighbors n JOIN collectors c ON c.id = n.collector_id LEFT JOIN devices d ON d.id = n.device_id
          WHERE n.site_id = $1 AND n.last_seen_at > now() - make_interval(hours => $2)
          ORDER BY n.identity NULLS LAST, n.mac`,
        [siteId, MNDP_STALE_HOURS],
      )
    ).rows;
    const switchNeighbors = (
      await db.query<SwitchNeighborRow>(
        `SELECT p.target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, p.if_index, p.name AS port_name, p.updated_at,
                n ->> 'sys_name' AS sys_name, n ->> 'port_id' AS port_id, n ->> 'port_descr' AS port_descr, n ->> 'chassis_id' AS chassis_id,
                coalesce(n ->> 'protocol', 'lldp') AS protocol, n ->> 'address' AS address, n ->> 'platform' AS platform, n ->> 'version' AS version
           FROM switch_ports p JOIN snmp_targets t ON t.id = p.target_id, jsonb_array_elements(p.neighbors) n
          WHERE t.site_id = $1
          ORDER BY switch_name, p.if_index`,
        [siteId],
      )
    ).rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as unknown as SwitchNeighborRow);
    return { site_id: siteId, mndp_listen: site.mndp_listen, listeners, mndp, switch_neighbors: switchNeighbors };
  });
}

/** Turns the passive MNDP listener on or off for every collector of the site (admin, audited). */
export function setMndpListen(req: Request, ctx: AuthContext, siteId: string, enabled: boolean): Promise<void> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<{ before: boolean }>(
      `UPDATE sites s SET mndp_listen = $2 FROM (SELECT mndp_listen AS before FROM sites WHERE id = $1 FOR UPDATE) b WHERE s.id = $1 RETURNING b.before`,
      [siteId, enabled],
    );
    if (!r.rowCount) throw notFound('Site');
    if (!enabled) await db.query(`DELETE FROM mndp_neighbors WHERE site_id = $1`, [siteId]);
    await audit(db, req, 'site.mndp_listen', { type: 'site', id: siteId }, { before: r.rows[0]!.before, after: enabled, cleared_neighbors: !enabled });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}
