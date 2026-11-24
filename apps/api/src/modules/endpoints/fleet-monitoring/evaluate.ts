import type { Severity } from '@nigafiy/shared-types';
import type { Db } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import type { AgentMonitor } from './schema.ts';

// Evaluation of the monitoring rules on every heartbeat (Fleet Pro, migration 043).
//
// A rule applies to a computer when it is enabled and belongs to the computer's Fleet group (or to
// every computer). The heartbeat's measurement either breaches the rule, is healthy, or was not
// measured (an older agent, a query that failed: the state is kept, nothing is raised or resolved
// on a guess). A breach that lasts the rule's duration raises an `endpoint_monitor_breach` event
// in Watch (and an incident, key endpoint:<id>:rule:<id>); the first healthy measurement after
// that raises `endpoint_monitor_recovered`, which resolves the incident.

export const monitorIncidentKey = (endpointId: string, ruleId: string) => `endpoint:${endpointId}:rule:${ruleId}`;

interface RuleRow {
  id: string;
  name: string;
  kind: 'cpu' | 'memory' | 'disk_free' | 'service' | 'event_log';
  threshold: number | null;
  threshold_unit: 'pct' | 'gb' | 'count' | null;
  mount: string | null;
  service_name: string | null;
  event_log: string | null;
  event_source: string | null;
  event_ids: number[] | null;
  event_level: string | null;
  match_text: string | null;
  event_window_minutes: number | null;
  duration_seconds: number;
  severity: 'warning' | 'critical';
}

const RULES_FOR_ENDPOINT = `SELECT r.id, r.name, r.kind, r.threshold::float8 AS threshold, r.threshold_unit, r.mount, r.service_name, r.event_log, r.event_source,
         r.event_ids, r.event_level, r.match_text, r.event_window_minutes, r.duration_seconds, r.severity
    FROM fleet_monitor_rules r JOIN endpoints e ON e.id = $1
   WHERE r.enabled AND (r.fleet_group_id IS NULL OR r.fleet_group_id = e.fleet_group_id)
   ORDER BY r.created_at`;

/** What the agent must measure for this computer's rules (sent in the heartbeat answer). */
export async function monitorSpec(db: Db, endpointId: string) {
  const rules = (await db.query<RuleRow>(RULES_FOR_ENDPOINT, [endpointId])).rows;
  const services = [...new Set(rules.filter((r) => r.kind === 'service' && r.service_name).map((r) => r.service_name!))];
  const events = rules
    .filter((r) => r.kind === 'event_log')
    .map((r) => ({
      id: r.id,
      log: r.event_log ?? '',
      ...(r.event_source ? { source: r.event_source } : {}),
      ...(r.event_ids && r.event_ids.length > 0 ? { ids: r.event_ids } : {}),
      level: r.event_level ?? 'any',
      ...(r.match_text ? { match: r.match_text } : {}),
      window_minutes: r.event_window_minutes ?? 60,
    }));
  return { services, events };
}

export interface MonitorInput {
  cpuPct: number;
  ramPct: number;
  disks: { mount: string; free_gb?: number | undefined; total_gb?: number | undefined; used_pct: number }[] | null;
  monitor: AgentMonitor | undefined;
}

interface Measurement {
  breach: boolean | null;
  value: string;
}

const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

/** One rule against one heartbeat. `breach: null` = not measured (with why in `value`). */
export function measure(r: RuleRow, m: MonitorInput): Measurement {
  switch (r.kind) {
    case 'cpu':
      return { breach: m.cpuPct > r.threshold!, value: `CPU ${pct(m.cpuPct)} (alert above ${pct(r.threshold!)})` };
    case 'memory':
      return { breach: m.ramPct > r.threshold!, value: `Memory ${pct(m.ramPct)} used (alert above ${pct(r.threshold!)})` };
    case 'disk_free': {
      const disks = (m.disks ?? []).filter((d) => !r.mount || d.mount.toLowerCase() === r.mount.toLowerCase());
      if (disks.length === 0) return { breach: null, value: r.mount ? `Volume ${r.mount} not reported by the agent` : 'No volume reported by the agent' };
      const freeGb = (d: (typeof disks)[number]) => d.free_gb ?? ((d.total_gb ?? 0) * (100 - d.used_pct)) / 100;
      const freeOf = (d: (typeof disks)[number]) => (r.threshold_unit === 'gb' ? freeGb(d) : 100 - d.used_pct);
      const worst = disks.reduce((a, b) => (freeOf(b) < freeOf(a) ? b : a));
      const free = freeOf(worst);
      const unit = r.threshold_unit === 'gb' ? ' GB' : '%';
      return { breach: free < r.threshold!, value: `${worst.mount} ${Math.round(free * 10) / 10}${unit} free (alert below ${r.threshold}${unit})` };
    }
    case 'service': {
      const state = m.monitor?.services[r.service_name!];
      if (state === undefined || state === '' || state === 'unknown') return { breach: null, value: `Service ${r.service_name}: not measured${state === 'unknown' ? ' (the agent could not query it)' : ''}` };
      if (state === 'not_found') return { breach: true, value: `Service ${r.service_name} does not exist on this computer` };
      return { breach: state !== 'running', value: `Service ${r.service_name}: ${state}` };
    }
    case 'event_log': {
      const res = m.monitor?.events[r.id];
      if (!res) return { breach: null, value: 'Event log: not measured yet' };
      if (res.error) return { breach: null, value: `Event log not measured: ${res.error}`.slice(0, 300) };
      const value = `${res.count} matching entr${res.count === 1 ? 'y' : 'ies'} in ${r.event_window_minutes} min (alert at ${r.threshold})${res.sample ? `; newest: ${res.sample}` : ''}`;
      return { breach: res.count >= r.threshold!, value: value.slice(0, 300) };
    }
  }
}

