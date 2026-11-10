import type { Db } from '../../infrastructure/db.ts';
import { type CollectorContext, type DnsStatsItem, ItemRejected } from './schema.ts';

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
  for (const cl of item.clients) {
    if (!IPV4.test(cl.ip) && !cl.ip.includes(':')) continue;
    const mac = cl.mac && MAC.test(cl.mac.toLowerCase()) ? cl.mac.toLowerCase() : null;
    const device = (
      await db.query<{ id: string }>(
        `SELECT id FROM devices
          WHERE site_id = $1 AND (($2::macaddr IS NOT NULL AND primary_mac = $2::macaddr) OR ($2::macaddr IS NULL AND current_ip = $3::inet))
          ORDER BY last_seen_at DESC LIMIT 1`,
        [c.siteId, mac, cl.ip],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO dns_stats (organization_id, site_id, collector_id, device_id, client_ip, mac, window_start, window_end, queries, blocked, top_domains)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [c.organizationId, c.siteId, c.id, device?.id ?? null, cl.ip, mac, start, end, cl.queries, cl.blocked, JSON.stringify(cl.top_domains)],
    );
  }
}
