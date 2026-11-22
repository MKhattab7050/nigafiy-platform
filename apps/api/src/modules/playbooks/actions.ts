import type { ToolKind } from '@lan-detective/shared-types';
import { AppError } from '../../common/http.ts';
import type { Db } from '../../infrastructure/db.ts';
import { dnsFilterEnabled, setDeviceInternetPause } from '../access/index.ts';
import { collectorCommandStates, queueSiteCollectorCommand } from '../collectors/index.ts';
import {
  configBackupCollector,
  configBackupReadiness,
  expireStaleConfigBackups,
  loadConfigBackupTarget,
  queueConfigBackupRun,
} from '../configbackup/index.ts';
import { queueWakeOnLan, setDeviceTrust } from '../devices/index.ts';
import { endpointCommandState, parseAutomatableCommand, queueEndpointCommandFor } from '../endpoints/index.ts';
import { emitEvent } from '../events/index.ts';
import { acknowledgeIncident, commentOnIncident } from '../incidents/index.ts';
import { queueToolRun, toolRunState } from '../toolbox/index.ts';
import { ACTIONS, LIMITS } from './catalog.ts';
import type { ExternalRef, RunRow, StepRow } from './repo.ts';

// One executor per catalogue action. Every executor acts through the owning module's own service
// (the same rules as its routes), inside the engine's tenant transaction. Router actions are the
// exception: they run only inside the approving administrator's request (routers/control.ts needs
// the request: audit trail, "never block the machine you are using"), see engine.ts executeRouterStep.

/** Who the step acts for: the approving administrator, or LAN Detective itself (null). */
export interface StepActor {
  id: string;
  email: string;
  role: string;
}

export interface ActionContext {
  db: Db;
  organizationId: string;
  run: RunRow;
  step: StepRow;
  /** Every step of the run, in order (for conditions and attachments). */
  steps: StepRow[];
  actor: StepActor | null;
  now: Date;
}

export type ActionOutcome =
  | { kind: 'done'; input?: Record<string, unknown>; output: Record<string, unknown> }
  | { kind: 'failed'; input?: Record<string, unknown>; error: string }
  | { kind: 'pending'; input?: Record<string, unknown>; output?: Record<string, unknown>; external: ExternalRef }
  /** A condition decided the run ends here (not a failure). */
  | { kind: 'stop'; input?: Record<string, unknown>; output: Record<string, unknown>; reason: string }
  | { kind: 'previewed'; input: Record<string, unknown> };

export type PollOutcome = { kind: 'waiting' } | { kind: 'done'; output: Record<string, unknown> } | { kind: 'failed'; error: string; output?: Record<string, unknown> };

export interface DeviceInfo {
  id: string;
  site_id: string;
  label: string;
  ip: string | null;
  mac: string | null;
  trust: string;
  status: string;
}

export async function loadDevice(db: Db, id: string): Promise<DeviceInfo | null> {
  return (
    (
      await db.query<DeviceInfo>(
        `SELECT id, site_id, coalesce(display_name, hostname, host(current_ip), primary_mac::text, id::text) AS label,
                host(current_ip) AS ip, primary_mac::text AS mac, trust, status
           FROM devices WHERE id = $1`,
        [id],
      )
    ).rows[0] ?? null
  );
}

/** The device a step acts on: its own device_id, else the trigger's (or the one chosen for a manual run). */
export function stepDeviceId(run: RunRow, step: StepRow): string | null {
  const own = step.params.device_id;
  return typeof own === 'string' && own ? own : run.device_id;
}

const NEEDS_DEVICE = 'This step needs a device, and neither the step nor the trigger names one (choose a device when you run it, or set one in the step)';

async function requireDevice(ctx: ActionContext): Promise<DeviceInfo | string> {
  const id = stepDeviceId(ctx.run, ctx.step);
  if (!id) return NEEDS_DEVICE;
  const d = await loadDevice(ctx.db, id);
  return d ?? 'The device no longer exists';
}

