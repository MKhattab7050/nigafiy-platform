import type { Router } from 'express';
import { z } from 'zod';
import type {
  CheckSeriesPoint,
  DeviceDetail,
  DoctorReport,
  Incident,
  IncidentDetail,
  InsightsReport,
  MonitoringCheck,
  NetworkEvent,
  Paginated,
  SearchResponse,
  Site,
  Topology,
} from '@lan-detective/shared-types';
import { AppError, type AuthContext } from '../../common/http.ts';
import { devicesModule } from '../devices/index.ts';
import { eventsModule } from '../events/index.ts';
import { incidentsModule } from '../incidents/index.ts';
import { insightsModule } from '../insights/index.ts';
import { monitoringModule } from '../monitoring/index.ts';
import { overviewModule } from '../overview/index.ts';
import { portsModule } from '../ports/index.ts';
import { sitesModule } from '../sites/index.ts';
import { topologyModule } from '../topology/index.ts';
import type { ToolDefinition } from './client.ts';
import { readApi } from './read-api.ts';

/**
 * The assistant's lookups. Every one is READ-ONLY: it calls an existing GET handler through
 * readApi (the user's tenant transaction and role), trims the answer to what helps, and records
 * which records it read so the answer can cite them as links.
 *
 * Nothing here can change anything: there is no tool that creates, edits, deletes, queues a command
 * or contacts a device. When a next step needs an action, the model points to the page where a
 * person does it.
 */

export type EntityKind = 'device' | 'incident' | 'endpoint' | 'site';

export interface Entity {
  kind: EntityKind;
  id: string;
  label: string;
}

export interface Lookup {
  tool: string;
  /** The tool's input, as the user may see it ("what was looked up"). */
  input: Record<string, unknown>;
  ok: boolean;
  /** How many records came back (when it is a list). */
  count: number | null;
  error?: string;
}

export interface ToolContext {
  auth: AuthContext;
  entities: Map<string, Entity>;
}

const router = (m: { api?: Router }, name: string): Router => {
  if (!m.api) throw new Error(`assistant: module ${name} has no API router`);
  return m.api;
};

const R = {
  overview: router(overviewModule, 'overview'),
  devices: router(devicesModule, 'devices'),
  ports: router(portsModule, 'ports'),
  incidents: router(incidentsModule, 'incidents'),
  events: router(eventsModule, 'events'),
  insights: router(insightsModule, 'insights'),
  monitoring: router(monitoringModule, 'monitoring'),
  topology: router(topologyModule, 'topology'),
  sites: router(sitesModule, 'sites'),
};

/** A citation marker the model copies into its answer; the server keeps only markers it handed out. */
export const marker = (kind: EntityKind, id: string) => `[[${kind}:${id}]]`;

function remember(t: ToolContext, kind: EntityKind, id: string, label: string | null | undefined) {
  const key = `${kind}:${id}`;
  if (!t.entities.has(key)) t.entities.set(key, { kind, id, label: (label ?? id).slice(0, 80) });
  return marker(kind, id);
}

const uuid = z.uuid();
const optionalUuid = uuid.optional();

interface ToolSpec<S extends z.ZodType> {
  definition: ToolDefinition;
  input: S;
  run: (t: ToolContext, input: z.infer<S>) => Promise<{ data: unknown; count: number | null }>;
}

const spec = <S extends z.ZodType>(s: ToolSpec<S>) => s;

const siteIdProp = { type: 'string', description: 'Optional site id (from list_sites) to limit the lookup to one site.' };

const deviceSummary = (t: ToolContext, d: { id: string; display_name?: string | null; hostname?: string | null; current_ip?: string | null; primary_mac?: string | null }) => ({
  cite: remember(t, 'device', d.id, d.display_name ?? d.hostname ?? d.current_ip ?? d.primary_mac),
});

