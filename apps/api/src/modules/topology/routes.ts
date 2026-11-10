import { Router } from 'express';
import { z } from 'zod';
import type { DeviceStatus, DeviceType, Topology, TopologyEdge, TopologyNode } from '@lan-detective/shared-types';
import { auth, notFound, parse } from '../../common/http.ts';
import { cidrContains } from '../../common/net.ts';
import { withTenant } from '../../infrastructure/db.ts';

/**
 * Network topology, built only from evidence the platform actually has today:
 *   - the collector host's routing table (default gateway),
 *   - the collector host's neighbour (ARP) table → proof of sharing a layer-2 segment,
 *   - authorized scopes and ICMP replies → subnet membership,
 *   - internet check results → the uplink works.
 * Every edge states whether it is observed or inferred, why, how confident, and when last verified.
 * Switch-level links are NOT guessed; they arrive with SNMP/LLDP collection (Phase 3).
 */
export const topologyRouter: Router = Router();

interface DeviceRow {
  id: string;
  name: string;
  ip: string | null;
  mac: string | null;
  vendor: string | null;
  device_type: DeviceType;
  status: DeviceStatus;
  is_critical: boolean;
  discovery_sources: string[];
  last_seen_at: Date;
}

topologyRouter.get('/topology', async (req, res) => {
  const ctx = auth(req);
  const { site_id: siteId } = parse(z.object({ site_id: z.uuid() }), req.query);

  const topology = await withTenant(ctx.organizationId, async (db): Promise<Topology> => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    const scopes = await db.query<{ cidr: string; label: string | null }>(`SELECT cidr::text AS cidr, label FROM network_scopes WHERE site_id = $1 AND enabled ORDER BY cidr`, [siteId]);
    const collectors = await db.query<{ name: string; gateway_ip: string | null; interfaces: { name: string; addresses: string[] }[]; connection_state: string; last_heartbeat_at: Date | null }>(
      `SELECT name, host(gateway_ip) AS gateway_ip, interfaces, connection_state, last_heartbeat_at FROM collectors WHERE site_id = $1 AND status = 'active'`,
      [siteId],
    );
    const devices = await db.query<DeviceRow>(
      `SELECT id, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS name, host(current_ip) AS ip, primary_mac::text AS mac,
              vendor, device_type, status, is_critical, discovery_sources, last_seen_at
         FROM devices WHERE site_id = $1 ORDER BY current_ip NULLS LAST LIMIT 2000`,
      [siteId],
    );
    const internet = await db.query<{ name: string; state: string; last_result_at: Date | null }>(
      `SELECT name, state, last_result_at FROM monitoring_checks WHERE site_id = $1 AND enabled AND role = 'internet' ORDER BY (state = 'ok') DESC, last_result_at DESC NULLS LAST`,
      [siteId],
    );

    const collectorAddresses = collectors.rows.flatMap((c) => c.interfaces.flatMap((i) => i.addresses.map((a) => ({ ip: a.split('/')[0]!, collector: c.name }))));
    const segmentOf = (ip: string | null) => (ip ? scopes.rows.find((s) => cidrContains(s.cidr, ip))?.cidr ?? null : null);
    const collectorIn = (cidr: string) => collectorAddresses.find((a) => cidrContains(cidr, a.ip))?.collector ?? null;
    const gatewayIps = [...new Set(collectors.rows.flatMap((c) => (c.gateway_ip ? [c.gateway_ip] : [])))];

    const nodes: TopologyNode[] = [];
    const edges: TopologyEdge[] = [];
    const blank = { device_id: null, ip: null, mac: null, vendor: null, device_type: null, status: null, is_critical: false, runs_collector: false, segment: null, last_seen_at: null };

    for (const s of scopes.rows) nodes.push({ ...blank, id: `seg:${s.cidr}`, kind: 'segment', label: s.label ? `${s.label} · ${s.cidr}` : s.cidr, segment: s.cidr });
    const unscoped = devices.rows.some((d) => !segmentOf(d.ip));
    if (unscoped) nodes.push({ ...blank, id: 'seg:none', kind: 'segment', label: 'Outside current scopes' });

    const gatewayNodeId = new Map<string, string>();
    for (const d of devices.rows) {
      const isGateway = d.ip !== null && gatewayIps.includes(d.ip);
      const segment = segmentOf(d.ip);
      const id = `dev:${d.id}`;
      if (isGateway) gatewayNodeId.set(d.ip!, id);
      nodes.push({
        id,
        kind: isGateway ? 'gateway' : 'device',
        label: d.name,
        device_id: d.id,
        ip: d.ip,
        mac: d.mac,
        vendor: d.vendor,
        device_type: d.device_type,
        status: d.status,
        is_critical: d.is_critical,
        runs_collector: collectorAddresses.some((a) => a.ip === d.ip),
        segment,
        last_seen_at: d.last_seen_at.toISOString(),
      });
      if (isGateway) continue; // the gateway is linked to its segment by the gateway_of edge below
      const local = segment ? collectorIn(segment) : null;
      const own = d.discovery_sources.includes('local_interface') && local !== null;
      const viaArp = (own || d.discovery_sources.includes('arp_cache')) && local !== null;
      edges.push({
        id: `e:${id}:member`,
        source: id,
        target: segment ? `seg:${segment}` : 'seg:none',
        relation: 'member_of',
        basis: viaArp ? 'observed' : 'inferred',
        confidence: viaArp ? 'high' : local ? 'medium' : 'low',
        evidence: own
          ? `This is the collector host itself ("${local}"): its address and MAC were read from its own network interface in this segment.`
          : viaArp
          ? `Its MAC address was read from the neighbour (ARP) table of collector "${local}", which is only possible inside the same layer-2 segment.`
          : segment
            ? `Its IP address lies inside this authorized range and it answered ICMP${local ? '' : '; no collector has an interface in this range, so traffic to it is routed'}. The layer-2 path was not observed.`
            : 'Its last known address is not inside any currently authorized scope.',
        evidence_source: own ? 'Collector network interface' : viaArp ? 'Collector neighbour table' : 'ICMP reply + scope membership',
        last_verified_at: d.last_seen_at.toISOString(),
      });
    }

    const bestInternet = internet.rows[0];
    if (gatewayIps.length) nodes.push({ ...blank, id: 'internet', kind: 'internet', label: 'Internet' });
    for (const ip of gatewayIps) {
      const users = collectors.rows.filter((c) => c.gateway_ip === ip);
      let id = gatewayNodeId.get(ip);
      if (!id) {
        // The gateway is known from the routing table but lies outside every authorized scope, so it was never probed.
        id = `gw:${ip}`;
        nodes.push({ ...blank, id, kind: 'gateway', label: ip, ip, segment: segmentOf(ip) });
      }
      const verified = users.map((c) => c.last_heartbeat_at).filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0];
      const segments = scopes.rows.filter((s) => cidrContains(s.cidr, ip) || users.some((c) => c.interfaces.some((i) => i.addresses.some((a) => cidrContains(s.cidr, a.split('/')[0]!)))));
      for (const s of segments) {
        edges.push({
          id: `e:${id}:gw:${s.cidr}`,
          source: `seg:${s.cidr}`,
          target: id,
          relation: 'gateway_of',
          basis: 'inferred',
          confidence: 'medium',
          evidence: `Collector ${users.map((c) => `"${c.name}"`).join(', ')} in this segment uses ${ip} as its default gateway (host routing table). The gateway settings of other devices are not observed.`,
          evidence_source: 'Collector routing table',
          last_verified_at: verified?.toISOString() ?? null,
        });
      }
      edges.push({
        id: `e:${id}:uplink`,
        source: id,
        target: 'internet',
        relation: 'uplink',
        basis: 'inferred',
        confidence: bestInternet?.state === 'ok' ? 'high' : 'medium',
        evidence:
          bestInternet?.state === 'ok'
            ? `Internet targets are reachable from the collector, whose default route points to ${ip} (check "${bestInternet.name}" is healthy). Any further routers or modems behind it are not visible.`
            : `The collector's default route points to ${ip}. Internet targets are currently not confirmed reachable.`,
        evidence_source: 'Collector routing table + internet checks',
        last_verified_at: bestInternet?.state === 'ok' ? (bestInternet.last_result_at?.toISOString() ?? null) : null,
      });
    }

    const limitations = [
      'Switch and access-point links are not shown: they require SNMP/LLDP data from managed switches, which is not collected yet. Devices are grouped by IP subnet instead.',
      'The gateway relationship is known only for the segment a collector sits in.',
      'VLANs are not observed.',
    ];
    if (!collectors.rows.length) limitations.unshift('No collector is enrolled at this site, so no gateway or layer-2 evidence exists.');
    if (devices.rows.length === 2000) limitations.push('Only the first 2000 devices are shown.');

    return { site_id: siteId, generated_at: new Date().toISOString(), nodes, edges, limitations };
  });
  res.json(topology);
});