/** The incident of the run: the triggering incident, or the incident the triggering event was grouped into. */
export async function runIncidentId(db: Db, run: RunRow): Promise<string | null> {
  if (run.incident_id) return run.incident_id;
  if (!run.event_id) return null;
  return (await db.query<{ incident_id: string }>(`SELECT incident_id FROM incident_events WHERE event_id = $1 LIMIT 1`, [run.event_id])).rows[0]?.incident_id ?? null;
}

const actorLabel = (ctx: ActionContext) => (ctx.actor ? ctx.actor.email : `Playbook "${ctx.run.playbook_name}"`);

/** Fills {device} {ip} {mac} {site} {title} {playbook} in a notification or comment. Unknown values stay visible as "unknown". */
export async function fillText(ctx: ActionContext, text: string): Promise<string> {
  if (!/\{(device|ip|mac|site|title|playbook)\}/.test(text)) return text;
  const deviceId = stepDeviceId(ctx.run, ctx.step);
  const d = deviceId ? await loadDevice(ctx.db, deviceId) : null;
  const siteId = d?.site_id ?? ctx.run.site_id;
  const site = siteId ? (await ctx.db.query<{ name: string }>(`SELECT name FROM sites WHERE id = $1`, [siteId])).rows[0]?.name : null;
  const ev = ctx.run.evidence as { title?: unknown };
  const values: Record<string, string> = {
    device: d?.label ?? 'unknown device',
    ip: d?.ip ?? 'unknown',
    mac: d?.mac ?? 'unknown',
    site: site ?? 'all sites',
    title: typeof ev.title === 'string' ? ev.title : ctx.run.playbook_name,
    playbook: ctx.run.playbook_name,
  };
  return text.replace(/\{(device|ip|mac|site|title|playbook)\}/g, (_m, k: string) => values[k] ?? _m);
}

/** The most recent earlier step that produced something (not a condition, wait or approval). */
export function previousStep(ctx: ActionContext): StepRow | null {
  for (let i = ctx.step.position - 1; i >= 0; i--) {
    const s = ctx.steps[i];
    if (s && !['condition', 'wait', 'approval'].includes(s.action) && s.status !== 'pending') return s;
  }
  return null;
}