export const TOOLS = [
  spec({
    definition: {
      name: 'list_sites',
      description: 'List the sites (locations) of this organization with their ids. Use it to resolve a site name to a site_id.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    input: z.object({}).strict(),
    async run(t) {
      const sites = await readApi<{ items: Site[] }>(R.sites, t.auth, '/sites');
      return { data: { sites: sites.items.map((s) => ({ site_id: s.id, name: s.name, timezone: s.timezone })) }, count: sites.items.length };
    },
  }),

  spec({
    definition: {
      name: 'search_inventory',
      description:
        'Search devices, managed computers (endpoints), incidents, switches, subnets and routers by name, hostname, IP address, MAC address, vendor, tag or incident number. Returns up to 15 matches with ids.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Text to search for, e.g. "printer", "192.168.1.20", "aa:bb:cc", "#42".' }, site_id: siteIdProp },
        required: ['query'],
        additionalProperties: false,
      },
    },
    input: z.object({ query: z.string().trim().min(1).max(120), site_id: optionalUuid }).strict(),
    async run(t, input) {
      const res = await readApi<SearchResponse>(R.overview, t.auth, '/search', { q: input.query, site_id: input.site_id });
      const items = res.items.slice(0, 15).map((h) => {
        const kind: EntityKind | null = h.kind === 'device' ? 'device' : h.kind === 'endpoint' ? 'endpoint' : h.kind === 'incident' ? 'incident' : null;
        return {
          kind: h.kind,
          id: h.id,
          title: h.title,
          subtitle: h.subtitle,
          status: h.status,
          site_name: h.site_name,
          ...(kind ? { cite: remember(t, kind, h.id, h.title) } : {}),
        };
      });
      return { data: { matches: items }, count: items.length };
    },
  }),

  spec({
    definition: {
      name: 'get_device',
      description:
        'Full record of one discovered device: names, IP and MAC, vendor, type with the evidence and confidence it was classified with, status, trust, IP history, availability of the last 7 days, the switch port it is plugged into (when a switch is read over SNMP) and its 15 most recent events.',
      input_schema: { type: 'object', properties: { device_id: { type: 'string', description: 'Device id (from search_inventory).' } }, required: ['device_id'], additionalProperties: false },
    },
    input: z.object({ device_id: uuid }).strict(),
    async run(t, input) {
      const d = await readApi<DeviceDetail>(R.devices, t.auth, `/devices/${input.device_id}`);
      let port: unknown = null;
      try {
        port = await readApi(R.ports, t.auth, `/devices/${input.device_id}/port`);
      } catch {
        port = { location: null, reason: 'not available' };
      }
      return {
        data: {
          ...deviceSummary(t, d),
          id: d.id,
          site_id: d.site_id,
          site_name: d.site_name,
          display_name: d.display_name,
          hostname: d.hostname,
          name_source: d.name_source,
          current_ip: d.current_ip,
          primary_mac: d.primary_mac,
          mac_randomized: d.mac_randomized,
          vendor: d.vendor,
          device_type: d.device_type,
          type_source: d.type_source,
          type_confidence: d.type_confidence,
          type_evidence: d.type_evidence,
          fingerprint: d.fingerprint,
          status: d.status,
          is_critical: d.is_critical,
          trust: d.trust,
          alerts_muted: d.alerts_muted,
          monitored: Boolean(d.monitor_check_id),
          owner: d.owner,
          tags: d.tags,
          discovery_sources: d.discovery_sources,
          first_seen_at: d.first_seen_at,
          last_seen_at: d.last_seen_at,
          ip_history: d.ip_history.slice(0, 5),
          availability_7d: d.availability.slice(-10),
          switch_port: port,
          recent_events: d.recent_events.slice(0, 15).map((e) => ({ type: e.type, severity: e.severity, title: e.title, occurred_at: e.occurred_at })),
        },
        count: null,
      };
    },
  }),

  spec({
    definition: {
      name: 'list_open_incidents',
      description: 'Incidents that are not resolved yet (open or acknowledged), most severe first, with the Network Doctor fault domain and confidence of each.',
      input_schema: { type: 'object', properties: { site_id: siteIdProp }, additionalProperties: false },
    },
    input: z.object({ site_id: optionalUuid }).strict(),
    async run(t, input) {
      const res = await readApi<Paginated<Incident>>(R.incidents, t.auth, '/incidents', { status: 'active', site_id: input.site_id, page_size: 20 });
      const items = res.items.map((i) => ({
        cite: remember(t, 'incident', i.id, `INC-${i.number} ${i.title}`),
        id: i.id,
        number: i.number,
        title: i.title,
        kind: i.kind,
        status: i.status,
        severity: i.severity,
        site_name: i.site_name,
        fault_domain: i.fault_domain,
        confidence: i.confidence,
        opened_at: i.opened_at,
        acknowledged_at: i.acknowledged_at,
        assigned_to_name: i.assigned_to_name,
      }));
      return { data: { total_open: res.total, incidents: items }, count: items.length };
    },
  }),

  spec({
    definition: {
      name: 'get_incident',
      description:
        "One incident with its Network Doctor diagnosis exactly as the deterministic rule engine produced it (evidence, what was ruled out, alternatives, confidence, investigation steps, recommendations, similar past incidents), its activity and the events around it.",
      input_schema: { type: 'object', properties: { incident_id: { type: 'string', description: 'Incident id (from list_open_incidents or search_inventory).' } }, required: ['incident_id'], additionalProperties: false },
    },
    input: z.object({ incident_id: uuid }).strict(),
    async run(t, input) {
      const i = await readApi<IncidentDetail>(R.incidents, t.auth, `/incidents/${input.incident_id}`);
      return {
        data: {
          cite: remember(t, 'incident', i.id, `INC-${i.number} ${i.title}`),
          id: i.id,
          number: i.number,
          title: i.title,
          kind: i.kind,
          status: i.status,
          severity: i.severity,
          site_name: i.site_name,
          opened_at: i.opened_at,
          acknowledged_at: i.acknowledged_at,
          resolved_at: i.resolved_at,
          resolution_kind: i.resolution_kind,
          resolution_note: i.resolution_note,
          device: i.device_id ? { device_id: i.device_id, cite: remember(t, 'device', i.device_id, null) } : null,
          diagnosis: i.diagnosis ? diagnosisForModel(i.diagnosis) : null,
          diagnosed_at: i.diagnosed_at,
          activity: i.activity.slice(-8).map((a) => ({ kind: a.kind, user_name: a.user_name, body: a.body, created_at: a.created_at })),
          events_around: i.timeline.slice(-15).map((e) => ({ phase: e.phase, type: e.type, severity: e.severity, title: e.title, occurred_at: e.occurred_at })),
        },
        count: null,
      };
    },
  }),

  spec({
    definition: {
      name: 'get_network_diagnosis',
      description:
        "Network Doctor's live diagnosis of each site's network path right now (gateway, internet / ISP, DNS, quality): conclusion, confidence, evidence, what was ruled out and next steps, plus the active network incident if any.",
      input_schema: { type: 'object', properties: { site_id: siteIdProp }, additionalProperties: false },
    },
    input: z.object({ site_id: optionalUuid }).strict(),
    async run(t, input) {
      const res = await readApi<{ items: DoctorReport[] }>(R.incidents, t.auth, '/doctor', { site_id: input.site_id });
      const items = res.items.slice(0, 10).map((r) => ({
        site_id: r.site_id,
        site_name: r.site_name,
        collectors_online: r.collectors_online,
        active_incident: r.active_incident ? { number: r.active_incident.number, cite: remember(t, 'incident', r.active_incident.id, `INC-${r.active_incident.number}`) } : null,
        diagnosis: diagnosisForModel(r.diagnosis),
      }));
      return { data: { sites: items }, count: items.length };
    },
  }),

  spec({
    definition: {
      name: 'recent_events',
      description: 'Recent events from the timeline (devices joining or going offline, check failures, IP changes, collector problems...), newest first. Filter by site, device, severity or event type.',
      input_schema: {
        type: 'object',
        properties: {
          site_id: siteIdProp,
          device_id: { type: 'string', description: 'Only events of this device.' },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
          type: { type: 'string', description: 'Event type, e.g. device_offline, check_down, device_discovered.' },
          hours: { type: 'integer', minimum: 1, maximum: 168, description: 'How far back (default 24).' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum events (default 25).' },
        },
        additionalProperties: false,
      },
    },
    input: z
      .object({
        site_id: optionalUuid,
        device_id: optionalUuid,
        severity: z.enum(['info', 'warning', 'critical']).optional(),
        type: z.string().regex(/^[a-z_]{1,60}$/).optional(),
        hours: z.number().int().min(1).max(168).default(24),
        limit: z.number().int().min(1).max(50).default(25),
      })
      .strict(),
    async run(t, input) {
      const from = new Date(Date.now() - input.hours * 3600_000).toISOString();
      const res = await readApi<{ items: NetworkEvent[] }>(R.events, t.auth, '/events', {
        site_id: input.site_id,
        device_id: input.device_id,
        severity: input.severity,
        type: input.type,
        from,
        limit: input.limit,
      });
      const items = res.items.map((e) => ({
        type: e.type,
        severity: e.severity,
        title: e.title,
        site_name: e.site_name,
        occurred_at: e.occurred_at,
        in_maintenance: e.in_maintenance,
        ...(e.device_id ? { cite: remember(t, 'device', e.device_id, null) } : {}),
      }));
      return { data: { since: from, events: items }, count: items.length };
    },
  }),

  spec({
    definition: {
      name: 'get_insights',
      description: 'The network health score (0-100) with each deduction and the findings of the deterministic insight rules (security, availability, performance, inventory, setup), each with its evidence.',
      input_schema: { type: 'object', properties: { site_id: siteIdProp }, additionalProperties: false },
    },
    input: z.object({ site_id: optionalUuid }).strict(),
    async run(t, input) {
      const r = await readApi<InsightsReport>(R.insights, t.auth, '/insights', { site_id: input.site_id });
      const findings = r.insights.slice(0, 15).map((i) => ({
        severity: i.severity,
        category: i.category,
        title: i.title,
        detail: i.detail,
        evidence: i.evidence.slice(0, 5),
        devices: (i.devices ?? []).slice(0, 5).map((d) => ({ cite: remember(t, 'device', d.device_id, d.label) })),
      }));
      return { data: { generated_at: r.generated_at, score: r.score, score_breakdown: r.score_breakdown, findings }, count: findings.length };
    },
  }),

  spec({
    definition: {
      name: 'get_checks',
      description:
        'Monitoring checks (gateway, internet, DNS and service checks) with their current state and last latency / loss. With check_id, also a summary of that check\'s history over a range (availability %, average and worst latency, loss).',
      input_schema: {
        type: 'object',
        properties: {
          site_id: siteIdProp,
          check_id: { type: 'string', description: 'A check id from a previous get_checks call, to summarize its history.' },
          range: { type: 'string', enum: ['1h', '24h', '7d', '30d'], description: 'History range for check_id (default 24h).' },
        },
        additionalProperties: false,
      },
    },
    input: z.object({ site_id: optionalUuid, check_id: optionalUuid, range: z.enum(['1h', '24h', '7d', '30d']).default('24h') }).strict(),
    async run(t, input) {
      const res = await readApi<{ items: MonitoringCheck[] }>(R.monitoring, t.auth, '/checks', { site_id: input.site_id });
      const checks = res.items.slice(0, 40).map((c) => ({
        check_id: c.id,
        site_name: c.site_name,
        name: c.name,
        kind: c.kind,
        role: c.role,
        target: c.target,
        port: c.port,
        enabled: c.enabled,
        state: c.state,
        state_changed_at: c.state_changed_at,
        last_result_at: c.last_result_at,
        last_latency_ms: c.last_latency_ms,
        last_loss_pct: c.last_loss_pct,
        last_error: c.last_error,
      }));
      let history: unknown = undefined;
      if (input.check_id) {
        const series = await readApi<{ points: CheckSeriesPoint[] }>(R.monitoring, t.auth, `/checks/${input.check_id}/series`, { range: input.range });
        history = { range: input.range, ...summarizeSeries(series.points ?? []) };
      }
      return { data: { checks, ...(history ? { history } : {}) }, count: checks.length };
    },
  }),

  spec({
    definition: {
      name: 'get_topology_neighbors',
      description:
        'Where a device sits in the network map: its links (switch port, subnet segment, gateway) and the directly connected nodes, each link labelled observed or inferred with evidence and confidence, plus what the map cannot know.',
      input_schema: { type: 'object', properties: { device_id: { type: 'string', description: 'Device id.' } }, required: ['device_id'], additionalProperties: false },
    },
    input: z.object({ device_id: uuid }).strict(),
    async run(t, input) {
      const d = await readApi<DeviceDetail>(R.devices, t.auth, `/devices/${input.device_id}`);
      const topo = await readApi<Topology>(R.topology, t.auth, '/topology', { site_id: d.site_id });
      const nodeId = `dev:${d.id}`;
      const node = topo.nodes.find((n) => n.id === nodeId || n.device_id === d.id);
      if (!node) return { data: { ...deviceSummary(t, d), in_map: false, limitations: topo.limitations }, count: 0 };
      const edges = topo.edges.filter((e) => e.source === node.id || e.target === node.id).slice(0, 25);
      const neighborIds = new Set(edges.map((e) => (e.source === node.id ? e.target : e.source)));
      const neighbors = topo.nodes
        .filter((n) => neighborIds.has(n.id))
        .slice(0, 25)
        .map((n) => ({ node: n.id, kind: n.kind, label: n.label, ip: n.ip, status: n.status, is_switch: n.is_switch ?? false, ...(n.device_id ? { cite: remember(t, 'device', n.device_id, n.label) } : {}) }));
      return {
        data: {
          ...deviceSummary(t, d),
          node: { node: node.id, label: node.label, segment: node.segment, attached_to: node.attached_to ?? null },
          links: edges.map((e) => ({ from: e.source, to: e.target, relation: e.relation, port: e.port ?? null, basis: e.basis, confidence: e.confidence, evidence: e.evidence, last_verified_at: e.last_verified_at })),
          neighbors,
          limitations: topo.limitations,
        },
        count: neighbors.length,
      };
    },
  }),
] as const;

