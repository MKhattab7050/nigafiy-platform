import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Role } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, type AuthContext, forbidden, notFound } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { AUTOMATABLE_COMMAND_KINDS, parseAutomatableCommand } from '../endpoints/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { TOOL_KINDS, assertToolTarget } from '../toolbox/index.ts';
import { stepDeviceId } from './actions.ts';
import { ACTIONS, ACTION_KEYS, CONDITION_TESTS, INCIDENT_KINDS, LIMITS, TRIGGER_EVENT_TYPES, riskOf } from './catalog.ts';
import { ROUTER_ACTIONS, advanceRun, createRun, endRun, executeRouterStep, loadRun, loadSteps, needsApproval } from './engine.ts';
import { approverAccounts } from './notify.ts';
import {
  ACTIVE_RUN_STATUSES,
  PLAYBOOK_SELECT,
  type PlaybookRow,
  RUN_COLUMNS,
  type RunRow,
  type Settings,
  type StepRow,
  loadSettings,
  presentPlaybook,
  presentRun,
  presentStep,
} from './repo.ts';
import { nextScheduleSlot } from './schedule.ts';
import type { PlaybookCreate, PlaybookPatch, Step, Trigger } from './schema.ts';
import { stepSchema } from './schema.ts';
import { TEMPLATES, templateByKey } from './templates.ts';

// Playbook use cases behind routes.ts. Every write is audited in the same transaction.

const RANK: Record<Role, number> = { viewer: 0, technician: 1, admin: 2, owner: 3 };
const isAdmin = (role: Role) => RANK[role] >= RANK.admin;

type Issue = { path: string; message: string };
const invalid = (issues: Issue[]) => new AppError(400, 'validation_error', 'The playbook is invalid', issues);

// ── validation beyond the schema: references exist, steps fit the trigger ──

