import type { Diagnosis, FaultDomain } from '@lan-detective/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { type CheckFacts, type NetworkFacts, diagnoseCollector, diagnoseDevice, diagnoseNetwork, diagnoseService, finalize } from './rules.ts';
import { loadDhcpFacts } from './smart-facts.ts';
import { diagnoseDhcp } from './smart-rules.ts';

// Every query filters organization_id explicitly: this code also runs inside platform (system)
// transactions, where Row Level Security does not apply.

const CHECK_FACTS_SQL = `
  SELECT c.id, c.name, c.kind, c.role, c.target, c.port, c.state, c.last_result_at, c.last_latency_ms, c.last_loss_pct,
         c.last_error, c.last_resolved_target, c.latency_warn_ms, c.config, c.last_value, c.last_details,
         coalesce(r.samples, 0)::int AS recent_samples, coalesce(r.ok, 0)::int AS recent_ok,
         r.latency::float8 AS recent_latency_ms, r.loss::float8 AS recent_loss_pct,
         b.latency::float8 AS baseline_latency_ms, coalesce(b.samples, 0)::int AS baseline_samples
    FROM monitoring_checks c
    LEFT JOIN LATERAL (
      SELECT count(*) AS samples, count(*) FILTER (WHERE ok) AS ok, avg(latency_ms) FILTER (WHERE ok) AS latency, avg(loss_pct) AS loss
        FROM check_results WHERE check_id = c.id AND ts > $3::timestamptz - interval '15 minutes' AND ts <= $3) r ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS samples, avg(latency_ms) AS latency
        FROM check_results WHERE check_id = c.id AND ok AND ts > $3::timestamptz - interval '7 days' AND ts < $3::timestamptz - interval '1 hour') b ON true
   WHERE c.organization_id = $1 AND c.enabled`;