/** The deterministic diagnosis, trimmed to what explains it (no internal ids beyond citations). */
export function diagnosisForModel(d: NonNullable<IncidentDetail['diagnosis']>) {
  return {
    engine: d.engine,
    rule: d.rule,
    fault_domain: d.fault_domain,
    title: d.title,
    summary: d.summary,
    probable_cause: d.probable_cause,
    confidence: d.confidence,
    confidence_reason: d.confidence_reason,
    evidence: d.evidence.slice(0, 15),
    ruled_out: d.ruled_out.slice(0, 10),
    alternatives: d.alternatives,
    investigation_steps: d.investigation_steps,
    recommendations: d.recommendations,
    affected: { devices_offline: d.affected.devices_offline, devices_total: d.affected.devices_total, checks: d.affected.checks.map((c) => ({ name: c.name, role: c.role, state: c.state })) },
    similar_past_incidents: d.related_incidents.map((r) => ({ number: r.number, title: r.title, opened_at: r.opened_at, resolved_at: r.resolved_at, resolution_note: r.resolution_note })),
    generated_at: d.generated_at,
  };
}

function summarizeSeries(points: CheckSeriesPoint[]) {
  const samples = points.reduce((s, p) => s + (p.samples ?? 0), 0);
  if (!samples) return { samples: 0, note: 'No measurements in this range.' };
  const ok = points.reduce((s, p) => s + (p.ok_ratio ?? 0) * (p.samples ?? 0), 0);
  const lat = points.filter((p) => p.latency_ms !== null);
  const avgLatency = lat.length ? lat.reduce((s, p) => s + (p.latency_ms ?? 0), 0) / lat.length : null;
  const worst = points.reduce<number | null>((m, p) => (p.latency_max_ms !== null && (m === null || p.latency_max_ms > m) ? p.latency_max_ms : m), null);
  const loss = points.filter((p) => p.loss_pct !== null);
  const worstBucket = [...points].sort((a, b) => (a.ok_ratio ?? 1) - (b.ok_ratio ?? 1))[0];
  return {
    samples,
    availability_pct: Math.round((ok / samples) * 1000) / 10,
    avg_latency_ms: avgLatency === null ? null : Math.round(avgLatency * 10) / 10,
    worst_latency_ms: worst,
    avg_loss_pct: loss.length ? Math.round((loss.reduce((s, p) => s + (p.loss_pct ?? 0), 0) / loss.length) * 10) / 10 : null,
    worst_period: worstBucket && (worstBucket.ok_ratio ?? 1) < 1 ? { at: worstBucket.ts, ok_ratio: worstBucket.ok_ratio } : null,
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map((t) => t.definition);
const BY_NAME = new Map<string, (typeof TOOLS)[number]>(TOOLS.map((t) => [t.definition.name, t]));

/**
 * Run one tool call from the model. Never throws: an invalid input, a missing record or a
 * permission refusal becomes an error result the model can read (and the lookup list shows).
 */
export async function runTool(t: ToolContext, name: string, rawInput: unknown): Promise<{ ok: boolean; data: unknown; lookup: Lookup }> {
  const tool = BY_NAME.get(name);
  const shownInput = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? Object.fromEntries(Object.entries(rawInput as Record<string, unknown>).slice(0, 8).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 120) : v])) : {};
  if (!tool) return { ok: false, data: { error: `Unknown tool "${name}". Only the listed read-only tools exist.` }, lookup: { tool: name, input: shownInput, ok: false, count: null, error: 'unknown_tool' } };
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return { ok: false, data: { error: `Invalid input: ${message}` }, lookup: { tool: name, input: shownInput, ok: false, count: null, error: 'invalid_input' } };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, count } = await (tool.run as (t: ToolContext, i: any) => Promise<{ data: unknown; count: number | null }>)(t, parsed.data);
    return { ok: true, data, lookup: { tool: name, input: shownInput, ok: true, count } };
  } catch (err) {
    const e = err instanceof AppError ? err : null;
    const code = e?.code ?? 'lookup_failed';
    const message = e ? (e.status === 404 ? 'Not found in this organization.' : e.status === 403 ? 'Your role does not allow this lookup.' : e.message) : 'The lookup failed.';
    return { ok: false, data: { error: message }, lookup: { tool: name, input: shownInput, ok: false, count: null, error: code } };
  }
}