async function validate(db: Db, siteId: string | null, trigger: Trigger, rawSteps: PlaybookCreate['steps']): Promise<Step[]> {
  const issues: Issue[] = [];
  if (siteId && !(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) issues.push({ path: 'site_id', message: 'Site not found' });
  const exists = async (table: string, id: string) => Boolean((await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount);
  const seen = new Set<string>();
  const steps: Step[] = [];
  for (const [i, s] of rawSteps.entries()) {
    const at = (field: string) => `steps.${i}.${field}`;
    const key = s.key ?? `${s.action.replace(/_/g, '-')}-${i + 1}`;
    if (seen.has(key)) issues.push({ path: at('key'), message: `Two steps are called "${key}"` });
    seen.add(key);
    const params = s.params as Record<string, unknown>;
    const info = ACTIONS[s.action];
    if (info.needsDevice) {
      const own = params.device_id;
      if (typeof own === 'string') {
        const d = (await db.query<{ site_id: string }>(`SELECT site_id FROM devices WHERE id = $1`, [own])).rows[0];
        if (!d) issues.push({ path: at('params.device_id'), message: 'Device not found' });
        else if (siteId && d.site_id !== siteId) issues.push({ path: at('params.device_id'), message: 'The device belongs to another site than the playbook' });
      } else if (trigger.kind === 'schedule' && !(s.action === 'endpoint_command' && params.endpoint_id)) {
        issues.push({ path: at('params.device_id'), message: 'A scheduled playbook has no trigger device: choose the device this step acts on' });
      }
    }
    if (info.needsIncident && trigger.kind !== 'incident' && trigger.kind !== 'event') {
      issues.push({ path: at('action'), message: 'Incident steps need an incident or event trigger' });
    }
    if (typeof params.router_id === 'string' && !(await exists('site_routers', params.router_id))) issues.push({ path: at('params.router_id'), message: 'Router not found' });
    if (s.action === 'config_backup') {
      if (typeof params.target_id === 'string') {
        if (!(await exists('config_backup_targets', params.target_id))) issues.push({ path: at('params.target_id'), message: 'Backup device not found' });
      } else if (typeof params.device_id === 'string') {
        if (!(await exists('devices', params.device_id))) issues.push({ path: at('params.device_id'), message: 'Device not found' });
      } else if (trigger.kind === 'schedule') {
        issues.push({ path: at('params.target_id'), message: 'A scheduled playbook has no trigger device: choose the device to back up' });
      }
    }
    if (s.action === 'notify') {
      for (const id of (params.channel_ids as string[]) ?? []) if (!(await exists('notification_channels', id))) issues.push({ path: at('params.channel_ids'), message: 'Notification channel not found' });
    }
    if (s.action === 'run_tool') {
      const target = params.target as string;
      const tool = params.tool as (typeof TOOL_KINDS)[number];
      if (target === 'custom') {
        if (!params.custom_target) issues.push({ path: at('params.custom_target'), message: 'Enter the target' });
        else {
          try {
            assertToolTarget(tool, String(params.custom_target), (params.port as number | null) ?? null);
          } catch (err) {
            issues.push({ path: at('params.custom_target'), message: (err as Error).message });
          }
        }
        if (!siteId) issues.push({ path: 'site_id', message: 'A probe of a fixed target needs the playbook to belong to a site' });
      } else if (target === 'trigger_check' && trigger.kind !== 'event' && trigger.kind !== 'incident') {
        issues.push({ path: at('params.target'), message: '"The trigger’s check" needs an event or incident trigger' });
      } else if (target === 'trigger_device' && trigger.kind === 'schedule' && !params.device_id) {
        issues.push({ path: at('params.device_id'), message: 'A scheduled playbook has no trigger device: choose the device to probe' });
      }
      if (target !== 'trigger_check' && tool === 'tcp' && params.port == null) issues.push({ path: at('params.port'), message: 'A TCP port check needs a port' });
      if (tool !== 'tcp' && params.port != null) issues.push({ path: at('params.port'), message: 'Only a TCP port check takes a port' });
    }
    if (s.action === 'endpoint_command') {
      try {
        parseAutomatableCommand(params.command);
      } catch (err) {
        const e = err as AppError;
        issues.push({ path: at('params.command'), message: Array.isArray(e.details) && e.details[0] ? `${e.message}: ${(e.details[0] as Issue).message}` : e.message });
      }
      if (typeof params.endpoint_id === 'string' && !(await exists('endpoints', params.endpoint_id))) issues.push({ path: at('params.endpoint_id'), message: 'Endpoint not found' });
    }
    if (s.action === 'condition' && typeof params.check_id === 'string' && !(await exists('monitoring_checks', params.check_id))) {
      issues.push({ path: at('params.check_id'), message: 'Check not found' });
    }
    steps.push({ ...s, key } as Step);
  }
  if (issues.length) throw invalid(issues.slice(0, 20));
  return steps;
}

async function loadPlaybook(db: Db, id: string, lock = false): Promise<PlaybookRow> {
  const p = (await db.query<PlaybookRow>(`${PLAYBOOK_SELECT} WHERE p.id = $1${lock ? ' FOR UPDATE OF p' : ''}`, [id])).rows[0];
  if (!p) throw notFound('Playbook');
  return p;
}

// ── catalogue ──

export function catalog() {
  return {
    actions: ACTION_KEYS.map((key) => ({
      key,
      needs_device: ACTIONS[key].needsDevice,
      needs_incident: ACTIONS[key].needsIncident,
      always_approve: ACTIONS[key].alwaysApprove || key === 'approval',
      default_risk: riskOf(key, {}),
    })),
    trigger_event_types: TRIGGER_EVENT_TYPES,
    incident_kinds: INCIDENT_KINDS,
    condition_tests: CONDITION_TESTS,
    tool_kinds: TOOL_KINDS,
    endpoint_command_kinds: AUTOMATABLE_COMMAND_KINDS,
    templates: TEMPLATES.map((t) => ({ ...t, steps: t.steps.map((s) => stepSchema.parse(s)) })),
    limits: LIMITS,
  };
}

// ── playbooks ──

export function listPlaybooks(organizationId: string, siteId: string | null) {
  return withTenant(organizationId, async (db) => {
    const rows = (await db.query<PlaybookRow>(`${PLAYBOOK_SELECT} WHERE ($1::uuid IS NULL OR p.site_id IS NULL OR p.site_id = $1) ORDER BY p.name, p.id`, [siteId])).rows;
    const stats = (
      await db.query<{ playbook_id: string; active: number; awaiting: number; last_status: string | null; last_at: Date | null }>(
        `SELECT playbook_id,
                count(*) FILTER (WHERE status = ANY($1))::int AS active,
                count(*) FILTER (WHERE status = 'awaiting_approval')::int AS awaiting,
                (array_agg(status ORDER BY created_at DESC))[1] AS last_status,
                max(created_at) AS last_at
           FROM playbook_runs WHERE playbook_id IS NOT NULL GROUP BY playbook_id`,
        [ACTIVE_RUN_STATUSES],
      )
    ).rows;
    const byId = new Map(stats.map((s) => [s.playbook_id, s]));
    const now = new Date();
    return {
      items: rows.map((p) => {
        const s = byId.get(p.id);
        const next = p.enabled && p.trigger.kind === 'schedule' ? nextScheduleSlot(p.trigger, p.site_timezone, now) : null;
        return {
          ...presentPlaybook(p),
          active_runs: s?.active ?? 0,
          awaiting_approval: s?.awaiting ?? 0,
          last_run_status: s?.last_status ?? null,
          last_run_at: s?.last_at ? s.last_at.toISOString() : null,
          next_run_at: next ? next.toISOString() : null,
        };
      }),
    };
  });
}

export function getPlaybook(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    const p = await loadPlaybook(db, id);
    const next = p.enabled && p.trigger.kind === 'schedule' ? nextScheduleSlot(p.trigger, p.site_timezone, new Date()) : null;
    return { ...presentPlaybook(p), next_run_at: next ? next.toISOString() : null };
  });
}