async function loadNetworkFacts(db: Db, organizationId: string, siteId: string, now: Date): Promise<NetworkFacts> {
  const checks = await db.query<CheckFacts>(`${CHECK_FACTS_SQL} AND c.site_id = $2 AND c.role <> 'service'`, [organizationId, siteId, now]);
  const collectors = await db.query<{ total: number; online: number; last_heartbeat_at: Date | null }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE connection_state = 'online')::int AS online, max(last_heartbeat_at) AS last_heartbeat_at
       FROM collectors WHERE organization_id = $1 AND site_id = $2 AND status = 'active'`,
    [organizationId, siteId],
  );
  const devices = await db.query<{ total: number; offline: number; went_offline_recently: number }>(
    `SELECT (SELECT count(*) FROM devices WHERE organization_id = $1 AND site_id = $2)::int AS total,
            (SELECT count(*) FROM devices WHERE organization_id = $1 AND site_id = $2 AND status = 'offline')::int AS offline,
            (SELECT count(DISTINCT device_id) FROM network_events
              WHERE organization_id = $1 AND site_id = $2 AND type = 'device_offline' AND occurred_at > $3::timestamptz - interval '30 minutes')::int AS went_offline_recently`,
    [organizationId, siteId, now],
  );
  const changes = await db.query<{ type: string; title: string; occurred_at: Date }>(
    `SELECT type, title, occurred_at FROM network_events
      WHERE organization_id = $1 AND site_id = $2 AND occurred_at > $3::timestamptz - interval '2 hours'
        AND type IN ('device_discovered', 'ip_mac_changed', 'device_ip_changed', 'collector_enrolled')
      ORDER BY occurred_at DESC LIMIT 5`,
    [organizationId, siteId, now],
  );
  return { now, checks: checks.rows, collectors: collectors.rows[0]!, devices: devices.rows[0]!, recent_changes: changes.rows };
}

function affectedOf(facts: NetworkFacts): Diagnosis['affected'] {
  return {
    devices_offline: facts.devices.offline,
    devices_total: facts.devices.total,
    checks: facts.checks.filter((c) => c.state === 'down' || c.state === 'degraded').map(({ id, name, role, state }) => ({ id, name, role, state })),
  };
}

/** Earlier, resolved incidents at the same site that ended with the same fault domain. */
async function relatedIncidents(db: Db, organizationId: string, siteId: string | null, domain: FaultDomain, excludeId: string | null): Promise<Diagnosis['related_incidents']> {
  if (!siteId || domain === 'healthy' || domain === 'insufficient_data') return [];
  const rows = await db.query<Diagnosis['related_incidents'][number]>(
    `SELECT id, number, title, opened_at, resolved_at, resolution_note
       FROM incidents
      WHERE organization_id = $1 AND site_id = $2 AND status = 'resolved' AND diagnosis ->> 'fault_domain' = $3
        AND ($4::uuid IS NULL OR id <> $4) AND opened_at > now() - interval '180 days'
      ORDER BY opened_at DESC LIMIT 5`,
    [organizationId, siteId, domain, excludeId],
  );
  return rows.rows;
}

export async function diagnoseSiteNetwork(db: Db, organizationId: string, siteId: string, excludeIncidentId: string | null = null, now = new Date()): Promise<Diagnosis> {
  const facts = await loadNetworkFacts(db, organizationId, siteId, now);
  const core = diagnoseNetwork(facts);
  return finalize(core, affectedOf(facts), await relatedIncidents(db, organizationId, siteId, core.fault_domain, excludeIncidentId), now);
}

export interface IncidentRef {
  id: string;
  kind: 'network' | 'service' | 'collector' | 'device' | 'dhcp';
  site_id: string | null;
  check_id: string | null;
  device_id: string | null;
  collector_id: string | null;
  opened_at: Date;
  resolved_at: Date | null;
}

/** Run the rule set that matches the incident kind. Returns null when the subject no longer exists. */
export async function diagnoseIncident(db: Db, organizationId: string, incident: IncidentRef, now = new Date()): Promise<Diagnosis | null> {
  if (!incident.site_id) return null;
  const facts = await loadNetworkFacts(db, organizationId, incident.site_id, now);
  const network = diagnoseNetwork(facts);
  const done = async (core: ReturnType<typeof diagnoseNetwork>) =>
    finalize(core, affectedOf(facts), await relatedIncidents(db, organizationId, incident.site_id, core.fault_domain, incident.id), now);

  if (incident.kind === 'network') return done(network);
  // Rogue DHCP server / no DHCP offer (modules/security smart checks): smart-rules.ts.
  if (incident.kind === 'dhcp') return done(diagnoseDhcp(await loadDhcpFacts(db, organizationId, incident.site_id, now)));

  if (incident.kind === 'service') {
    if (!incident.check_id) return null;
    const check = (await db.query<CheckFacts>(`${CHECK_FACTS_SQL} AND c.site_id = $2 AND c.id = $4`, [organizationId, incident.site_id, now, incident.check_id])).rows[0];
    if (!check) return null;
    const host = await db.query<{ name: string; status: 'online' | 'offline' | 'unknown'; last_seen_at: Date }>(
      `SELECT coalesce(display_name, hostname, host(current_ip)) AS name, status, last_seen_at
         FROM devices WHERE organization_id = $1 AND site_id = $2 AND (host(current_ip) = $3 OR hostname = $3) ORDER BY last_seen_at DESC LIMIT 1`,
      [organizationId, incident.site_id, check.last_resolved_target ?? check.target],
    );
    return done(diagnoseService({ check, host: host.rows[0] ?? null, network: network.fault_domain }));
  }

  if (incident.kind === 'device') {
    if (!incident.device_id) return null;
    const device = (
      await db.query<{ name: string; ip: string | null; last_seen_at: Date; missed: number }>(
        `SELECT coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS name, host(current_ip) AS ip, last_seen_at, missed_sweeps AS missed
           FROM devices WHERE organization_id = $1 AND id = $2`,
        [organizationId, incident.device_id],
      )
    ).rows[0];
    if (!device) return null;
    return done(diagnoseDevice({ ...device, network: network.fault_domain, devices: facts.devices }));
  }

  if (!incident.collector_id) return null;
  const collector = (
    await db.query<{ name: string; last_heartbeat_at: Date | null; connection_state: string }>(
      `SELECT name, last_heartbeat_at, connection_state FROM collectors WHERE organization_id = $1 AND id = $2`,
      [organizationId, incident.collector_id],
    )
  ).rows[0];
  if (!collector) return null;
  // Samples the collector took while the cloud could not hear it (available once it has reconnected and uploaded).
  const during = await db.query<{ samples: number; internet_failed: number; gateway_failed: number }>(
    `SELECT count(*)::int AS samples,
            count(*) FILTER (WHERE NOT r.ok AND c.role = 'internet')::int AS internet_failed,
            count(*) FILTER (WHERE NOT r.ok AND c.role = 'gateway')::int AS gateway_failed
       FROM check_results r JOIN monitoring_checks c ON c.id = r.check_id
      WHERE c.organization_id = $1 AND c.site_id = $2 AND c.role IN ('gateway', 'internet')
        AND r.ts > $3::timestamptz - interval '2 minutes' AND r.ts <= $4`,
    [organizationId, incident.site_id, incident.opened_at, incident.resolved_at ?? now],
  );
  return done(diagnoseCollector({ name: collector.name, last_heartbeat_at: collector.last_heartbeat_at, online: collector.connection_state === 'online', during: during.rows[0]! }));
}
