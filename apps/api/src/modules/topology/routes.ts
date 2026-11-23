import { Router } from 'express';
import { z } from 'zod';
import type { DeviceStatus, DeviceType, Topology, TopologyEdge, TopologyNode } from '@nigafiy/shared-types';
import { auth, notFound, parse } from '../../common/http.ts';
import { cidrContains } from '../../common/net.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { type Sighting, locate } from '../ports/index.ts';

/**
 * Network topology, built only from evidence the platform actually has today:
 *   - the collector host's routing table (default gateway),
 *   - the collector host's neighbour (ARP) table → proof of sharing a layer-2 segment,
 *   - authorized scopes and ICMP replies → subnet membership,
 *   - internet check results → the uplink works.
 *   - forwarding tables and LLDP / CDP / MikroTik neighbour tables of the switches read over SNMP →
 *     which switch port a device is on, and which switches are linked;
 *   - MikroTik MNDP announcements heard by a collector → what a MikroTik device says about itself;
 *   - the Wi-Fi client tables of configured routers → which device is associated to which router.
 * Every edge states whether it is observed or inferred, why, how confident, and when last verified.
 * Switch-level links are never guessed: a device seen only "somewhere behind" a trunk gets no link.
 */
export const topologyRouter: Router = Router();

interface NeighborEntry {
  sys_name?: string;
  port_id?: string;
  chassis_id?: string;
  protocol?: 'lldp' | 'cdp' | 'mikrotik';
  address?: string;
  platform?: string;
}

const WIFI_BAND: Record<string, string> = { 'wifi_2.4ghz': '2.4 GHz', wifi_5ghz: '5 GHz', wifi_6ghz: '6 GHz' };

const PROTOCOL_LABEL: Record<'lldp' | 'cdp' | 'mikrotik', { short: string; source: string }> = {
  lldp: { short: 'LLDP', source: 'LLDP neighbour table (SNMP)' },
  cdp: { short: 'CDP', source: 'CDP neighbour table (CISCO-CDP-MIB over SNMP)' },
  mikrotik: { short: 'MikroTik', source: 'MikroTik neighbour table (MIKROTIK-MIB over SNMP)' },
};

/** Name forms a neighbour may use for a switch: as is, without a domain, without a "(serial)" suffix (CDP device IDs). */
function nameKeys(name: string): string[] {
  const n = name.trim().toLowerCase();
  const noSerial = n.replace(/\s*\([^)]*\)\s*$/, '');
  const short = /^[0-9.]+$/.test(noSerial) ? noSerial : noSerial.split('.')[0]!;
  return [...new Set([n, noSerial, short].filter(Boolean))];
}

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
  res.json(await withTenant(ctx.organizationId, (db) => buildTopology(db, siteId)));
});

/**
 * Builds the evidence graph of one site inside the caller's tenant transaction (RLS applies).
 * Exported through index.ts so other modules (impact simulation) reuse this graph instead of its SQL.
 */
