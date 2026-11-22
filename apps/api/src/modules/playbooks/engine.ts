import type { Request } from 'express';
import { auditSystem } from '../../common/audit.ts';
import { AppError, type AuthContext } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { safeErrorMessage } from '../../infrastructure/scheduler.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { disableDevicePort, quarantineDevice } from '../ports/index.ts';
import { changeBlocks, rebootRouter, setRateLimit, setWifi } from '../routers/index.ts';
import { type ActionContext, type ActionOutcome, type StepActor, executeAction, loadDevice, pollExternal, stepDeviceId, stepRouters } from './actions.ts';
import { ACTIONS, LIMITS, riskOf } from './catalog.ts';
import { type ApprovalAlert, sendApprovalEmails } from './notify.ts';
import { ACTIVE_RUN_STATUSES, type ExternalRef, type PlaybookRow, RUN_COLUMNS, type RunRow, type RunStatus, STEP_COLUMNS, type StepRow, type StepStatus, loadSettings } from './repo.ts';

// The run engine. A run and its steps live in the database (playbook_runs, playbook_run_steps), so
// a run survives an API restart: the scheduler job (index.ts) picks up every active run whose
// next_run_at is due. A run is advanced inside one tenant transaction holding its row lock
// (FOR UPDATE SKIP LOCKED), so the job and an API request never advance the same run at once.
// Each step's action runs inside a savepoint: a failing action fails its step, never the run's record.

/**
 * Actions carried out only inside the approving administrator's own request (never by the engine):
 * the owning services audit them as that administrator's and apply their protections against the
 * machine they are using (routers: never block / cut off your own machine or the collector; switch
 * ports: never touch an uplink, trunk, or the path to the collector, the gateway or your machine).
 */
export const ROUTER_ACTIONS = ['router_block', 'router_unblock', 'router_rate_limit', 'router_wifi', 'router_reboot', 'switch_port_quarantine', 'switch_port_disable'] as const;
const DEVICE_CONTROL_ACTIONS: readonly string[] = ['router_wifi', 'router_reboot', 'switch_port_quarantine', 'switch_port_disable'];
const isRouterAction = (a: string) => (ROUTER_ACTIONS as readonly string[]).includes(a);
const TERMINAL_STEP: readonly StepStatus[] = ['succeeded', 'failed', 'skipped', 'rejected', 'expired', 'previewed', 'cancelled'];
const MAX_STEPS_PER_PASS = 30;

/** Does this step wait for an administrator before it acts? */
export function needsApproval(run: Pick<RunRow, 'dry_run' | 'approval_mode'>, step: Pick<StepRow, 'action' | 'risk'>): boolean {
  if (run.dry_run) return false;
  if (step.action === 'approval') return true;
  return step.risk === 'disruptive' && (run.approval_mode === 'always_ask' || ACTIONS[step.action].alwaysApprove);
}

export async function loadRun(db: Db, runId: string, lock: 'none' | 'wait' | 'skip' = 'none'): Promise<RunRow | null> {
  const suffix = lock === 'wait' ? ' FOR UPDATE' : lock === 'skip' ? ' FOR UPDATE SKIP LOCKED' : '';
  return (await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM playbook_runs r WHERE r.id = $1${suffix}`, [runId])).rows[0] ?? null;
}

export async function loadSteps(db: Db, runId: string): Promise<StepRow[]> {
  return (await db.query<StepRow>(`SELECT ${STEP_COLUMNS} FROM playbook_run_steps WHERE run_id = $1 ORDER BY position`, [runId])).rows;
}

const JSON_COLUMNS = new Set(['input', 'output', 'external', 'params']);

async function updateStep(db: Db, step: StepRow, patch: Partial<Omit<StepRow, 'id'>>): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const values = keys.map((k) => (JSON_COLUMNS.has(k) && patch[k] !== null && patch[k] !== undefined ? JSON.stringify(patch[k]) : patch[k]));
  await db.query(`UPDATE playbook_run_steps SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [step.id, ...values]);
  Object.assign(step, patch);
}

