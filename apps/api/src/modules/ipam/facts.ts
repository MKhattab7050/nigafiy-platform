import type { IpamRecord, IpamSubnetDetail, IpamSubnetSummary } from '@lan-detective/shared-types';
import { notFound } from '../../common/http.ts';
import { addressScope, cidrContains, isIP } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import { type ObservedDevice, bigToIp, buildPlan, rangeOf } from './plan.ts';

// Loading what was observed (devices, collectors) and documented (IPAM records) for subnets, and
// turning it into the address plan (plan.ts is the pure part).

export interface ScopeRow {
  id: string;
  site_id: string;
  site_name: string;
  cidr: string;
  label: string | null;
  enabled: boolean;
  last_scan_at: string | null;
  vlan_id: number | null;
  gateway: string | null;
  dns_servers: string[];
  dhcp_start: string | null;
  dhcp_end: string | null;
  notes: string | null;
}

export const SCOPES = `
  SELECT s.id, s.site_id, si.name AS site_name, s.cidr::text AS cidr, s.label, s.enabled, s.last_run_finished_at AS last_scan_at,
         m.vlan_id, host(m.gateway) AS gateway, coalesce(ARRAY(SELECT host(x) FROM unnest(m.dns_servers) AS x), '{}') AS dns_servers,
         host(m.dhcp_start) AS dhcp_start, host(m.dhcp_end) AS dhcp_end, m.notes
    FROM network_scopes s
    JOIN sites si ON si.id = s.site_id
    LEFT JOIN ipam_subnets m ON m.scope_id = s.id`;

export const RECORD = `id, site_id, host(ip) AS ip, kind, label, mac::text AS mac, notes, updated_at`;

/** Everything observed and documented for the given sites, loaded once and split per subnet in memory. */
export async function loadFacts(db: Db, siteIds: string[]) {
  const devices = (
    await db.query<ObservedDevice & { site_id: string }>(
      `SELECT id, site_id, host(current_ip) AS ip, coalesce(display_name, hostname, host(current_ip)) AS label, primary_mac::text AS mac,
              device_type, status, last_seen_at
         FROM devices WHERE site_id = ANY($1) AND current_ip IS NOT NULL
       UNION ALL
       -- The other IPv6 addresses of each device (device_addresses, migration 038): a device holds
       -- several at once. Online at that address only when the latest discovery run of the scope that
       -- saw it saw it again; link-local addresses are never part of a subnet plan.
       SELECT d.id, d.site_id, host(a.ip), coalesce(d.display_name, d.hostname, host(d.current_ip)), d.primary_mac::text, d.device_type,
              CASE WHEN d.status = 'online' AND s.last_run_finished_at IS NOT NULL AND a.last_seen_at >= s.last_run_finished_at THEN 'online' ELSE 'offline' END,
              a.last_seen_at
         FROM device_addresses a JOIN devices d ON d.id = a.device_id LEFT JOIN network_scopes s ON s.id = a.scope_id
        WHERE a.site_id = ANY($1) AND family(a.ip) = 6 AND a.address_scope <> 'link_local' AND a.ip IS DISTINCT FROM d.current_ip`,
      [siteIds],
    )
  ).rows.map((d) => ({ ...d, last_seen_at: new Date(d.last_seen_at).toISOString() }));
  const records = (await db.query<IpamRecord>(`SELECT ${RECORD} FROM ipam_addresses WHERE site_id = ANY($1)`, [siteIds])).rows;
  const collectors = (
    await db.query<{ site_id: string; gateway_ip: string | null; interfaces: { addresses?: string[] }[] }>(
      `SELECT site_id, host(gateway_ip) AS gateway_ip, interfaces FROM collectors WHERE site_id = ANY($1) AND status = 'active'`,
      [siteIds],
    )
  ).rows;
  return { devices, records, collectors };
}

export type Facts = Awaited<ReturnType<typeof loadFacts>>;

export function planFor(scope: ScopeRow, facts: Facts) {
  const collectors = facts.collectors.filter((c) => c.site_id === scope.site_id);
  const observedGateway = collectors.map((c) => c.gateway_ip).find((ip) => ip && cidrContains(scope.cidr, ip)) ?? null;
  const gateway = scope.gateway ? { ip: scope.gateway, source: 'documented' as const } : observedGateway ? { ip: observedGateway, source: 'observed' as const } : null;
  const collectorIps = collectors
    .flatMap((c) => (c.interfaces ?? []).flatMap((i) => (i.addresses ?? []).map((a) => a.split('/')[0]!)))
    .filter((ip) => isIP(ip) && addressScope(ip) !== 'link_local');
  const dhcp = scope.dhcp_start && scope.dhcp_end ? { start: scope.dhcp_start, end: scope.dhcp_end } : null;
  const plan = buildPlan({
    cidr: scope.cidr,
    devices: facts.devices.filter((d) => d.site_id === scope.site_id),
    records: facts.records.filter((r) => r.site_id === scope.site_id),
    gateway,
    collectorIps: [...new Set(collectorIps)],
    dhcp,
  });
  return { plan, gateway, dhcp };
}

export function summarize(scope: ScopeRow, facts: Facts): IpamSubnetSummary & { detail: ReturnType<typeof planFor> } {
  const detail = planFor(scope, facts);
  return {
    id: scope.id,
    site_id: scope.site_id,
    site_name: scope.site_name,
    cidr: scope.cidr,
    label: scope.label,
    enabled: scope.enabled,
    last_scan_at: scope.last_scan_at,
    vlan_id: scope.vlan_id,
    gateway: detail.gateway,
    family: detail.plan.family,
    ...detail.plan.counts,
    conflicts: detail.plan.conflicts.length,
    detail,
  };
}

/**
 * A page of the address list ('all': every listed address, for the CSV export). An IPv4 subnet is at
 * most a /20, so all of its listed addresses fit one response (the address map draws them); an IPv6
 * subnet lists only what was observed or documented, IPV6_ADDRESS_PAGE at a time unless a limit is given.
 */
export type AddressPage = { offset?: number; limit?: number; /** Only this address (the address dialog of a paged subnet). */ ip?: string } | 'all';
export const IPV6_ADDRESS_PAGE = 256;
export const MAX_ADDRESS_PAGE = 4096;

export async function loadSubnet(db: Db, id: string, page: AddressPage = {}): Promise<IpamSubnetDetail> {
  const scope = (await db.query<ScopeRow>(`${SCOPES} WHERE s.id = $1`, [id])).rows[0];
  if (!scope) throw notFound('Subnet');
  const { detail, ...summary } = summarize(scope, await loadFacts(db, [scope.site_id]));
  const m = rangeOf(scope.cidr);
  const all = detail.plan.addresses;
  const offset = page === 'all' ? 0 : Math.min(page.offset ?? 0, all.length);
  const limit = page === 'all' ? all.length : (page.limit ?? (m.family === 6 ? IPV6_ADDRESS_PAGE : all.length));
  return {
    ...summary,
    network: bigToIp(m.network, m.family),
    broadcast: m.broadcast === null ? null : bigToIp(m.broadcast, m.family),
    prefix: m.prefix,
    netmask: m.netmask,
    first_host: bigToIp(m.first, m.family),
    last_host: bigToIp(m.last, m.family),
    dns_servers: scope.dns_servers,
    dhcp: detail.dhcp,
    notes: scope.notes,
    addresses: page !== 'all' && page.ip ? all.filter((a) => a.ip === page.ip) : all.slice(offset, offset + limit),
    addresses_offset: offset,
    addresses_total: all.length,
    conflict_list: detail.plan.conflicts,
    next_free: detail.plan.next_free,
  };
}
