import type { CollectorContext, SmartCheckItem } from '../../common/collector-protocol.ts';
import { normalizeMac } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import { dhcpIncidentKey, resolveOpenIncidentByKey } from '../correlation/index.ts';
import { emitEvent } from '../events/index.ts';
import { type FindingInput, syncFindings } from './findings.ts';

// Rogue DHCP server detection (check 'rogue_dhcp') and the passive "which server did clients choose"
// evidence (check 'dhcp_fingerprints'). Every statement filters organization_id explicitly.

type DhcpBlock = NonNullable<SmartCheckItem['dhcp']>;

/** A server counts as active when it answered one of the last two probes or clients chose it within the last hour. */
const ACTIVE_SQL = `((last_offer_at IS NOT NULL AND missed_probes < 2) OR last_client_choice_at > $3::timestamptz - interval '1 hour')`;

export interface DhcpProbeSummary {
  interfaces_probed: number;
  listen_errors: string[];
  offers: number;
  servers: string[];
}

export function summarizeDhcp(block: DhcpBlock | undefined): DhcpProbeSummary {
  const ifs = block?.interfaces ?? [];
  const servers = [...new Set(ifs.flatMap((i) => i.offers.map((o) => o.server_id)))].sort();
  return {
    interfaces_probed: ifs.filter((i) => !i.listen_error).length,
    listen_errors: ifs.filter((i) => i.listen_error).map((i) => `${i.name}: ${i.listen_error}`),
    offers: ifs.reduce((n, i) => n + i.offers.length, 0),
    servers,
  };
}

/** Addresses that are the site's gateway: a collector's default gateway, or a router configured in router control. */
async function siteGateways(db: Db, organizationId: string, siteId: string): Promise<Set<string>> {
  const rows = await db.query<{ ip: string }>(
    `SELECT host(gateway_ip) AS ip FROM collectors WHERE organization_id = $1 AND site_id = $2 AND status = 'active' AND gateway_ip IS NOT NULL
     UNION SELECT host(address) FROM site_routers WHERE organization_id = $1 AND site_id = $2`,
    [organizationId, siteId],
  );
  return new Set(rows.rows.map((r) => r.ip));
}

export async function approvedValues(db: Db, organizationId: string, siteId: string, kind: 'dhcp_server' | 'wifi_bssid' | 'upnp_mapping'): Promise<Set<string>> {
  const rows = await db.query<{ value: string }>(`SELECT value FROM security_expected WHERE organization_id = $1 AND site_id = $2 AND kind = $3`, [organizationId, siteId, kind]);
  return new Set(rows.rows.map((r) => r.value.toLowerCase()));
}