interface EndpointRef {
  id: string;
  organization_id: string;
  site_id: string;
  device_id: string | null;
  name: string;
}

async function raise(db: Db, ep: EndpointRef, rule: { id: string; name: string; kind: string; severity: Severity }, kind: 'breach' | 'recovered', value: string, since: Date | null, now: Date, reason?: string): Promise<string> {
  const breach = kind === 'breach';
  return emitEvent(db, ep.organization_id, {
    siteId: ep.site_id,
    deviceId: ep.device_id,
    type: breach ? 'endpoint_monitor_breach' : 'endpoint_monitor_recovered',
    severity: breach ? rule.severity : 'info',
    title: breach ? `${ep.name}: ${rule.name} — ${value}` : `${ep.name}: ${rule.name} recovered${reason ? ` (${reason})` : ''}`,
    details: {
      endpoint_id: ep.id,
      endpoint_name: ep.name,
      rule_id: rule.id,
      rule_name: rule.name,
      rule_kind: rule.kind,
      value,
      breached_since: since ? since.toISOString() : null,
      ...(reason ? { reason } : {}),
    },
    source: 'platform',
    occurredAt: now,
    correlationKey: monitorIncidentKey(ep.id, rule.id),
  });
}

/** Evaluates every rule of the computer against this heartbeat (inside the heartbeat transaction). */
export async function evaluateMonitoring(db: Db, endpointId: string, input: MonitorInput, now: Date): Promise<void> {
  const ep = (await db.query<EndpointRef>(`SELECT id, organization_id, site_id, device_id, name FROM endpoints WHERE id = $1`, [endpointId])).rows[0];
  if (!ep) return;
  const rules = (await db.query<RuleRow>(RULES_FOR_ENDPOINT, [endpointId])).rows;
  const states = new Map(
    (
      await db.query<{ rule_id: string; breached_since: Date | null; alerted_at: Date | null }>(
        `SELECT rule_id, breached_since, alerted_at FROM fleet_monitor_states WHERE endpoint_id = $1 FOR UPDATE`,
        [endpointId],
      )
    ).rows.map((s) => [s.rule_id, s]),
  );
  for (const rule of rules) {
    const m = measure(rule, input);
    const st = states.get(rule.id);
    states.delete(rule.id);
    let since = st?.breached_since ?? null;
    let alerted = st?.alerted_at ?? null;
    let eventId: string | null = null;
    if (m.breach === true) {
      since ??= now;
      if (!alerted && now.getTime() - since.getTime() >= rule.duration_seconds * 1000) {
        eventId = await raise(db, ep, rule, 'breach', m.value, since, now);
        alerted = now;
      }
    } else if (m.breach === false) {
      if (alerted) await raise(db, ep, rule, 'recovered', m.value, since, now);
      since = null;
      alerted = null;
    }
    await db.query(
      `INSERT INTO fleet_monitor_states (rule_id, endpoint_id, organization_id, breached_since, alerted_at, alert_event_id, last_value, last_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (rule_id, endpoint_id) DO UPDATE
         SET breached_since = EXCLUDED.breached_since, alerted_at = EXCLUDED.alerted_at,
             alert_event_id = CASE WHEN EXCLUDED.alerted_at IS NULL THEN NULL ELSE coalesce(EXCLUDED.alert_event_id, fleet_monitor_states.alert_event_id) END,
             last_value = EXCLUDED.last_value, last_checked_at = EXCLUDED.last_checked_at`,
      [rule.id, endpointId, ep.organization_id, since, alerted, eventId, m.value.slice(0, 300), now],
    );
  }
  // Rules that no longer apply here (the computer changed group, the rule moved): their alerts end.
  for (const [ruleId, st] of states) {
    if (st.alerted_at) {
      const r = (await db.query<{ id: string; name: string; kind: string; severity: Severity }>(`SELECT id, name, kind, severity FROM fleet_monitor_rules WHERE id = $1`, [ruleId])).rows[0];
      if (r) await raise(db, ep, r, 'recovered', 'the rule no longer applies to this computer', st.breached_since, now, 'the rule no longer applies to this computer');
    }
    await db.query(`DELETE FROM fleet_monitor_states WHERE rule_id = $1 AND endpoint_id = $2`, [ruleId, endpointId]);
  }
}

/** A rule changed, was turned off or deleted: its open alerts are resolved and its states cleared. */
export async function recoverRuleAlerts(db: Db, orgId: string, ruleId: string, reason: string): Promise<void> {
  const rule = (await db.query<{ id: string; name: string; kind: string; severity: Severity }>(`SELECT id, name, kind, severity FROM fleet_monitor_rules WHERE id = $1`, [ruleId])).rows[0];
  if (!rule) return;
  const alerted = (
    await db.query<EndpointRef & { breached_since: Date | null }>(
      `SELECT e.id, e.organization_id, e.site_id, e.device_id, e.name, s.breached_since
         FROM fleet_monitor_states s JOIN endpoints e ON e.id = s.endpoint_id
        WHERE s.rule_id = $1 AND s.alerted_at IS NOT NULL AND s.organization_id = $2`,
      [ruleId, orgId],
    )
  ).rows;
  const now = new Date();
  for (const ep of alerted) await raise(db, ep, rule, 'recovered', reason, ep.breached_since, now, reason);
  await db.query(`DELETE FROM fleet_monitor_states WHERE rule_id = $1`, [ruleId]);
}