async function updateRun(db: Db, run: RunRow, patch: Partial<Pick<RunRow, 'status' | 'status_reason' | 'current_position' | 'next_run_at' | 'finished_at'>>): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  await db.query(`UPDATE playbook_runs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [run.id, ...keys.map((k) => patch[k])]);
  Object.assign(run, patch);
}

/** Ends the run: steps that never ran become skipped (or cancelled). */
export async function endRun(db: Db, run: RunRow, steps: StepRow[], status: RunStatus, reason: string | null, now: Date, leftover: 'skipped' | 'cancelled' = 'skipped'): Promise<void> {
  for (const s of steps) {
    if (!TERMINAL_STEP.includes(s.status) && !(s.status === 'running' && leftover === 'skipped')) {
      await updateStep(db, s, { status: leftover, finished_at: now });
    }
  }
  await updateRun(db, run, { status, status_reason: reason, finished_at: now });
  await notifyRealtime(db, run.organization_id, 'events');
}

const errorText = (err: unknown): string => (err instanceof AppError ? err.message : safeErrorMessage(err));

const actorOf = (s: StepRow): StepActor | null => (s.decided_by && s.decided_by_email ? { id: s.decided_by, email: s.decided_by_email, role: s.decided_role ?? 'admin' } : null);

async function runInSavepoint(db: Db, fn: () => Promise<ActionOutcome>): Promise<ActionOutcome> {
  await db.query('SAVEPOINT playbook_step');
  try {
    const out = await fn();
    await db.query('RELEASE SAVEPOINT playbook_step');
    return out;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT playbook_step');
    if (!(err instanceof AppError)) logger.error({ err }, 'playbook step failed unexpectedly');
    return { kind: 'failed', error: errorText(err) };
  }
}

/** After a step reached a final status: move on, or end the run. Returns false when the run ended. */
async function settle(db: Db, run: RunRow, steps: StepRow[], step: StepRow, now: Date): Promise<boolean> {
  if (step.status === 'failed' || step.status === 'rejected' || step.status === 'expired') {
    if (step.on_error === 'stop') {
      const status: RunStatus = step.status === 'failed' ? 'failed' : step.status;
      const why =
        step.status === 'failed'
          ? `Step "${step.step_key}" failed: ${step.error ?? 'unknown error'}`
          : step.status === 'rejected'
            ? `Step "${step.step_key}" was rejected by ${step.decided_by_email ?? 'an administrator'}: ${step.decision_comment ?? ''}`.trim()
            : `Nobody approved step "${step.step_key}" in time`;
      await endRun(db, run, steps, status, why, now);
      return false;
    }
  }
  await updateRun(db, run, { current_position: step.position + 1, status: 'running', next_run_at: now });
  return true;
}

async function auditStep(db: Db, run: RunRow, step: StepRow): Promise<void> {
  if (run.dry_run || ['condition', 'wait', 'approval'].includes(step.action)) return;
  await auditSystem(db, run.organization_id, {
    automation: 'playbooks',
    action: `playbook.step.${step.action}`,
    target: { type: 'playbook_run', id: run.id },
    siteId: run.site_id,
    metadata: {
      playbook_id: run.playbook_id,
      playbook: run.playbook_name,
      step: step.step_key,
      status: step.status,
      input: step.input,
      error: step.error,
      approved_by: step.decided_by_email,
    },
  });
}

async function applyOutcome(db: Db, run: RunRow, steps: StepRow[], step: StepRow, out: ActionOutcome, actor: StepActor | null, now: Date): Promise<'next' | 'wait' | 'ended'> {
  const who = { actor: actor ? ('user' as const) : ('system' as const), actor_user_id: actor?.id ?? null, actor_email: actor?.email ?? null };
  const started = { started_at: step.started_at ?? now, ...who };
  switch (out.kind) {
    case 'done':
      await updateStep(db, step, { ...started, status: 'succeeded', input: out.input ?? step.input, output: { ...(step.output ?? {}), ...out.output }, finished_at: now });
      break;
    case 'failed':
      await updateStep(db, step, { ...started, status: 'failed', input: out.input ?? step.input, error: out.error.slice(0, 2000), finished_at: now });
      break;
    case 'previewed':
      await updateStep(db, step, { ...started, status: 'previewed', input: out.input, finished_at: now });
      break;
    case 'stop':
      await updateStep(db, step, { ...started, status: 'succeeded', input: out.input ?? step.input, output: out.output, finished_at: now });
      await endRun(db, run, steps, 'stopped', out.reason, now);
      return 'ended';
    case 'pending':
      await updateStep(db, step, { ...started, status: 'running', input: out.input ?? step.input, output: out.output ?? step.output, external: out.external });
      await auditStep(db, run, step);
      await waitFor(db, run, out.external, now);
      return 'wait';
  }
  await auditStep(db, run, step);
  return (await settle(db, run, steps, step, now)) ? 'next' : 'ended';
}

async function waitFor(db: Db, run: RunRow, ext: ExternalRef | null, now: Date): Promise<void> {
  let next = new Date(now.getTime() + LIMITS.pollEverySeconds * 1000);
  if (ext?.kind === 'wait') {
    const until = new Date(ext.until);
    if (until.getTime() > now.getTime()) next = until;
  }
  await updateRun(db, run, { status: 'waiting', next_run_at: next });
  await notifyRealtime(db, run.organization_id, 'events');
}

function context(db: Db, run: RunRow, steps: StepRow[], step: StepRow, actor: StepActor | null, now: Date): ActionContext {
  return { db, organizationId: run.organization_id, run, step, steps, actor, now };
}

async function requestApproval(db: Db, run: RunRow, steps: StepRow[], step: StepRow, now: Date, alerts: ApprovalAlert[]): Promise<'wait' | 'next' | 'ended'> {
  // Describe what would happen first (a dry evaluation): a step that cannot act is failed now instead
  // of asking an administrator to approve something impossible.
  const preview = await runInSavepoint(db, () => executeAction(context(db, { ...run, dry_run: true }, steps, step, null, now)));
  if (preview.kind === 'failed') return applyOutcome(db, run, steps, step, preview, null, now);
  const input = 'input' in preview && preview.input ? preview.input : {};
  const ttl = (await loadSettings(db)).approval_ttl_minutes;
  const expires = new Date(now.getTime() + ttl * 60_000);
  await updateStep(db, step, { status: 'awaiting_approval', input, approval_requested_at: now, approval_expires_at: expires });
  await updateRun(db, run, { status: 'awaiting_approval', next_run_at: expires });
  const deviceId = stepDeviceId(run, step);
  const device = deviceId ? await loadDevice(db, deviceId) : null;
  const what = step.action === 'approval' ? String(step.params.message || 'continue the run') : `${step.action.replace(/_/g, ' ')}${device ? ` on ${device.label}` : ''}`;
  await emitEvent(db, run.organization_id, {
    siteId: run.site_id,
    deviceId: device?.id ?? null,
    type: 'playbook_approval_requested',
    severity: 'warning',
    title: `Approval needed: playbook "${run.playbook_name}" wants to ${what}`.slice(0, 200),
    details: { playbook_id: run.playbook_id, playbook: run.playbook_name, run_id: run.id, step_id: step.id, step: step.step_key, action: step.action, input, expires_at: expires.toISOString() },
    source: 'platform',
    occurredAt: now,
  });
  alerts.push({ organizationId: run.organization_id, runId: run.id, playbookName: run.playbook_name, what, expiresAt: expires, startedBy: run.started_by });
  return 'wait';
}

/**
 * Advance one run as far as it can go now. Runs inside the caller's tenant transaction. Router steps
 * are never executed here (they run inside the approving request, see executeRouterStep).
 */
export async function advanceInTx(db: Db, runId: string, now: Date, alerts: ApprovalAlert[]): Promise<void> {
  const run = await loadRun(db, runId, 'skip');
  if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) return;
  const steps = await loadSteps(db, run.id);
  for (let i = 0; i < MAX_STEPS_PER_PASS; i++) {
    const step = steps[run.current_position];
    if (!step) {
      const failed = steps.filter((s) => s.status === 'failed' || s.status === 'rejected' || s.status === 'expired').length;
      const reason = run.dry_run
        ? 'Dry run: every step was previewed; nothing was changed'
        : failed
          ? `Finished; ${failed} step(s) did not succeed and were passed over (set to continue on error)`
          : null;
      await endRun(db, run, steps, 'succeeded', reason, now);
      return;
    }
    let result: 'next' | 'wait' | 'ended';
    if (step.status === 'pending' || step.status === 'approved') {
      if (step.status === 'pending' && needsApproval(run, step)) {
        result = await requestApproval(db, run, steps, step, now, alerts);
      } else if (step.status === 'approved' && isRouterAction(step.action)) {
        // Approved but not executed at approval (process stopped in between): never acted, so fail it.
        result = await applyOutcome(db, run, steps, step, { kind: 'failed', error: 'The router change was approved but not carried out (the server stopped); start the run again' }, actorOf(step), now);
      } else {
        const actor = actorOf(step);
        const out = await runInSavepoint(db, () => executeAction(context(db, run, steps, step, actor, now)));
        result = await applyOutcome(db, run, steps, step, out, actor, now);
      }
    } else if (step.status === 'awaiting_approval') {
      if (step.approval_expires_at && new Date(step.approval_expires_at).getTime() <= now.getTime()) {
        await updateStep(db, step, { status: 'expired', finished_at: now, error: 'Nobody approved or rejected this step in time' });
        result = (await settle(db, run, steps, step, now)) ? 'next' : 'ended';
      } else {
        if (run.status !== 'awaiting_approval') await updateRun(db, run, { status: 'awaiting_approval', next_run_at: step.approval_expires_at ?? now });
        result = 'wait';
      }
    } else if (step.status === 'running') {
      if (!step.external) {
        const age = now.getTime() - new Date(step.started_at ?? now).getTime();
        if (age > LIMITS.interruptedAfterSeconds * 1000) {
          result = await applyOutcome(db, run, steps, step, { kind: 'failed', error: 'Interrupted (the server stopped while this step ran); not retried, so nothing is done twice' }, actorOf(step), now);
        } else {
          await waitFor(db, run, null, now);
          result = 'wait';
        }
      } else {
        const p = await pollExternal(db, step, now);
        if (p.kind === 'waiting') {
          await waitFor(db, run, step.external, now);
          result = 'wait';
        } else {
          const out: ActionOutcome = p.kind === 'done' ? { kind: 'done', output: p.output } : { kind: 'failed', error: p.error };
          if (p.kind === 'failed' && p.output) await updateStep(db, step, { output: { ...(step.output ?? {}), ...p.output } });
          result = await applyOutcome(db, run, steps, step, out, actorOf(step), now);
        }
      }
    } else {
      result = (await settle(db, run, steps, step, now)) ? 'next' : 'ended';
    }
    if (result !== 'next') {
      await notifyRealtime(db, run.organization_id, 'events');
      return;
    }
  }
  // Very long chains of instant steps continue on the next pass.
  await updateRun(db, run, { next_run_at: now });
}

/** Advance one run in its own transaction, then send approval e-mails. Never throws. */
export async function advanceRun(organizationId: string, runId: string, now = new Date()): Promise<void> {
  const alerts: ApprovalAlert[] = [];
  try {
    await withTenant(organizationId, (db) => advanceInTx(db, runId, now, alerts));
  } catch (err) {
    logger.error({ err, run_id: runId }, 'playbook run could not be advanced');
  }
  await sendApprovalEmails(alerts);
}

// ── run creation ───────────────────────────────────────────────────────────────

export interface NewRun {
  kind: RunRow['trigger_kind'];
  key: string;
  evidence: Record<string, unknown>;
  siteId: string | null;
  deviceId: string | null;
  incidentId: string | null;
  eventId: string | null;
  causedByRunId?: string | null;
  chain?: string[];
  startedBy?: { id: string; email: string; role: string } | null;
  dryRun: boolean;
  /** Recorded as a skipped run (with this reason) instead of running. */
  skipReason?: string | null;
}

/** Create the run and its steps. Returns null when this trigger already started the playbook. */
export async function createRun(db: Db, p: PlaybookRow, n: NewRun): Promise<string | null> {
  const authors = [...new Set([p.created_by, p.updated_by].filter((x): x is string => Boolean(x)))];
  const skipped = Boolean(n.skipReason);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO playbook_runs (organization_id, playbook_id, playbook_name, playbook_version, site_id, device_id, incident_id, event_id, trigger_kind, trigger_key,
                                evidence, dry_run, approval_mode, status, status_reason, caused_by_run_id, chain, author_ids, started_by, started_by_email, started_by_role, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, CASE WHEN $14 = 'skipped' THEN now() END)
     ON CONFLICT (playbook_id, trigger_key) WHERE playbook_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      p.organization_id,
      p.id,
      p.name,
      p.version,
      n.siteId ?? p.site_id,
      n.deviceId,
      n.incidentId,
      n.eventId,
      n.kind,
      n.key,
      JSON.stringify(n.evidence),
      n.dryRun,
      p.approval_mode,
      skipped ? 'skipped' : 'queued',
      n.skipReason ?? null,
      n.causedByRunId ?? null,
      n.chain ?? [],
      authors,
      n.startedBy?.id ?? null,
      n.startedBy?.email ?? null,
      n.startedBy?.role ?? null,
    ],
  );
  const runId = inserted.rows[0]?.id;
  if (!runId) return null;
  for (const [i, s] of p.steps.entries()) {
    await db.query(
      `INSERT INTO playbook_run_steps (organization_id, run_id, position, step_key, action, params, risk, on_error, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [p.organization_id, runId, i, s.key, s.action, JSON.stringify(s.params ?? {}), riskOf(s.action, (s.params ?? {}) as Record<string, unknown>), s.on_error ?? 'stop', skipped ? 'skipped' : 'pending'],
    );
  }
  await notifyRealtime(db, p.organization_id, 'events');
  return runId;
}

