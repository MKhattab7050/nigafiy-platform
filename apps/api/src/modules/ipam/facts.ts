import type { IpamRecord, IpamSubnetDetail, IpamSubnetSummary } from '@lan-detective/shared-types';
import { notFound } from '../../common/http.ts';
import { cidrContains, isIPv4 } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import { type ObservedDevice, buildPlan, intToIp, subnetMath } from './plan.ts';

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
         FROM devices WHERE site_id = ANY($1) AND current_ip IS NOT NULL AND family(current_ip) = 4`,
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
  const collectorIps = collectors.flatMap((c) => (c.interfaces ?? []).flatMap((i) => (i.addresses ?? []).map((a) => a.split('/')[0]!))).filter(isIPv4);
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
    ...detail.plan.counts,
    conflicts: detail.plan.conflicts.length,
    detail,
  };
}

export async function loadSubnet(db: Db, id: string): Promise<IpamSubnetDetail> {
  const scope = (await db.query<ScopeRow>(`${SCOPES} WHERE s.id = $1`, [id])).rows[0];
  if (!scope) throw notFound('Subnet');
  const { detail, ...summary } = summarize(scope, await loadFacts(db, [scope.site_id]));
  const m = subnetMath(scope.cidr);
  return {
    ...summary,
    network: intToIp(m.network),
    broadcast: intToIp(m.broadcast),
    netmask: intToIp(m.prefix === 0 ? 0 : (0xffffffff << (32 - m.prefix)) >>> 0),
    first_host: intToIp(m.first),
    last_host: intToIp(m.last),
    dns_servers: scope.dns_servers,
    dhcp: detail.dhcp,
    notes: scope.notes,
    addresses: detail.plan.addresses,
    conflict_list: detail.plan.conflicts,
    next_free: detail.plan.next_free,
  };
}
