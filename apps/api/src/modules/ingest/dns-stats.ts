import type { Db } from '../../infrastructure/db.ts';
import { type CollectorContext, type DnsStatsItem, ItemRejected } from '../../common/collector-protocol.ts';

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Stores one DNS-filter window. Each client is matched to a device of the collector's site by MAC
 * (stable across IP changes) and otherwise by its current IP address.
 */
export async function processDnsStats(db: Db, c: CollectorContext, item: DnsStatsItem): Promise<void> {
  const start = new Date(item.window_start);
  const end = new Date(item.ts);
  if (!(start <= end) || end.getTime() - start.getTime() > 2 * 3600_000) throw new ItemRejected('dns_stats window is not a valid period');

  const entries: { cl: DnsStatsItem['clients'][number]; mac: string | null }[] = [];
  for (const cl of item.clients) {
    if (!IPV4.test(cl.ip) && !cl.ip.includes(':')) continue;
    const mac = cl.mac && MAC.test(cl.mac.toLowerCase()) ? cl.mac.toLowerCase() : null;
    entries.push({ cl, mac });
  }
  if (!entries.length) return;

  const macs = [...new Set(entries.map((e) => e.mac).filter((m): m is string => m !== null))];
  const ips = [...new Set(entries.map((e) => e.cl.ip))];
  const matched = (
    await db.query<{ id: string; mac: string | null; ip: string | null }>(
      `SELECT id, primary_mac::text AS mac, host(current_ip) AS ip
         FROM devices
        WHERE site_id = $1 AND (primary_mac = ANY($2::macaddr[]) OR current_ip = ANY($3::inet[]))
        ORDER BY last_seen_at DESC`,
      [c.siteId, macs, ips],
    )
  ).rows;

  const byMac = new Map<string, string>();
  const byIp = new Map<string, string>();
  for (const row of matched) {
    if (row.mac && !byMac.has(row.mac)) byMac.set(row.mac, row.id);
    if (row.ip && !byIp.has(row.ip)) byIp.set(row.ip, row.id);
  }

  const deviceIds: (string | null)[] = [];
  const clientIps: string[] = [];
  const macCols: (string | null)[] = [];
  const queries: number[] = [];
  const blocked: number[] = [];
  const topDomains: string[] = [];

  for (const { cl, mac } of entries) {
    const deviceId = (mac ? byMac.get(mac) : undefined) ?? byIp.get(cl.ip) ?? null;
    deviceIds.push(deviceId);
    clientIps.push(cl.ip);
    macCols.push(mac);
    queries.push(cl.queries);
    blocked.push(cl.blocked);
    topDomains.push(JSON.stringify(cl.top_domains));
  }

  await db.query(
    `INSERT INTO dns_stats (organization_id, site_id, collector_id, device_id, client_ip, mac, window_start, window_end, queries, blocked, top_domains)
     SELECT $1, $2, $3, u.device_id, u.client_ip, u.mac, $4, $5, u.queries, u.blocked, u.top_domains
       FROM unnest($6::uuid[], $7::inet[], $8::macaddr[], $9::int[], $10::int[], $11::jsonb[])
            AS u(device_id, client_ip, mac, queries, blocked, top_domains)`,
    [c.organizationId, c.siteId, c.id, start, end, deviceIds, clientIps, macCols, queries, blocked, topDomains],
  );
}