const compact = (v: unknown, max = 1500): string => {
  const text = JSON.stringify(v ?? null);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

async function siteSummary(db: Db, siteId: string | null): Promise<Record<string, unknown>> {
  const devices = (
    await db.query<{ total: number; online: number; offline: number; unreviewed: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'online')::int AS online, count(*) FILTER (WHERE status = 'offline')::int AS offline,
              count(*) FILTER (WHERE trust = 'unreviewed')::int AS unreviewed
         FROM devices WHERE ($1::uuid IS NULL OR site_id = $1)`,
      [siteId],
    )
  ).rows[0];
  const incidents = (await db.query<{ open: number }>(`SELECT count(*)::int AS open FROM incidents WHERE status <> 'resolved' AND ($1::uuid IS NULL OR site_id = $1)`, [siteId])).rows[0];
  const checks = (
    await db.query<{ down: number; degraded: number }>(
      `SELECT count(*) FILTER (WHERE state = 'down')::int AS down, count(*) FILTER (WHERE state = 'degraded')::int AS degraded
         FROM monitoring_checks WHERE enabled AND ($1::uuid IS NULL OR site_id = $1)`,
      [siteId],
    )
  ).rows[0];
  return { devices, open_incidents: incidents?.open ?? 0, checks };
}

/** Routers a router step acts on: the one the step names, else every enabled router of the device's site. */
export async function stepRouters(db: Db, step: StepRow, siteId: string): Promise<{ id: string; name: string }[]> {
  const own = step.params.router_id;
  if (typeof own === 'string' && own) {
    return (await db.query<{ id: string; name: string }>(`SELECT id, name FROM site_routers WHERE id = $1 AND site_id = $2`, [own, siteId])).rows;
  }
  return (await db.query<{ id: string; name: string }>(`SELECT id, name FROM site_routers WHERE site_id = $1 AND enabled ORDER BY name, id`, [siteId])).rows;
}

async function resolveEndpoint(db: Db, step: StepRow, deviceId: string | null): Promise<string | null> {
  const own = step.params.endpoint_id;
  if (typeof own === 'string' && own) return own;
  if (!deviceId) return null;
  return (
    (await db.query<{ id: string }>(`SELECT id FROM endpoints WHERE device_id = $1 AND status = 'active' ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1`, [deviceId])).rows[0]?.id ??
    null
  );
}

async function resolveToolTarget(ctx: ActionContext): Promise<{ siteId: string; target: string; port: number | null; input: Record<string, unknown> } | string> {
  const p = ctx.step.params as { tool: ToolKind; target: string; custom_target?: string; port: number | null };
  let port = p.port ?? null;
  if (p.target === 'custom') {
    if (!p.custom_target) return 'No target is set for this step';
    const siteId = ctx.run.site_id;
    if (!siteId) return 'A custom target needs a site: give the playbook a site';
    return { siteId, target: p.custom_target, port, input: { target: p.custom_target, port } };
  }
  if (p.target === 'trigger_check') {
    const checkId = (ctx.run.evidence as { check_id?: unknown }).check_id;
    if (typeof checkId !== 'string') return 'The trigger did not concern a monitoring check';
    const c = (await ctx.db.query<{ site_id: string; target: string; port: number | null; name: string }>(`SELECT site_id, target, port, name FROM monitoring_checks WHERE id = $1`, [checkId])).rows[0];
    if (!c) return 'The check no longer exists';
    if (p.tool === 'tcp' && port === null) port = c.port;
    if (p.tool !== 'tcp') port = null;
    return { siteId: c.site_id, target: c.target, port, input: { check_id: checkId, check: c.name, target: c.target, port } };
  }
  const d = await requireDevice(ctx);
  if (typeof d === 'string') return d;
  if (!d.ip) return 'The device has no known IP address';
  return { siteId: d.site_id, target: d.ip, port, input: { device_id: d.id, device: d.label, target: d.ip, port } };
}

/** Evaluates a condition step. true/false, or a reason it cannot be evaluated (never guessed). */
async function evaluateCondition(ctx: ActionContext): Promise<{ result: boolean; observed: Record<string, unknown> } | string> {
  const p = ctx.step.params as { test: string; check_id: string | null; states?: string[] };
  switch (p.test) {
    case 'device_online':
    case 'device_offline': {
      const d = await requireDevice(ctx);
      if (typeof d === 'string') return d;
      if (d.status === 'unknown') return `The state of "${d.label}" is unknown, so the condition cannot be decided`;
      return { result: p.test === 'device_online' ? d.status === 'online' : d.status === 'offline', observed: { device_id: d.id, device: d.label, status: d.status } };
    }
    case 'check_state': {
      const evidenceCheck = (ctx.run.evidence as { check_id?: unknown }).check_id;
      const checkId = p.check_id ?? (typeof evidenceCheck === 'string' ? evidenceCheck : null);
      if (!checkId) return 'No check to test: choose one in the step, or trigger the playbook on a check event';
      const c = (await ctx.db.query<{ name: string; state: string }>(`SELECT name, state FROM monitoring_checks WHERE id = $1`, [checkId])).rows[0];
      if (!c) return 'The check no longer exists';
      return { result: (p.states ?? []).includes(c.state), observed: { check_id: checkId, check: c.name, state: c.state } };
    }
    case 'previous_failed':
    case 'previous_succeeded': {
      const prev = previousStep(ctx);
      if (!prev) return 'There is no earlier step to test';
      if (!['succeeded', 'failed', 'rejected', 'expired'].includes(prev.status)) return `The earlier step "${prev.step_key}" has not finished (${prev.status})`;
      const ok = prev.status === 'succeeded';
      return { result: p.test === 'previous_succeeded' ? ok : !ok, observed: { step: prev.step_key, status: prev.status } };
    }
    case 'last_probe_failed':
    case 'last_probe_succeeded': {
      const probe = [...ctx.steps].reverse().find((s) => s.position < ctx.step.position && s.action === 'run_tool' && (s.status === 'succeeded' || s.status === 'failed'));
      if (!probe) return 'No earlier probe (run tool step) finished, so there is nothing to test';
      const out = (probe.output?.result ?? null) as Record<string, unknown> | null;
      let ok = probe.status === 'succeeded';
      if (ok && out && typeof out.replied === 'boolean') ok = out.replied;
      if (ok && out && typeof out.open === 'boolean') ok = out.open;
      return { result: p.test === 'last_probe_succeeded' ? ok : !ok, observed: { step: probe.step_key, status: probe.status, replied: out?.replied, open: out?.open } };
    }
    default:
      return `Unknown condition "${p.test}"`;
  }
}

/** Execute one step (or describe it, in a dry run). Throws are turned into a failed step by the engine. */
export async function executeAction(ctx: ActionContext): Promise<ActionOutcome> {
  const { db, organizationId: org, run, step } = ctx;
  const dry = run.dry_run;
  const actorId = ctx.actor?.id ?? null;
  const info = ACTIONS[step.action];

  // Resolve the device first for every device action, so the input (and loop guard) records it.
  let device: DeviceInfo | null = null;
  if (info.needsDevice && step.action !== 'endpoint_command') {
    const d = await requireDevice(ctx);
    if (typeof d === 'string') return { kind: 'failed', error: d };
    device = d;
  }
  const deviceInput = device ? { device_id: device.id, device: device.label, ip: device.ip, mac: device.mac } : {};

  switch (step.action) {
    case 'notify': {
      const p = step.params as { channel_ids: string[]; severity: 'info' | 'warning' | 'critical'; title: string; message: string; attach: string };
      const title = (await fillText(ctx, p.title)).slice(0, 200);
      const message = (await fillText(ctx, p.message)).slice(0, 2000);
      let attachment: unknown = null;
      if (p.attach === 'trigger') attachment = run.evidence;
      else if (p.attach === 'previous_output') {
        const prev = previousStep(ctx);
        attachment = prev ? { step: prev.step_key, status: prev.status, output: prev.output, error: prev.error } : null;
      } else if (p.attach === 'site_summary') attachment = await siteSummary(db, run.site_id);
      const input = { title, message, severity: p.severity, channel_ids: p.channel_ids };
      if (dry) return { kind: 'previewed', input: { ...input, attachment } };
      const deviceId = stepDeviceId(run, step);
      const eventId = await emitEvent(db, org, {
        siteId: run.site_id,
        deviceId: deviceId && (await loadDevice(db, deviceId)) ? deviceId : null,
        type: 'playbook_notification',
        severity: p.severity,
        title,
        details: { message, playbook_id: run.playbook_id, playbook: run.playbook_name, run_id: run.id, step: step.step_key, attachment },
        source: 'platform',
        occurredAt: ctx.now,
      });
      let channels: number;
      if (p.channel_ids.length) {
        // Only the chosen channels: drop what the severity routing queued, queue the chosen ones.
        await db.query(`DELETE FROM notification_deliveries WHERE event_id = $1 AND status = 'pending' AND NOT (channel_id = ANY($2))`, [eventId, p.channel_ids]);
        const r = await db.query(
          `INSERT INTO notification_deliveries (organization_id, channel_id, event_id)
           SELECT organization_id, id, $2 FROM notification_channels WHERE id = ANY($1) AND enabled ON CONFLICT DO NOTHING`,
          [p.channel_ids, eventId],
        );
        channels = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_deliveries WHERE event_id = $1`, [eventId])).rows[0]?.n ?? r.rowCount ?? 0;
      } else {
        channels = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_deliveries WHERE event_id = $1`, [eventId])).rows[0]?.n ?? 0;
      }
      return { kind: 'done', input, output: { event_id: eventId, channels_queued: channels, timeline: true } };
    }

    case 'run_tool': {
      const tool = step.params.tool as ToolKind;
      const t = await resolveToolTarget(ctx);
      if (typeof t === 'string') return { kind: 'failed', error: t };
      const input = { tool, site_id: t.siteId, ...t.input };
      if (dry) return { kind: 'previewed', input };
      const q = await queueToolRun(db, org, { siteId: t.siteId, tool, target: t.target, port: t.port, createdBy: actorId });
      return { kind: 'pending', input: { ...input, collector: q.collector }, external: { kind: 'toolbox_run', id: q.run_id } };
    }

    case 'run_checks':
    case 'run_discovery': {
      const input = { site_id: run.site_id };
      if (dry) return { kind: 'previewed', input };
      const queued = await queueSiteCollectorCommand(db, org, run.site_id, step.action, actorId);
      if (!queued.length) return { kind: 'failed', input, error: 'No collector of this site is online' };
      return { kind: 'pending', input: { ...input, collectors: queued.map((q) => q.collector) }, external: { kind: 'collector_commands', ids: queued.map((q) => q.command_id) } };
    }

    case 'wake_device': {
      if (dry) return { kind: 'previewed', input: deviceInput };
      const w = await queueWakeOnLan(db, org, device!.id, actorId);
      return { kind: 'pending', input: { ...deviceInput, collector: w.collector, broadcast: w.broadcast }, external: { kind: 'collector_commands', ids: [w.command_id] } };
    }

    case 'set_trust': {
      const trust = step.params.trust as 'known' | 'unreviewed' | 'unwanted';
      const input = { ...deviceInput, trust, current_trust: device!.trust };
      if (dry) return { kind: 'previewed', input };
      const r = await setDeviceTrust(db, org, device!.id, trust);
      return { kind: 'done', input, output: { previous: r.previous, trust, changed: r.changed } };
    }

    case 'dns_pause':
    case 'dns_resume': {
      const minutes = step.action === 'dns_pause' ? Number(step.params.minutes) : 0;
      const until = step.action === 'dns_pause' ? new Date(ctx.now.getTime() + minutes * 60_000) : null;
      const filterOn = await dnsFilterEnabled(db, device!.site_id);
      const input = { ...deviceInput, minutes: minutes || undefined, until: until?.toISOString() ?? null, dns_filter_enabled: filterOn };
      if (dry) return { kind: 'previewed', input };
      const r = await setDeviceInternetPause(db, org, device!.id, until);
      return {
        kind: 'done',
        input,
        output: {
          paused_until: until?.toISOString() ?? null,
          previous_until: r.previous_until ? new Date(r.previous_until).toISOString() : null,
          dns_filter_enabled: filterOn,
          // Never claim the device is cut off when the filter is not in use for the site.
          note: filterOn ? null : 'The DNS filter is off for this site: the pause is recorded but has no effect until the filter is turned on (Access control).',
        },
      };
    }

    case 'router_block':
    case 'router_unblock':
    case 'router_rate_limit': {
      const routers = await stepRouters(db, step, device!.site_id);
      const input = { ...deviceInput, routers: routers.map((r) => r.name), ...(step.action === 'router_rate_limit' ? { down_kbps: step.params.down_kbps, up_kbps: step.params.up_kbps } : {}) };
      if (dry) return { kind: 'previewed', input };
      // Reaching here outside an approval means the step was not executed at its approval (e.g. the API restarted).
      return { kind: 'failed', input, error: 'Router changes run only at the moment an administrator approves them; this one was not carried out' };
    }

    case 'router_wifi':
    case 'router_reboot': {
      const routerId = String(step.params.router_id);
      const r = (await db.query<{ name: string; site_id: string }>(`SELECT name, site_id FROM site_routers WHERE id = $1`, [routerId])).rows[0];
      if (!r) return { kind: 'failed', error: 'The router no longer exists' };
      const input =
        step.action === 'router_wifi'
          ? { router_id: routerId, router: r.name, wifi_id: step.params.wifi_id, enabled: step.params.enabled, confirm_main_network: step.params.confirm_main_network === true }
          : { router_id: routerId, router: r.name };
      if (dry) return { kind: 'previewed', input };
      return { kind: 'failed', input, error: 'Router changes run only at the moment an administrator approves them; this one was not carried out' };
    }

    case 'switch_port_quarantine':
    case 'switch_port_disable': {
      const input = { ...deviceInput, ...(step.action === 'switch_port_quarantine' ? { reason: step.params.reason ?? null } : { admin_up: false }) };
      if (dry) return { kind: 'previewed', input };
      return { kind: 'failed', input, error: 'Switch port changes run only at the moment an administrator approves them; this one was not carried out' };
    }

    case 'config_backup': {
      const ownTarget = typeof step.params.target_id === 'string' && step.params.target_id ? step.params.target_id : null;
      let targetId = ownTarget;
      if (!targetId) {
        const deviceId = stepDeviceId(run, step);
        if (!deviceId) return { kind: 'failed', error: NEEDS_DEVICE };
        targetId = (await db.query<{ id: string }>(`SELECT id FROM config_backup_targets WHERE device_id = $1 ORDER BY created_at LIMIT 1`, [deviceId])).rows[0]?.id ?? null;
        if (!targetId) return { kind: 'failed', error: 'This device is not set up for configuration backup (Configuration backup → Add device)' };
      }
      await expireStaleConfigBackups(db);
      const t = await loadConfigBackupTarget(db, targetId, true);
      // device_id: the loop guard links the backup's config_changed event back to this step.
      const input = { target_id: t.id, target: t.name, address: t.address, device_id: t.device_id };
      if (dry) return { kind: 'previewed', input };
      if (t.pending_run_id) return { kind: 'pending', input: { ...input, already_pending: true }, external: { kind: 'config_backup_run', id: t.pending_run_id } };
      const ready = configBackupReadiness(t);
      if (ready !== 'ready') return { kind: 'failed', input, error: `The device cannot be backed up now (${ready.replace(/_/g, ' ')})` };
      const collector = await configBackupCollector(db, t.site_id);
      if (!collector) return { kind: 'failed', input, error: 'No collector of this site is online to reach the device' };
      const q = await queueConfigBackupRun(db, org, t, 'playbook', collector, ctx.actor ? { id: ctx.actor.id, email: ctx.actor.email } : null);
      return { kind: 'pending', input: { ...input, collector: q.collector }, external: { kind: 'config_backup_run', id: q.run_id } };
    }

    case 'endpoint_command': {
      const command = parseAutomatableCommand(step.params.command);
      const deviceId = stepDeviceId(run, step);
      const endpointId = await resolveEndpoint(db, step, deviceId);
      if (!endpointId) return { kind: 'failed', error: deviceId ? 'No managed computer (endpoint agent) is enrolled for this device' : NEEDS_DEVICE };
      const ep = (await db.query<{ name: string }>(`SELECT name FROM endpoints WHERE id = $1`, [endpointId])).rows[0];
      const input = { endpoint_id: endpointId, endpoint: ep?.name ?? null, command: command.kind, device_id: deviceId };
      if (dry) return { kind: 'previewed', input };
      const q = await queueEndpointCommandFor(db, org, endpointId, command, {
        userId: actorId,
        label: actorLabel(ctx),
        // Disruptive: approved by this administrator, or run automatically on an administrator's recorded consent.
        role: ctx.actor?.role ?? 'admin',
      });
      return { kind: 'pending', input: { ...input, endpoint: q.endpoint_name }, external: { kind: 'endpoint_command', id: q.command_id } };
    }

    case 'incident_comment':
    case 'incident_acknowledge': {
      const incidentId = await runIncidentId(db, run);
      if (!incidentId) return { kind: 'failed', error: 'The trigger is not linked to an incident' };
      if (step.action === 'incident_acknowledge') {
        if (dry) return { kind: 'previewed', input: { incident_id: incidentId } };
        const r = await acknowledgeIncident(db, org, incidentId, { id: null, name: actorLabel(ctx) });
        return { kind: 'done', input: { incident_id: incidentId }, output: r };
      }
      let body = await fillText(ctx, String(step.params.body));
      if (step.params.include_previous_output) {
        const prev = previousStep(ctx);
        if (prev) body += `\n\n${prev.step_key} (${prev.status}): ${compact(prev.output ?? prev.error)}`;
      }
      body = body.slice(0, 4000);
      if (dry) return { kind: 'previewed', input: { incident_id: incidentId, body } };
      await commentOnIncident(db, org, incidentId, body, { id: null, name: actorLabel(ctx) });
      return { kind: 'done', input: { incident_id: incidentId }, output: { commented: true, length: body.length } };
    }

    case 'wait': {
      const seconds = Number(step.params.seconds);
      if (dry) return { kind: 'previewed', input: { seconds } };
      return { kind: 'pending', input: { seconds }, external: { kind: 'wait', until: new Date(ctx.now.getTime() + seconds * 1000).toISOString() } };
    }

    case 'condition': {
      const p = step.params as { test: string; if_true: 'continue' | 'stop' };
      const r = await evaluateCondition(ctx);
      if (typeof r === 'string') {
        // In a dry run earlier steps only previewed, so a condition on their result cannot be decided.
        if (dry) return { kind: 'previewed', input: { test: p.test, undecided: r } };
        return { kind: 'failed', error: r };
      }
      const proceed = r.result ? p.if_true === 'continue' : p.if_true === 'stop';
      const output = { test: p.test, result: r.result, observed: r.observed, then: proceed ? 'continue' : 'stop' };
      if (dry) return { kind: 'previewed', input: output };
      if (proceed) return { kind: 'done', output };
      return { kind: 'stop', output, reason: `Condition "${p.test}" was ${r.result ? 'true' : 'false'}: the run stopped here as configured` };
    }

    case 'approval':
      // Reached only in a dry run (otherwise the engine gates it and an administrator decides).
      return { kind: 'previewed', input: { message: step.params.message ?? '', approval: 'would ask an administrator' } };
  }
  throw new AppError(400, 'unknown_action', `Unknown action "${String(step.action)}"`);
}

/** Polls what an async step waits for. Timeouts are counted from the step's start. */
export async function pollExternal(db: Db, step: StepRow, now: Date): Promise<PollOutcome> {
  const ext = step.external!;
  const age = now.getTime() - (step.started_at ? new Date(step.started_at).getTime() : now.getTime());
  const timedOut = (minutes: number) => age > minutes * 60_000;
  switch (ext.kind) {
    case 'wait':
      return new Date(ext.until).getTime() <= now.getTime() ? { kind: 'done', output: { waited_until: ext.until } } : { kind: 'waiting' };
    case 'toolbox_run': {
      const s = await toolRunState(db, ext.id);
      if (!s) return { kind: 'failed', error: 'The toolbox run no longer exists' };
      if (s.status === 'completed') return { kind: 'done', output: { toolbox_run_id: ext.id, result: s.output, duration_ms: s.duration_ms } };
      if (s.status === 'failed' || s.status === 'expired') return { kind: 'failed', error: s.error ?? `The tool ${s.status}`, output: { toolbox_run_id: ext.id } };
      return timedOut(LIMITS.toolTimeoutMinutes) ? { kind: 'failed', error: `No result from the collector within ${LIMITS.toolTimeoutMinutes} minutes` } : { kind: 'waiting' };
    }
    case 'collector_commands': {
      const states = await collectorCommandStates(db, ext.ids);
      if (states.length && states.every((c) => c.status === 'completed')) return { kind: 'done', output: { commands: states.map((c) => ({ id: c.id, kind: c.kind, status: c.status })) } };
      return timedOut(LIMITS.collectorCommandTimeoutMinutes)
        ? { kind: 'failed', error: `The collector did not confirm within ${LIMITS.collectorCommandTimeoutMinutes} minutes`, output: { commands: states.map((c) => ({ id: c.id, status: c.status })) } }
        : { kind: 'waiting' };
    }
    case 'router_requests': {
      const rows = (
        await db.query<{ id: string; status: string; error: string | null; result: unknown }>(`SELECT id, status, error, result FROM router_requests WHERE id = ANY($1)`, [ext.ids])
      ).rows;
      if (rows.some((r) => r.status === 'pending')) {
        return timedOut(LIMITS.routerRequestTimeoutMinutes) ? { kind: 'failed', error: `The router did not confirm within ${LIMITS.routerRequestTimeoutMinutes} minutes` } : { kind: 'waiting' };
      }
      const output = { requests: rows.map((r) => ({ id: r.id, status: r.status, error: r.error })) };
      if (rows.some((r) => r.status === 'completed')) return { kind: 'done', output };
      return { kind: 'failed', error: rows.map((r) => r.error ?? r.status).join('; ') || 'The router request is gone', output };
    }
    case 'switch_port_requests': {
      const rows = (await db.query<{ id: string; status: string; error: string | null; result: unknown }>(`SELECT id, status, error, result FROM switch_port_requests WHERE id = ANY($1)`, [ext.ids])).rows;
      if (rows.some((r) => r.status === 'pending')) {
        return timedOut(LIMITS.switchPortTimeoutMinutes) ? { kind: 'failed', error: `The switch did not confirm within ${LIMITS.switchPortTimeoutMinutes} minutes` } : { kind: 'waiting' };
      }
      const output = { requests: rows.map((r) => ({ id: r.id, status: r.status, error: r.error, result: r.result })) };
      // "verified": the collector read the port back and it matches the change.
      if (rows.length && rows.every((r) => r.status === 'verified')) return { kind: 'done', output };
      return { kind: 'failed', error: rows.map((r) => r.error ?? r.status).join('; ') || 'The switch port request is gone', output };
    }
    case 'config_backup_run': {
      const r = (await db.query<{ status: string; outcome: string | null; version_id: string | null; error: string | null }>(`SELECT status, outcome, version_id, error FROM config_backup_runs WHERE id = $1`, [ext.id])).rows[0];
      if (!r) return { kind: 'failed', error: 'The backup run no longer exists' };
      if (r.status === 'ok') return { kind: 'done', output: { config_backup_run_id: ext.id, outcome: r.outcome, version_id: r.version_id } };
      if (r.status === 'failed' || r.status === 'expired') return { kind: 'failed', error: r.error ?? `The backup ${r.status}`, output: { config_backup_run_id: ext.id } };
      return timedOut(LIMITS.configBackupTimeoutMinutes) ? { kind: 'failed', error: `No backup result within ${LIMITS.configBackupTimeoutMinutes} minutes` } : { kind: 'waiting' };
    }
    case 'endpoint_command': {
      const s = await endpointCommandState(db, ext.id);
      if (!s) return { kind: 'failed', error: 'The endpoint command no longer exists' };
      if (s.status === 'completed') return { kind: 'done', output: { command_id: ext.id, output: s.output?.slice(0, 4000) ?? null } };
      if (s.status === 'failed' || s.status === 'expired') return { kind: 'failed', error: s.error ?? `The command ${s.status}`, output: { command_id: ext.id } };
      return timedOut(LIMITS.endpointCommandTimeoutMinutes) ? { kind: 'failed', error: `The computer did not answer within ${LIMITS.endpointCommandTimeoutMinutes} minutes` } : { kind: 'waiting' };
    }
  }
}