async function insertPlaybook(db: Db, req: Request, ctx: AuthContext, body: PlaybookCreate, templateKey: string | null) {
  const steps = await validate(db, body.site_id, body.trigger, body.steps);
  const auto = body.approval_mode === 'run_automatically';
  if (auto && !body.auto_run_confirmed) {
    throw new AppError(400, 'auto_run_not_confirmed', 'Running disruptive steps without asking needs your explicit confirmation (auto_run_confirmed)');
  }
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO playbooks (organization_id, site_id, name, description, enabled, dry_run, trigger, steps, approval_mode, auto_run_set_by, auto_run_set_by_email, auto_run_set_at,
                              max_runs_per_hour, template_key, enabled_at, created_by, created_by_email, updated_by, updated_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$16,$17) RETURNING id`,
      [
        ctx.organizationId,
        body.site_id,
        body.name,
        body.description,
        body.enabled,
        body.dry_run,
        JSON.stringify(body.trigger),
        JSON.stringify(steps),
        body.approval_mode,
        auto ? ctx.userId : null,
        auto ? ctx.userEmail : null,
        auto ? new Date() : null,
        body.max_runs_per_hour,
        templateKey,
        body.enabled ? new Date() : null,
        ctx.userId,
        ctx.userEmail,
      ],
    )
  ).rows[0]!;
  await audit(db, req, 'playbook.created', { type: 'playbook', id: row.id }, {
    name: body.name,
    template: templateKey,
    enabled: body.enabled,
    trigger: body.trigger.kind,
    steps: steps.map((s) => s.action),
    approval_mode: body.approval_mode,
  });
  await notifyRealtime(db, ctx.organizationId, 'events');
  return presentPlaybook(await loadPlaybook(db, row.id));
}

export function createPlaybook(req: Request, ctx: AuthContext, body: PlaybookCreate) {
  return withTenant(ctx.organizationId, (db) => insertPlaybook(db, req, ctx, body, null));
}

/** One click: an ordinary, disabled playbook from a built-in template. */
export function createFromTemplate(req: Request, ctx: AuthContext, key: string, siteId: string | null) {
  const t = templateByKey(key);
  if (!t) throw notFound('Template');
  return withTenant(ctx.organizationId, (db) =>
    insertPlaybook(
      db,
      req,
      ctx,
      {
        name: t.name,
        description: t.description,
        site_id: siteId,
        enabled: false,
        dry_run: false,
        trigger: t.trigger,
        steps: t.steps.map((s) => stepSchema.parse(s)),
        approval_mode: 'always_ask',
        max_runs_per_hour: 6,
      },
      t.key,
    ),
  );
}

export function updatePlaybook(req: Request, ctx: AuthContext, id: string, patch: PlaybookPatch) {
  return withTenant(ctx.organizationId, async (db) => {
    const p = await loadPlaybook(db, id, true);
    const siteId = patch.site_id !== undefined ? patch.site_id : p.site_id;
    const trigger = patch.trigger ?? p.trigger;
    const definitionChanged = patch.trigger !== undefined || patch.steps !== undefined || (patch.site_id !== undefined && patch.site_id !== p.site_id);
    const steps = definitionChanged ? await validate(db, siteId, trigger, patch.steps ?? p.steps) : p.steps;
    const mode = patch.approval_mode ?? p.approval_mode;
    const becomesAuto = mode === 'run_automatically' && (p.approval_mode !== 'run_automatically' || definitionChanged);
    if (becomesAuto && !patch.auto_run_confirmed) {
      throw new AppError(
        400,
        'auto_run_not_confirmed',
        p.approval_mode === 'run_automatically'
          ? 'This playbook runs disruptive steps without asking; confirm again after changing its trigger or steps (auto_run_confirmed)'
          : 'Running disruptive steps without asking needs your explicit confirmation (auto_run_confirmed)',
      );
    }
    const enabled = patch.enabled ?? p.enabled;
    const reEnable = enabled && (!p.enabled || patch.trigger !== undefined);
    await db.query(
      `UPDATE playbooks SET name = $2, description = $3, site_id = $4, enabled = $5, dry_run = $6, trigger = $7, steps = $8, approval_mode = $9,
              auto_run_set_by = CASE WHEN $9 = 'always_ask' THEN NULL WHEN $10 THEN $11 ELSE auto_run_set_by END,
              auto_run_set_by_email = CASE WHEN $9 = 'always_ask' THEN NULL WHEN $10 THEN $12 ELSE auto_run_set_by_email END,
              auto_run_set_at = CASE WHEN $9 = 'always_ask' THEN NULL WHEN $10 THEN now() ELSE auto_run_set_at END,
              max_runs_per_hour = $13, version = version + CASE WHEN $14 THEN 1 ELSE 0 END,
              enabled_at = CASE WHEN NOT $5 THEN NULL WHEN $15 THEN now() ELSE enabled_at END,
              updated_by = $11, updated_by_email = $12, updated_at = now()
        WHERE id = $1`,
      [
        id,
        patch.name ?? p.name,
        patch.description ?? p.description,
        siteId,
        enabled,
        patch.dry_run ?? p.dry_run,
        JSON.stringify(trigger),
        JSON.stringify(steps),
        mode,
        becomesAuto,
        ctx.userId,
        ctx.userEmail,
        patch.max_runs_per_hour ?? p.max_runs_per_hour,
        definitionChanged,
        reEnable,
      ],
    );
    const changed = Object.keys(patch).filter((k) => k !== 'auto_run_confirmed');
    await audit(db, req, enabled !== p.enabled ? (enabled ? 'playbook.enabled' : 'playbook.disabled') : 'playbook.updated', { type: 'playbook', id }, {
      name: patch.name ?? p.name,
      changed,
      approval_mode: mode,
      ...(becomesAuto ? { auto_run_confirmed: true } : {}),
    });
    await notifyRealtime(db, ctx.organizationId, 'events');
    return presentPlaybook(await loadPlaybook(db, id));
  });
}

export function deletePlaybook(req: Request, ctx: AuthContext, id: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const p = await loadPlaybook(db, id, true);
    const now = new Date();
    const active = (await db.query<{ id: string }>(`SELECT id FROM playbook_runs WHERE playbook_id = $1 AND status = ANY($2)`, [id, ACTIVE_RUN_STATUSES])).rows;
    for (const r of active) {
      const run = await loadRun(db, r.id, 'wait');
      if (run) await endRun(db, run, await loadSteps(db, r.id), 'cancelled', `Cancelled: the playbook was deleted by ${ctx.userEmail}`, now, 'cancelled');
    }
    await db.query(`DELETE FROM playbooks WHERE id = $1`, [id]);
    await audit(db, req, 'playbook.deleted', { type: 'playbook', id }, { name: p.name, cancelled_runs: active.length });
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
}

// ── runs ──

/** Manual run ("Run now"), optionally as a dry run. Steps that need approval still wait for an administrator. */
export async function runNow(req: Request, ctx: AuthContext, id: string, body: { device_id: string | null; dry_run: boolean }) {
  const runId = await withTenant(ctx.organizationId, async (db) => {
    const p = await loadPlaybook(db, id);
    let siteId = p.site_id;
    if (body.device_id) {
      const d = (await db.query<{ site_id: string; label: string }>(`SELECT site_id, coalesce(display_name, hostname, host(current_ip)) AS label FROM devices WHERE id = $1`, [body.device_id]))
        .rows[0];
      if (!d) throw notFound('Device');
      if (p.site_id && d.site_id !== p.site_id) throw new AppError(400, 'other_site', 'The device belongs to another site than the playbook');
      siteId = d.site_id;
    } else if (p.steps.some((s) => ACTIONS[s.action].needsDevice && !(s.params as { device_id?: unknown }).device_id && !(s.action === 'endpoint_command' && (s.params as { endpoint_id?: unknown }).endpoint_id))) {
      throw new AppError(400, 'device_required', 'Choose the device this run acts on: some steps act on the trigger’s device');
    }
    const dryRun = body.dry_run || p.dry_run;
    const created = await createRun(db, p, {
      kind: 'manual',
      key: `manual:${randomUUID()}`,
      evidence: { started_by: ctx.userEmail, device_id: body.device_id, title: `Started by ${ctx.userEmail}` },
      siteId,
      deviceId: body.device_id,
      incidentId: null,
      eventId: null,
      startedBy: { id: ctx.userId, email: ctx.userEmail, role: ctx.role },
      dryRun,
    });
    await audit(db, req, 'playbook.run_started', { type: 'playbook_run', id: created }, { playbook_id: p.id, playbook: p.name, dry_run: dryRun, device_id: body.device_id });
    return created!;
  });
  await advanceRun(ctx.organizationId, runId);
  return getRun(ctx, runId);
}

interface Rights {
  can_approve: boolean;
  can_reject: boolean;
  /** Set when the only administrator approves their own run (recorded on the decision). */
  self_approval: 'only_administrator' | null;
  reason: string | null;
}

async function approvalRights(ctx: AuthContext, run: RunRow, settings: Settings, admins?: number): Promise<Rights> {
  if (!isAdmin(ctx.role)) return { can_approve: false, can_reject: false, self_approval: null, reason: 'Only an administrator can approve or reject' };
  const own = run.started_by === ctx.userId;
  const author = settings.two_person_rule && run.author_ids.includes(ctx.userId);
  if (!own && !author) return { can_approve: true, can_reject: true, self_approval: null, reason: null };
  const count = admins ?? (await approverAccounts(ctx.organizationId)).length;
  if (count <= 1) return { can_approve: true, can_reject: true, self_approval: 'only_administrator', reason: null };
  return {
    can_approve: false,
    can_reject: true,
    self_approval: null,
    reason: own
      ? 'You started this run; another administrator must approve it'
      : 'Two-person rule: you wrote or last edited this playbook, so another administrator must approve it',
  };
}

async function presentRunDetail(db: Db, ctx: AuthContext, run: RunRow, steps: StepRow[]) {
  const settings = await loadSettings(db);
  const awaiting = steps.some((s) => s.status === 'awaiting_approval');
  const rights = awaiting ? await approvalRights(ctx, run, settings) : null;
  const deviceIds = [...new Set(steps.map((s) => stepDeviceId(run, s)).filter((x): x is string => Boolean(x)))];
  const devices = deviceIds.length
    ? (await db.query<{ id: string; label: string }>(`SELECT id, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label FROM devices WHERE id = ANY($1)`, [deviceIds])).rows
    : [];
  const site = run.site_id ? (await db.query<{ name: string }>(`SELECT name FROM sites WHERE id = $1`, [run.site_id])).rows[0]?.name : null;
  return {
    ...presentRun(run),
    site_name: site ?? null,
    device_label: devices.find((d) => d.id === run.device_id)?.label ?? null,
    devices,
    next_run_at: ACTIVE_RUN_STATUSES.includes(run.status) ? run.next_run_at.toISOString() : null,
    can_cancel: ACTIVE_RUN_STATUSES.includes(run.status) && (isAdmin(ctx.role) || (RANK[ctx.role] >= RANK.technician && run.started_by === ctx.userId)),
    steps: steps.map((s) => ({
      ...presentStep(s),
      needs_approval: needsApproval(run, s),
      ...(s.status === 'awaiting_approval' && rights ? { rights } : {}),
    })),
  };
}

export function getRun(ctx: AuthContext, runId: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const run = await loadRun(db, runId);
    if (!run) throw notFound('Run');
    return presentRunDetail(db, ctx, run, await loadSteps(db, runId));
  });
}

export function listRuns(organizationId: string, q: { playbook_id?: string; status: 'active' | 'finished' | 'all'; page: number; page_size: number }) {
  return withTenant(organizationId, async (db) => {
    const where = `($1::uuid IS NULL OR r.playbook_id = $1) AND (CASE $2 WHEN 'active' THEN r.status = ANY($3) WHEN 'finished' THEN NOT (r.status = ANY($3)) ELSE true END)`;
    const params = [q.playbook_id ?? null, q.status, ACTIVE_RUN_STATUSES];
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM playbook_runs r WHERE ${where}`, params)).rows[0]?.n ?? 0;
    const rows = (
      await db.query<RunRow & { steps_total: number; steps_done: number }>(
        `SELECT ${RUN_COLUMNS},
                (SELECT count(*)::int FROM playbook_run_steps s WHERE s.run_id = r.id) AS steps_total,
                (SELECT count(*)::int FROM playbook_run_steps s WHERE s.run_id = r.id AND s.status IN ('succeeded','failed','skipped','rejected','expired','previewed','cancelled')) AS steps_done
           FROM playbook_runs r WHERE ${where}
          ORDER BY r.created_at DESC, r.id LIMIT $4 OFFSET $5`,
        [...params, q.page_size, (q.page - 1) * q.page_size],
      )
    ).rows;
    return { items: rows.map((r) => ({ ...presentRun(r), steps_total: r.steps_total, steps_done: r.steps_done })), total, page: q.page, page_size: q.page_size };
  });
}