// ── router steps: executed inside the approving administrator's request ──────

/**
 * Carry out an approved router step with the approver's own request (routers/control.ts audits it as
 * theirs and refuses to block the machine they are using). Every router of the site is asked unless
 * the step names one; per-router results are recorded on the step.
 */
export async function executeRouterStep(req: Request, ctx: AuthContext, runId: string, stepId: string): Promise<void> {
  const org = ctx.organizationId;
  const loaded = await withTenant(org, async (db) => {
    const run = await loadRun(db, runId);
    const step = (await loadSteps(db, runId)).find((s) => s.id === stepId);
    if (!run || !step) return null;
    const deviceId = stepDeviceId(run, step);
    const device = deviceId ? await loadDevice(db, deviceId) : null;
    const routers = device ? await stepRouters(db, step, device.site_id) : [];
    return { run, step, device, routers };
  });
  if (!loaded) return;
  if (DEVICE_CONTROL_ACTIONS.includes(loaded.step.action)) {
    await executeDeviceControlStep(req, ctx, runId, stepId);
    return;
  }
  const { step, device, routers } = loaded;
  const results: Record<string, unknown>[] = [];
  let error: string | null = null;
  if (!device) error = 'The device no longer exists';
  else if (!routers.length) error = 'No router is set up for this site (Routers → Add router), so nothing could be changed';
  else {
    for (const r of routers) {
      try {
        if (step.action === 'router_rate_limit') {
          const q = await setRateLimit(req, ctx, r.id, device.id, { down_kbps: Number(step.params.down_kbps), up_kbps: Number(step.params.up_kbps) });
          results.push({ router_id: r.id, router: r.name, status: 'queued', request_id: q.request_id });
        } else {
          const res = await changeBlocks(req, ctx, r.id, [device.id], step.action === 'router_block' ? 'block' : 'unblock');
          const one = res.results[0];
          results.push({ router_id: r.id, router: r.name, status: one?.status ?? 'refused', request_id: one?.request_id, code: one?.code, message: one?.message });
        }
      } catch (err) {
        results.push({ router_id: r.id, router: r.name, status: 'refused', code: err instanceof AppError ? err.code : 'error', message: errorText(err) });
      }
    }
  }
  const ids = results.filter((r) => r.status === 'queued' && typeof r.request_id === 'string').map((r) => r.request_id as string);
  if (!error && !ids.length) error = results.map((r) => `${String(r.router)}: ${String(r.message ?? r.code)}`).join('; ');
  await withTenant(org, async (db) => {
    const run = await loadRun(db, runId, 'wait');
    const steps = await loadSteps(db, runId);
    const s = steps.find((x) => x.id === stepId);
    if (!run || !s || s.status !== 'running') return;
    const now = new Date();
    if (error) {
      await applyOutcome(db, run, steps, s, { kind: 'failed', error, input: { ...(s.input ?? {}), router_results: results } }, actorOf(s), now);
    } else {
      await applyOutcome(db, run, steps, s, { kind: 'pending', output: { router_results: results }, external: { kind: 'router_requests', ids } }, actorOf(s), now);
    }
  });
}