export async function buildTopology(db: Db, siteId: string): Promise<Topology> {
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

    // ── switch level: what the switches read over SNMP actually saw ──
    const switches = (
      await db.query<{ id: string; device_id: string | null; name: string; sys_name: string | null; host: string; last_ok_at: Date | null }>(
        `SELECT id, device_id, coalesce(name, sys_name, host(host)) AS name, sys_name, host(host) AS host, last_ok_at FROM snmp_targets WHERE site_id = $1 AND last_ok_at IS NOT NULL`,
        [siteId],
      )
    ).rows;
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const switchNode = new Map<string, string>(); // snmp target id → node id
    for (const sw of switches) {
      const node = sw.device_id ? nodeById.get(`dev:${sw.device_id}`) : undefined;
      if (!node) continue;
      node.is_switch = true;
      switchNode.set(sw.id, node.id);
    }
    let placed = 0;
    let behind = 0;
    if (switchNode.size) {
      const sightings = (
        await db.query<Sighting & { mac: string }>(
          `SELECT f.mac::text AS mac, t.id AS target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, host(t.host) AS switch_host, f.if_index,
                  p.name AS port_name, p.alias AS port_alias, f.vlan, p.mac_count, p.neighbors, p.oper_up, p.speed_mbps::int AS speed_mbps, f.last_seen_at
             FROM switch_fdb f
             JOIN snmp_targets t ON t.id = f.target_id AND t.site_id = $1
             JOIN switch_ports p ON p.target_id = f.target_id AND p.if_index = f.if_index`,
          [siteId],
        )
      ).rows;
      const byMac = new Map<string, Sighting[]>();
      for (const s of sightings) byMac.set(s.mac, [...(byMac.get(s.mac) ?? []), s]);
      for (const d of devices.rows) {
        if (!d.mac) continue;
        const loc = locate(byMac.get(d.mac) ?? []);
        if (!loc) continue;
        const target = switchNode.get(loc.target_id);
        const id = `dev:${d.id}`;
        if (!target || target === id) continue;
        if (loc.kind === 'behind') {
          behind++; // reached through a trunk: the real port is on equipment that is not read, so no link is drawn
          continue;
        }
        placed++;
        nodeById.get(id)!.attached_to = `${loc.port_name} · ${loc.switch_name}`;
        edges.push({
          id: `e:${id}:port`,
          source: id,
          target,
          relation: 'connected_to',
          port: loc.port_name,
          basis: 'observed',
          confidence: loc.confidence,
          evidence: `${loc.evidence.join('. ')}.`,
          evidence_source: 'Switch forwarding table (SNMP)',
          last_verified_at: new Date(loc.last_seen_at).toISOString(),
        });
      }
      // Switch ↔ switch: a neighbour entry (LLDP, CDP or the MikroTik table) that names another read
      // switch — by system name / device ID, by its management address, or by its chassis MAC.
      const byName = new Map(switches.flatMap((sw) => [sw.sys_name, sw.name].filter((n): n is string => Boolean(n)).flatMap((n) => nameKeys(n).map((k) => [k, sw] as const))));
      const byHost = new Map(switches.map((sw) => [sw.host, sw] as const));
      const macOfDevice = new Map(devices.rows.filter((d) => d.mac).map((d) => [d.id, d.mac!.toLowerCase()] as const));
      const byMacSw = new Map(switches.flatMap((sw) => (sw.device_id && macOfDevice.has(sw.device_id) ? [[macOfDevice.get(sw.device_id)!, sw] as const] : [])));
      const linkPorts = (
        await db.query<{ target_id: string; name: string; neighbors: NeighborEntry[]; updated_at: Date }>(
          `SELECT p.target_id, p.name, p.neighbors, p.updated_at FROM switch_ports p JOIN snmp_targets t ON t.id = p.target_id WHERE t.site_id = $1 AND p.neighbors <> '[]'::jsonb`,
          [siteId],
        )
      ).rows;
      const seen = new Set<string>();
      for (const lp of linkPorts) {
        for (const n of lp.neighbors) {
          const viaName = n.sys_name ? nameKeys(n.sys_name).map((k) => byName.get(k)).find(Boolean) : undefined;
          const viaAddress = n.address ? byHost.get(n.address) : undefined;
          const chassis = n.chassis_id && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(n.chassis_id) ? n.chassis_id.toLowerCase() : null;
          const viaMac = chassis ? byMacSw.get(chassis) : undefined;
          const other = viaName ?? viaAddress ?? viaMac;
          const matched = viaName ? `name "${n.sys_name}"` : viaAddress ? `management address ${n.address}` : `chassis MAC ${n.chassis_id}`;
          const proto = PROTOCOL_LABEL[n.protocol ?? 'lldp'];
          const a = switchNode.get(lp.target_id);
          const b = other ? switchNode.get(other.id) : undefined;
          if (!a || !b || a === b) continue;
          const key = [a, b].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            id: `e:link:${key}`,
            source: a,
            target: b,
            relation: 'switch_link',
            port: lp.name,
            basis: 'observed',
            confidence: 'high',
            evidence: `${nodeById.get(a)!.label} lists ${n.sys_name || n.address || n.chassis_id} as its ${proto.short} neighbour on port ${lp.name}${n.port_id ? ` (remote port ${n.port_id})` : ''}${n.platform ? `, platform ${n.platform}` : ''}; matched to ${nodeById.get(b)!.label} by ${matched}.`,
            evidence_source: proto.source,
            last_verified_at: lp.updated_at.toISOString(),
          });
        }
      }
    }

    // Router → Wi-Fi client: a configured router listed the device as associated over Wi-Fi in the last
    // day. A device a switch already places on a port keeps that wired link and gets no Wi-Fi edge.
    // Same edge id as the impact twin (e:wifi:<client>), so both views describe one link.
    const wired = new Set(edges.filter((e) => e.relation === 'connected_to').map((e) => e.source));
    const wifiClients = (
      await db.query<{ router_name: string; router_device_id: string; client_device_id: string; connection: string; interface: string | null; signal_dbm: number | null; active: boolean | null; last_seen_at: Date }>(
        `SELECT DISTINCT ON (c.device_id) r.name AS router_name, r.device_id AS router_device_id, c.device_id AS client_device_id,
                c.connection, c.interface, c.signal_dbm, c.active, c.last_seen_at
           FROM router_clients c JOIN site_routers r ON r.id = c.router_id
          WHERE c.site_id = $1 AND r.enabled AND r.device_id IS NOT NULL AND c.device_id IS NOT NULL
            AND c.connection ILIKE 'wifi%' AND c.last_seen_at > now() - interval '1 day'
          ORDER BY c.device_id, c.last_seen_at DESC`,
        [siteId],
      )
    ).rows;
    const now = Date.now();
    let wireless = 0;
    for (const w of wifiClients) {
      const client = `dev:${w.client_device_id}`;
      const router = `dev:${w.router_device_id}`;
      if (!nodeById.has(client) || !nodeById.has(router) || client === router || wired.has(client)) continue;
      const fresh = now - w.last_seen_at.getTime() < 3_600_000 && w.active !== false;
      const band = WIFI_BAND[w.connection.toLowerCase()] ?? null;
      const facts = [band, w.interface ? `on ${w.interface}` : null, w.signal_dbm !== null ? `signal ${w.signal_dbm} dBm` : null].filter(Boolean).join(', ');
      edges.push({
        id: `e:wifi:${client}`,
        source: client,
        target: router,
        relation: 'wireless_client',
        ...(w.interface ? { port: w.interface } : {}),
        basis: 'observed',
        confidence: fresh ? 'high' : 'medium',
        evidence: `Router "${w.router_name}" listed it as a Wi-Fi client${facts ? ` (${facts})` : ''}${fresh ? '' : '; that list is more than an hour old'}.`,
        evidence_source: 'Router client table',
        last_verified_at: w.last_seen_at.toISOString(),
      });
      wireless++;
    }

    // What MikroTik devices announce about themselves over MNDP (heard by a collector in the last 24 h).
    const announced = (
      await db.query<{ device_id: string; identity: string | null; platform: string | null; version: string | null; board: string | null; interface_name: string | null; collector_name: string; last_seen_at: Date }>(
        `SELECT DISTINCT ON (n.device_id) n.device_id, n.identity, n.platform, n.version, n.board, n.interface_name, c.name AS collector_name, n.last_seen_at
           FROM mndp_neighbors n JOIN collectors c ON c.id = n.collector_id
          WHERE n.site_id = $1 AND n.device_id IS NOT NULL AND n.last_seen_at > now() - interval '24 hours'
          ORDER BY n.device_id, n.last_seen_at DESC`,
        [siteId],
      )
    ).rows;
    for (const m of announced) {
      const node = nodeById.get(`dev:${m.device_id}`);
      if (!node) continue;
      node.mndp = {
        identity: m.identity,
        platform: m.platform,
        version: m.version,
        board: m.board,
        interface_name: m.interface_name,
        heard_by: m.collector_name,
        last_seen_at: m.last_seen_at.toISOString(),
        evidence: `Announced itself over MNDP${m.identity ? ` as "${m.identity}"` : ''}${m.board ? ` (${m.board})` : ''}${m.interface_name ? ` from its interface ${m.interface_name}` : ''}; heard by collector "${m.collector_name}", so it shares a layer-2 segment with that collector.`,
      };
    }

    const unread = switches.filter((sw) => !switchNode.has(sw.id)).map((sw) => sw.name);
    const limitations = [
      switchNode.size
        ? `Switch ports are shown for ${placed} device(s) seen on access ports of the ${switchNode.size} switch(es) read over SNMP.${behind ? ` ${behind} device(s) were seen only behind a trunk or uplink port, so their link is not drawn.` : ''} Devices on Wi-Fi or behind unmanaged switches have no port. Everything else is grouped by IP subnet.`
        : 'Switch and access-point links are not shown: no managed switch has been read over SNMP yet (add one in Port Detective). Devices are grouped by IP subnet instead.',
      'The gateway relationship is known only for the segment a collector sits in.',
      'VLANs are shown per port in Port Detective; this map does not group by VLAN.',
    ];
    if (wireless) limitations.push(`${wireless} Wi-Fi link(s) come from router client tables; access points that are not a configured router are not visible, so the router may only be the path to the access point.`);
    if (unread.length) limitations.push(`${unread.join(', ')}: read over SNMP but not in the device inventory, so its ports are not drawn here.`);
    if (!collectors.rows.length) limitations.unshift('No collector is enrolled at this site, so no gateway or layer-2 evidence exists.');
    if (devices.rows.length === 2000) limitations.push('Only the first 2000 devices are shown.');

    return { site_id: siteId, generated_at: new Date().toISOString(), nodes, edges, limitations };
}