/** Steps waiting for an administrator, oldest request first, with what the current user may do. */
export function listApprovals(ctx: AuthContext, pageSize: number) {
  return withTenant(ctx.organizationId, async (db) => {
    const settings = await loadSettings(db);
    const admins = (await approverAccounts(ctx.organizationId)).length;
    const rows = (await db.query<{ step_id: string; run_id: string }>(
      `SELECT s.id AS step_id, s.run_id FROM playbook_run_steps s JOIN playbook_runs r ON r.id = s.run_id
        WHERE s.status = 'awaiting_approval' AND r.status = 'awaiting_approval' ORDER BY s.approval_requested_at, s.id LIMIT $1`,
      [pageSize],
    )).rows;
    const items = [];
    for (const row of rows) {
      const run = (await loadRun(db, row.run_id))!;
      const steps = await loadSteps(db, row.run_id);
      const step = steps.find((s) => s.id === row.step_id)!;
      items.push({ run: presentRun(run), step: presentStep(step), steps_total: steps.length, rights: await approvalRights(ctx, run, settings, admins) });
    }
    return { items, approvers: admins };
  });
}

/** Approve or reject a step waiting for an administrator. Rejecting needs a reason. */
export async function decide(req: Request, ctx: AuthContext, runId: string, stepId: string, body: { decision: 'approve' | 'reject'; comment?: string }) {
  if (!isAdmin(ctx.role)) throw forbidden('Only an administrator can approve or reject a playbook step');
  const decision = await withTenant(ctx.organizationId, async (db) => {
    const run = await loadRun(db, runId, 'wait');
    if (!run) throw notFound('Run');
    const steps = await loadSteps(db, runId);
    const step = steps.find((s) => s.id === stepId);
    if (!step) throw notFound('Step');
    if (step.status !== 'awaiting_approval' || run.status !== 'awaiting_approval') {
      throw new AppError(409, 'not_awaiting_approval', `This step is not waiting for approval (it is ${step.status.replace(/_/g, ' ')})`);
    }
    const now = new Date();
    if (step.approval_expires_at && new Date(step.approval_expires_at).getTime() <= now.getTime()) {
      throw new AppError(409, 'approval_expired', 'The approval request expired; the step will not be carried out');
    }
    const rights = await approvalRights(ctx, run, await loadSettings(db));
    if (body.decision === 'approve' && !rights.can_approve) throw new AppError(403, 'self_approval', rights.reason ?? 'You cannot approve this step');
    const decided = {
      decided_by: ctx.userId,
      decided_by_email: ctx.userEmail,
      decided_role: ctx.role,
      decided_ip: req.ip ?? null,
      decided_at: now,
      decision_comment: body.comment ?? null,
    };
    const router = (ROUTER_ACTIONS as readonly string[]).includes(step.action);
    let status: StepRow['status'];
    if (body.decision === 'reject') status = 'rejected';
    else if (step.action === 'approval') status = 'succeeded';
    else status = router ? 'running' : 'approved';
    const output = body.decision === 'approve' && rights.self_approval ? { ...(step.output ?? {}), self_approved: true, self_approval_reason: rights.self_approval } : step.output;
    await db.query(
      `UPDATE playbook_run_steps SET status = $2, decided_by = $3, decided_by_email = $4, decided_role = $5, decided_ip = $6, decided_at = $7, decision_comment = $8,
              output = $9, started_at = CASE WHEN $2 = 'running' THEN $7 ELSE started_at END,
              actor = CASE WHEN $2 IN ('running', 'succeeded') THEN 'user' ELSE actor END, actor_user_id = CASE WHEN $2 IN ('running', 'succeeded') THEN $3 ELSE actor_user_id END,
              actor_email = CASE WHEN $2 IN ('running', 'succeeded') THEN $4 ELSE actor_email END,
              error = CASE WHEN $2 = 'rejected' THEN $10 ELSE error END,
              finished_at = CASE WHEN $2 IN ('rejected', 'succeeded') THEN $7 ELSE finished_at END
        WHERE id = $1`,
      [
        step.id,
        status,
        decided.decided_by,
        decided.decided_by_email,
        decided.decided_role,
        decided.decided_ip,
        now,
        decided.decision_comment,
        output ? JSON.stringify(output) : null,
        `Rejected by ${ctx.userEmail}: ${body.comment ?? ''}`.trim(),
      ],
    );
    // Rejected (or a plain approval gate): the next steps follow from the engine; it settles the step.
    await db.query(`UPDATE playbook_runs SET status = 'running', next_run_at = $2 WHERE id = $1`, [run.id, now]);
    await audit(db, req, body.decision === 'approve' ? 'playbook.step.approved' : 'playbook.step.rejected', { type: 'playbook_run', id: run.id }, {
      playbook_id: run.playbook_id,
      playbook: run.playbook_name,
      step: step.step_key,
      action: step.action,
      input: step.input,
      comment: body.comment ?? null,
      ...(body.decision === 'approve' && rights.self_approval ? { self_approved: true, self_approval_reason: rights.self_approval } : {}),
    });
    await notifyRealtime(db, ctx.organizationId, 'events');
    return { router: router && body.decision === 'approve' };
  });
  if (decision.router) await executeRouterStep(req, ctx, runId, stepId);
  await advanceRun(ctx.organizationId, runId);
  return getRun(ctx, runId);
}