/**
 * Router Wi-Fi / reboot and switch port quarantine / disable, approved: carried out with the approver's
 * request through the owning service (same validation, protections and audit as the Routers and
 * Switches pages; no override of a refused risky port). The step then waits for the router or switch
 * request the service queued.
 */
async function executeDeviceControlStep(req: Request, ctx: AuthContext, runId: string, stepId: string): Promise<void> {
  const org = ctx.organizationId;
  const loaded = await withTenant(org, async (db) => {
    const run = await loadRun(db, runId);
    const step = (await loadSteps(db, runId)).find((s) => s.id === stepId);
    if (!run || !step) return null;
    return { run, step, deviceId: stepDeviceId(run, step) };
  });
  if (!loaded) return;
  const { step, deviceId } = loaded;
  let external: ExternalRef | null = null;
  let error: string | null = null;
  let result: Record<string, unknown> = {};
  try {
    switch (step.action) {
      case 'router_wifi': {
        const p = step.params as { router_id: string; wifi_id: string; enabled: boolean; confirm_main_network?: boolean };
        const q = (await setWifi(req, ctx, p.router_id, { wifi_id: p.wifi_id, enabled: p.enabled, confirm: p.confirm_main_network === true })) as { request_id: string };
        result = { router_id: p.router_id, wifi_id: p.wifi_id, enabled: p.enabled, request_id: q.request_id };
        external = { kind: 'router_requests', ids: [q.request_id] };
        break;
      }
      case 'router_reboot': {
        const routerId = String(step.params.router_id);
        const q = (await rebootRouter(req, ctx, routerId)) as { request_id: string };
        result = { router_id: routerId, request_id: q.request_id };
        external = { kind: 'router_requests', ids: [q.request_id] };
        break;
      }
      case 'switch_port_quarantine': {
        if (!deviceId) throw new AppError(409, 'no_device', 'This step needs a device');
        const reason = typeof step.params.reason === 'string' && step.params.reason ? step.params.reason : `Playbook step "${step.step_key}"`;
        const q = await quarantineDevice(req, ctx, deviceId, reason);
        result = { device_id: deviceId, quarantine_id: q.quarantine_id, request_id: q.request_id };
        external = { kind: 'switch_port_requests', ids: [q.request_id] };
        break;
      }
      case 'switch_port_disable': {
        if (!deviceId) throw new AppError(409, 'no_device', 'This step needs a device');
        const q = await disableDevicePort(req, ctx, deviceId);
        result = { device_id: deviceId, request_id: q.request_id };
        external = { kind: 'switch_port_requests', ids: [q.request_id] };
        break;
      }
    }
  } catch (err) {
    error = err instanceof AppError ? `${err.code}: ${err.message}` : errorText(err);
  }
  await withTenant(org, async (db) => {
    const run = await loadRun(db, runId, 'wait');
    const steps = await loadSteps(db, runId);
    const s = steps.find((x) => x.id === stepId);
    if (!run || !s || s.status !== 'running') return;
    const now = new Date();
    if (error || !external) {
      await applyOutcome(db, run, steps, s, { kind: 'failed', error: error ?? 'Nothing was changed', input: { ...(s.input ?? {}), refused: true } }, actorOf(s), now);
    } else {
      await applyOutcome(db, run, steps, s, { kind: 'pending', output: result, external }, actorOf(s), now);
    }
  });
}