/** Apply one DHCPDISCOVER probe report: record every server that answered, then re-evaluate the site. */
export async function processDhcpProbe(db: Db, c: CollectorContext, item: SmartCheckItem, now: Date): Promise<void> {
  const block = item.dhcp;
  if (!block) return;
  const at = new Date(item.ts);
  const summary = summarizeDhcp(block);
  if (summary.interfaces_probed === 0) return; // could not listen anywhere: nothing was measured

  // Merge the offers of all interfaces by server identifier.
  const offers = new Map<string, { offer: DhcpBlock['interfaces'][number]['offers'][number]; interfaces: string[] }>();
  for (const iface of block.interfaces) {
    for (const o of iface.offers) {
      const known = offers.get(o.server_id);
      if (known) known.interfaces.push(iface.name);
      else offers.set(o.server_id, { offer: o, interfaces: [iface.name] });
    }
  }
  const state = (
    await db.query<{ probes: number }>(`SELECT probes FROM dhcp_probe_state WHERE organization_id = $1 AND site_id = $2`, [c.organizationId, c.siteId])
  ).rows[0];
  const knownServers = Number(
    (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM dhcp_servers WHERE organization_id = $1 AND site_id = $2`, [c.organizationId, c.siteId])).rows[0]?.n ?? 0,
  );
  // The very first answer at a site, from a single server, is assumed to be the real one (shown as "not confirmed yet").
  const baseline = (state?.probes ?? 0) === 0 && knownServers === 0 && offers.size === 1;

  for (const [serverId, { offer: o, interfaces }] of offers) {
    await db.query(
      `INSERT INTO dhcp_servers (organization_id, site_id, server_id, source_ip, server_mac, offered_ip, subnet_mask, routers, dns_servers, lease_seconds, domain, interfaces, baseline, first_seen_at, last_offer_at, missed_probes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::inet[],$9::inet[],$10,$11,$12,$13,$14,$14,0)
       ON CONFLICT (organization_id, site_id, server_id) DO UPDATE
          SET source_ip = EXCLUDED.source_ip, server_mac = coalesce(EXCLUDED.server_mac, dhcp_servers.server_mac), offered_ip = EXCLUDED.offered_ip,
              subnet_mask = EXCLUDED.subnet_mask, routers = EXCLUDED.routers, dns_servers = EXCLUDED.dns_servers, lease_seconds = EXCLUDED.lease_seconds,
              domain = EXCLUDED.domain, interfaces = ARRAY(SELECT DISTINCT x FROM unnest(dhcp_servers.interfaces || EXCLUDED.interfaces) x ORDER BY x),
              last_offer_at = EXCLUDED.last_offer_at, missed_probes = 0`,
      [
        c.organizationId,
        c.siteId,
        serverId,
        o.source_ip,
        o.server_mac ? normalizeMac(o.server_mac) : null,
        o.offered_ip ?? null,
        o.subnet_mask ?? null,
        o.routers,
        o.dns,
        o.lease_seconds ?? null,
        o.domain ?? null,
        interfaces,
        baseline,
        at,
      ],
    );
  }
  // Servers that answered before on one of the probed interfaces and are silent now.
  const probedNames = block.interfaces.filter((i) => !i.listen_error).map((i) => i.name);
  await db.query(
    `UPDATE dhcp_servers SET missed_probes = missed_probes + 1
      WHERE organization_id = $1 AND site_id = $2 AND last_offer_at IS NOT NULL AND NOT (server_id = ANY($3::inet[]))
        AND (cardinality(interfaces) = 0 OR interfaces && $4::text[])`,
    [c.organizationId, c.siteId, [...offers.keys()], probedNames],
  );

  // "No DHCP server answered" — counted per site.
  const noOffer = offers.size === 0;
  const probe = (
    await db.query<{ consecutive_no_offer: number; no_offer_open: boolean }>(
      `INSERT INTO dhcp_probe_state (organization_id, site_id, consecutive_no_offer, no_offer_open, probes, last_probe_at)
       VALUES ($1,$2,$3,false,1,$4)
       ON CONFLICT (organization_id, site_id) DO UPDATE
          SET consecutive_no_offer = CASE WHEN $3 = 1 THEN dhcp_probe_state.consecutive_no_offer + 1 ELSE 0 END,
              probes = dhcp_probe_state.probes + 1, last_probe_at = $4
       RETURNING consecutive_no_offer, no_offer_open`,
      [c.organizationId, c.siteId, noOffer ? 1 : 0, at],
    )
  ).rows[0]!;
  if (probe.consecutive_no_offer >= 2 && !probe.no_offer_open) {
    await db.query(`UPDATE dhcp_probe_state SET no_offer_open = true WHERE organization_id = $1 AND site_id = $2`, [c.organizationId, c.siteId]);
    await emitEvent(db, c.organizationId, {
      siteId: c.siteId,
      collectorId: c.id,
      type: 'dhcp_no_offer',
      severity: 'warning',
      title: 'No DHCP server is answering',
      details: {
        consecutive_probes_without_offer: probe.consecutive_no_offer,
        interfaces: probedNames,
        source: `DHCPDISCOVER probes from collector "${c.name}" (no lease is ever requested)`,
      },
      source: 'collector',
      occurredAt: at,
    });
  } else if (!noOffer && probe.no_offer_open) {
    await db.query(`UPDATE dhcp_probe_state SET no_offer_open = false WHERE organization_id = $1 AND site_id = $2`, [c.organizationId, c.siteId]);
    await emitEvent(db, c.organizationId, {
      siteId: c.siteId,
      collectorId: c.id,
      type: 'dhcp_offer_restored',
      severity: 'info',
      title: 'A DHCP server is answering again',
      details: { servers: [...offers.keys()] },
      source: 'collector',
      occurredAt: at,
    });
    await resolveOpenIncidentByKey(db, c.organizationId, dhcpIncidentKey(c.siteId, 'none'), 'a DHCP server answered the probe again', at);
  }
  await evaluateDhcpSite(db, c.organizationId, c.siteId, now, { collectorId: c.id, collectorName: c.name, at });
}

/** Passive evidence from the DHCP listener: clients overheard requesting a lease from `server_id` (option 54). */
export async function recordClientChoices(db: Db, c: CollectorContext, choices: { server_id: string; seen_at: Date }[], now: Date): Promise<void> {
  if (!choices.length) return;
  const byServer = new Map<string, { n: number; last: Date }>();
  for (const ch of choices) {
    const e = byServer.get(ch.server_id) ?? { n: 0, last: ch.seen_at };
    e.n += 1;
    if (ch.seen_at > e.last) e.last = ch.seen_at;
    byServer.set(ch.server_id, e);
  }
  for (const [serverId, e] of byServer) {
    await db.query(
      `INSERT INTO dhcp_servers (organization_id, site_id, server_id, first_seen_at, clients_choosing, last_client_choice_at)
       VALUES ($1,$2,$3,$4,$5,$4)
       ON CONFLICT (organization_id, site_id, server_id) DO UPDATE
          SET clients_choosing = dhcp_servers.clients_choosing + EXCLUDED.clients_choosing,
              last_client_choice_at = greatest(dhcp_servers.last_client_choice_at, EXCLUDED.last_client_choice_at)`,
      [c.organizationId, c.siteId, serverId, e.last, e.n],
    );
  }
  await evaluateDhcpSite(db, c.organizationId, c.siteId, now, { collectorId: c.id, collectorName: c.name, at: now });
}

interface ServerRow {
  id: string;
  server_id: string;
  source_ip: string | null;
  server_mac: string | null;
  offered_ip: string | null;
  routers: string[];
  dns_servers: string[];
  lease_seconds: number | null;
  baseline: boolean;
  expected: 'admin' | 'gateway' | 'baseline' | null;
  rogue_open: boolean;
  active: boolean;
  last_offer_at: Date | null;
  clients_choosing: number;
}

/**
 * Recompute which DHCP servers of a site are expected, open/close the "rogue DHCP server" state with
 * its event and finding, and resolve the incident when nothing unexpected is left. Called after every
 * probe, every passive observation and every "this is expected" decision.
 */
export async function evaluateDhcpSite(
  db: Db,
  organizationId: string,
  siteId: string,
  now: Date,
  origin: { collectorId: string | null; collectorName: string | null; at: Date },
): Promise<void> {
  const gateways = await siteGateways(db, organizationId, siteId);
  const approved = await approvedValues(db, organizationId, siteId, 'dhcp_server');
  const servers = (
    await db.query<ServerRow>(
      `SELECT id, host(server_id) AS server_id, host(source_ip) AS source_ip, server_mac::text AS server_mac, host(offered_ip) AS offered_ip,
              ARRAY(SELECT host(r) FROM unnest(routers) r) AS routers, ARRAY(SELECT host(d) FROM unnest(dns_servers) d) AS dns_servers,
              lease_seconds, baseline, expected, rogue_open, ${ACTIVE_SQL} AS active, last_offer_at, clients_choosing
         FROM dhcp_servers WHERE organization_id = $1 AND site_id = $2 FOR UPDATE`,
      [organizationId, siteId, now],
    )
  ).rows;

  const findings: FindingInput[] = [];
  let anyRogue = false;
  const wasRogue = servers.some((s) => s.rogue_open);
  for (const s of servers) {
    const expected: ServerRow['expected'] =
      approved.has(s.server_id) || (s.server_mac !== null && approved.has(s.server_mac.toLowerCase()))
        ? 'admin'
        : gateways.has(s.server_id) || (s.source_ip !== null && gateways.has(s.source_ip))
          ? 'gateway'
          : s.baseline
            ? 'baseline'
            : null;
    const rogue = expected === null && s.active;
    if (rogue) {
      anyRogue = true;
      const hijack = s.routers.some((r) => !gateways.has(r)) || s.routers.length === 0;
      findings.push({
        kind: 'dhcp_rogue_server',
        key: s.server_id,
        severity: 'critical',
        title: `Unexpected DHCP server ${s.server_id}${s.server_mac ? ` (${s.server_mac})` : ''}`,
        details: {
          server_id: s.server_id,
          source_ip: s.source_ip,
          server_mac: s.server_mac,
          offered_ip: s.offered_ip,
          routers: s.routers,
          dns_servers: s.dns_servers,
          lease_seconds: s.lease_seconds,
          clients_choosing: s.clients_choosing,
          gateway_mismatch: hijack,
          known_gateways: [...gateways],
          basis: s.last_offer_at ? 'observed: DHCPOFFER in reply to the collector’s DHCPDISCOVER' : 'observed: clients overheard requesting a lease from it',
          confidence: s.clients_choosing > 0 || s.last_offer_at ? 'high' : 'medium',
        },
      });
    }
    if (s.expected !== expected || s.rogue_open !== rogue) {
      await db.query(`UPDATE dhcp_servers SET expected = $2, rogue_open = $3 WHERE id = $1`, [s.id, expected, rogue]);
    }
    if (rogue && !s.rogue_open) {
      await emitEvent(db, organizationId, {
        siteId,
        collectorId: origin.collectorId,
        type: 'rogue_dhcp_server',
        severity: 'critical',
        title: `Unexpected DHCP server ${s.server_id} is answering`,
        details: {
          server_id: s.server_id,
          server_mac: s.server_mac,
          offered_ip: s.offered_ip,
          routers: s.routers,
          dns_servers: s.dns_servers,
          known_gateways: [...gateways],
          source: origin.collectorName ? `Collector "${origin.collectorName}"` : 'Nigafiy',
        },
        source: 'collector',
        occurredAt: origin.at,
      });
    }
  }
  const state = (await db.query<{ no_offer_open: boolean }>(`SELECT no_offer_open FROM dhcp_probe_state WHERE organization_id = $1 AND site_id = $2`, [organizationId, siteId])).rows[0];
  if (state?.no_offer_open) {
    findings.push({ kind: 'dhcp_no_offer', key: 'site', severity: 'warning', title: 'No DHCP server is answering', details: { basis: 'observed: consecutive DHCPDISCOVER probes without any offer' } });
  }
  await syncFindings(db, organizationId, siteId, 'dhcp', findings, now, { resolution: 'No longer observed by the DHCP probe' });

  if (wasRogue && !anyRogue) {
    await emitEvent(db, organizationId, {
      siteId,
      collectorId: origin.collectorId,
      type: 'rogue_dhcp_cleared',
      severity: 'info',
      title: 'No unexpected DHCP server is answering any more',
      details: { servers: servers.filter((s) => s.active).map((s) => s.server_id) },
      source: 'collector',
      occurredAt: origin.at,
    });
    await resolveOpenIncidentByKey(db, organizationId, dhcpIncidentKey(siteId, 'rogue'), 'no unexpected DHCP server answers any more', origin.at);
  }
}