export function cancelRun(req: Request, ctx: AuthContext, runId: string, reason: string | undefined) {
  return withTenant(ctx.organizationId, async (db) => {
    const run = await loadRun(db, runId, 'wait');
    if (!run) throw notFound('Run');
    if (!isAdmin(ctx.role) && run.started_by !== ctx.userId) throw forbidden('Only an administrator or the person who started the run can cancel it');
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw new AppError(409, 'not_active', 'The run has already finished');
    const steps = await loadSteps(db, runId);
    const inFlight = steps.filter((s) => s.status === 'running').map((s) => s.step_key);
    const why = `Cancelled by ${ctx.userEmail}${reason ? `: ${reason}` : ''}${inFlight.length ? ` (already sent and not recalled: ${inFlight.join(', ')})` : ''}`;
    await endRun(db, run, steps, 'cancelled', why, new Date(), 'cancelled');
    await audit(db, req, 'playbook.run_cancelled', { type: 'playbook_run', id: runId }, { playbook_id: run.playbook_id, playbook: run.playbook_name, reason: reason ?? null, in_flight: inFlight });
    return presentRunDetail(db, ctx, run, steps);
  });
}

// ── settings ──

export function getSettings(organizationId: string) {
  return withTenant(organizationId, async (db) => ({ ...(await loadSettings(db)), approvers: (await approverAccounts(organizationId)).length }));
}

export function putSettings(req: Request, ctx: AuthContext, body: { two_person_rule?: boolean; approval_ttl_minutes?: number }) {
  return withTenant(ctx.organizationId, async (db) => {
    const current = await loadSettings(db);
    const next = { two_person_rule: body.two_person_rule ?? current.two_person_rule, approval_ttl_minutes: body.approval_ttl_minutes ?? current.approval_ttl_minutes };
    await db.query(
      `INSERT INTO playbook_settings (organization_id, two_person_rule, approval_ttl_minutes, updated_by, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (organization_id) DO UPDATE SET two_person_rule = EXCLUDED.two_person_rule, approval_ttl_minutes = EXCLUDED.approval_ttl_minutes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ctx.organizationId, next.two_person_rule, next.approval_ttl_minutes, ctx.userId],
    );
    await audit(db, req, 'playbook.settings_updated', { type: 'organization', id: ctx.organizationId }, { before: { two_person_rule: current.two_person_rule, approval_ttl_minutes: current.approval_ttl_minutes }, after: next });
    return { ...(await loadSettings(db)), approvers: (await approverAccounts(ctx.organizationId)).length };
  });
}
