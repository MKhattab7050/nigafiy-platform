import type { Request } from 'express';
import type {
  FleetJob,
  FleetJobCounts,
  FleetJobDetail,
  FleetJobResult,
  FleetJobResultState,
  FleetJobRun,
  FleetScriptParam,
} from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { safeTimeZone } from '../../../common/timezone.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { toolRefusal } from '../fleet-policy/enforce.ts';
import { ONLINE_WITHIN_MS } from '../repo.ts';
import { agentParams, resolveParamValues } from './params.ts';
import { nextOccurrence } from './schedule.ts';
import type { JobCreate } from './schema.ts';
import { scriptById, scriptVersion } from './scripts.ts';

// Jobs (Fleet Pro, migration 042): a script version with validated parameter values, run on one
// computer, a selection or a fleet group, now, once at a time, or on a recurrence in a time zone,
// optionally only inside a maintenance window of the computer's site.
//
// A run is one occurrence: it gets one result row per computer. A result waits ("pending") until
// its computer is online (and inside a maintenance window when the job asks), then the API queues a
// `script_run` command for the agent ("queued"); the agent's answer makes it succeeded or failed.
// A computer that does not come back before the run's expiry gets "expired". The scheduler
// (runJobScheduler, every 15 s) creates due runs and hands pending results to computers that are
// back online. Every create, run, rerun, pause and cancel is audited; results are audited as
// system rows. Output never reaches the audit log.

/** What the agent keeps of each stream (the full copy, downloadable). */
export const MAX_OUTPUT_BYTES = 1 << 20;
/** What the result row shows inline. */
export const PREVIEW_CHARS = 8192;
/** Extra time after the script's timeout before a missing answer counts as a failure. */
const ANSWER_GRACE_S = 300;

const OPEN_STATES: FleetJobResultState[] = ['pending', 'queued'];

const isAdmin = (ctx: AuthContext) => ctx.role === 'owner' || ctx.role === 'admin';

async function auditJobEvent(db: Db, orgId: string, target: { type: string; id: string }, action: string, metadata: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
     VALUES ($1, NULL, NULL, $2, $3, $4, $5, 'system')`,
    [orgId, action, target.type, target.id, JSON.stringify({ ...metadata, source: 'fleet_jobs' })],
  );
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────

const JOB_COLUMNS = `j.id, j.name, j.script_id, s.name AS script_name, j.script_version, s.os AS script_os, s.technician_runnable,
  j.parameters, j.target_kind, j.endpoint_ids, j.fleet_group_id, g.name AS fleet_group_name, j.schedule_kind, j.run_at,
  j.recur_every, j.recur_time, j.recur_weekdays::int[] AS recur_weekdays, j.recur_monthday, j.timezone, j.maintenance_only,
  j.expiry_minutes, j.next_run_at, j.state, j.created_by, j.created_by_email, j.created_by_role, j.created_at, j.cancelled_at, j.cancelled_by_email`;

interface JobRow {
  id: string;
  name: string;
  script_id: string;
  script_name: string;
  script_version: number;
  script_os: FleetJob['script_os'];
  technician_runnable: boolean;
  parameters: FleetJob['parameters'];
  target_kind: FleetJob['target_kind'];
  endpoint_ids: string[];
  fleet_group_id: string | null;
  fleet_group_name: string | null;
  schedule_kind: FleetJob['schedule_kind'];
  run_at: Date | null;
  recur_every: FleetJob['recur_every'];
  recur_time: string | null;
  recur_weekdays: number[] | null;
  recur_monthday: number | null;
  timezone: string;
  maintenance_only: boolean;
  expiry_minutes: number;
  next_run_at: Date | null;
  state: FleetJob['state'];
  created_by: string | null;
  created_by_email: string;
  created_by_role: string;
  created_at: Date;
  cancelled_at: Date | null;
  cancelled_by_email: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function emptyCounts(): FleetJobCounts {
  return { total: 0, pending: 0, queued: 0, succeeded: 0, failed: 0, expired: 0, cancelled: 0, skipped: 0 };
}

async function countsByRun(db: Db, runIds: string[]): Promise<Map<string, FleetJobCounts>> {
  const out = new Map<string, FleetJobCounts>();
  if (!runIds.length) return out;
  const r = await db.query<{ run_id: string; state: FleetJobResultState; n: number }>(
    `SELECT run_id, state, count(*)::int AS n FROM fleet_job_results WHERE run_id = ANY($1::uuid[]) GROUP BY run_id, state`,
    [runIds],
  );
  for (const row of r.rows) {
    const c = out.get(row.run_id) ?? emptyCounts();
    c[row.state] += row.n;
    c.total += row.n;
    out.set(row.run_id, c);
  }
  return out;
}

async function presentJobs(db: Db, rows: JobRow[]): Promise<FleetJob[]> {
  if (!rows.length) return [];
  const last = await db.query<{ job_id: string; id: string; kind: FleetJobRun['kind']; created_at: Date }>(
    `SELECT DISTINCT ON (job_id) job_id, id, kind, created_at FROM fleet_job_runs WHERE job_id = ANY($1::uuid[]) ORDER BY job_id, created_at DESC`,
    [rows.map((r) => r.id)],
  );
  const counts = await countsByRun(db, last.rows.map((r) => r.id));
  const lastBy = new Map(last.rows.map((r) => [r.job_id, r]));
  return rows.map((j) => {
    const l = lastBy.get(j.id);
    return {
      id: j.id,
      name: j.name,
      script_id: j.script_id,
      script_name: j.script_name,
      script_version: j.script_version,
      script_os: j.script_os,
      parameters: j.parameters,
      target_kind: j.target_kind,
      endpoint_ids: j.endpoint_ids,
      fleet_group_id: j.fleet_group_id,
      fleet_group_name: j.fleet_group_name,
      schedule_kind: j.schedule_kind,
      run_at: iso(j.run_at),
      recur_every: j.recur_every,
      recur_time: j.recur_time,
      recur_weekdays: j.recur_weekdays,
      recur_monthday: j.recur_monthday,
      timezone: j.timezone,
      maintenance_only: j.maintenance_only,
      expiry_minutes: j.expiry_minutes,
      next_run_at: iso(j.next_run_at),
      state: j.state,
      created_by_email: j.created_by_email,
      created_at: j.created_at.toISOString(),
      cancelled_at: iso(j.cancelled_at),
      cancelled_by_email: j.cancelled_by_email,
      last_run: l ? { id: l.id, kind: l.kind, created_at: l.created_at.toISOString(), counts: counts.get(l.id) ?? emptyCounts() } : null,
    };
  });
}

async function jobRow(db: Db, id: string): Promise<JobRow | null> {
  const r = await db.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM fleet_jobs j JOIN fleet_scripts s ON s.id = j.script_id LEFT JOIN fleet_groups g ON g.id = j.fleet_group_id WHERE j.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Technicians see jobs of scripts they may run and the jobs they created. */
function visibleTo(ctx: AuthContext, j: Pick<JobRow, 'technician_runnable' | 'created_by'>): boolean {
  return isAdmin(ctx) || j.technician_runnable || j.created_by === ctx.userId;
}

/** Changing a job (run now, rerun, pause, cancel): admins, or the technician who created it while its script is still runnable by technicians. */
function assertCanManage(ctx: AuthContext, j: JobRow): void {
  if (isAdmin(ctx)) return;
  if (j.created_by === ctx.userId && j.technician_runnable) return;
  throw new AppError(403, 'job_not_yours', 'Only an admin, or the technician who created this job, can change it');
}

export async function listJobs(ctx: AuthContext, q: { state?: FleetJob['state']; endpoint_id?: string; limit: number }): Promise<FleetJob[]> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM fleet_jobs j JOIN fleet_scripts s ON s.id = j.script_id LEFT JOIN fleet_groups g ON g.id = j.fleet_group_id
        WHERE ($1::text IS NULL OR j.state = $1)
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM fleet_job_results x WHERE x.job_id = j.id AND x.endpoint_id = $2) OR $2 = ANY(j.endpoint_ids))
          AND ($3 OR s.technician_runnable OR j.created_by = $4)
        ORDER BY j.created_at DESC LIMIT $5`,
      [q.state ?? null, q.endpoint_id ?? null, isAdmin(ctx), ctx.userId, q.limit],
    );
    return presentJobs(db, r.rows);
  });
}

const RESULT_COLUMNS = `r.id, r.run_id, r.endpoint_id, e.name AS endpoint_name, r.state, r.waiting_for, r.skip_reason, r.exit_code,
  r.stdout_preview, r.stderr_preview, r.stdout_bytes, r.stderr_bytes, r.output_capped, r.duration_ms, r.error, r.queued_at, r.finished_at, r.created_at`;

type ResultRow = Omit<FleetJobResult, 'queued_at' | 'finished_at' | 'created_at' | 'truncated'> & { queued_at: Date | null; finished_at: Date | null; created_at: Date };

function presentResult(r: ResultRow): FleetJobResult {
  const truncated = (r.stdout_bytes ?? 0) > Buffer.byteLength(r.stdout_preview ?? '') || (r.stderr_bytes ?? 0) > Buffer.byteLength(r.stderr_preview ?? '');
  return { ...r, truncated, queued_at: iso(r.queued_at), finished_at: iso(r.finished_at), created_at: r.created_at.toISOString() };
}

export async function getJob(ctx: AuthContext, id: string): Promise<FleetJobDetail> {
  return withTenant(ctx.organizationId, async (db) => {
    const j = await jobRow(db, id);
    if (!j || !visibleTo(ctx, j)) throw notFound('Job');
    const [job] = await presentJobs(db, [j]);
    const runs = await db.query<{ id: string; kind: FleetJobRun['kind']; rerun_of: string | null; scheduled_for: Date; expires_at: Date; created_by_email: string | null; created_at: Date }>(
      `SELECT id, kind, rerun_of, scheduled_for, expires_at, created_by_email, created_at FROM fleet_job_runs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
    const runIds = runs.rows.map((r) => r.id);
    const counts = await countsByRun(db, runIds);
    const results = runIds.length
      ? (
          await db.query<ResultRow>(
            `SELECT ${RESULT_COLUMNS} FROM fleet_job_results r JOIN endpoints e ON e.id = r.endpoint_id WHERE r.run_id = ANY($1::uuid[]) ORDER BY lower(e.name)`,
            [runIds],
          )
        ).rows
      : [];
    const v = await scriptVersion(db, j.script_id, j.script_version);
    return {
      ...job!,
      script_parameters: v?.parameters ?? [],
      runs: runs.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        rerun_of: r.rerun_of,
        scheduled_for: r.scheduled_for.toISOString(),
        expires_at: r.expires_at.toISOString(),
        created_by_email: r.created_by_email,
        created_at: r.created_at.toISOString(),
        counts: counts.get(r.id) ?? emptyCounts(),
        results: results.filter((x) => x.run_id === r.id).map(presentResult),
      })),
    };
  });
}

/** The full copy of one result's output (text/plain). */
export async function resultOutput(req: Request, ctx: AuthContext, jobId: string, resultId: string, stream: 'stdout' | 'stderr'): Promise<{ text: string; endpointName: string }> {
  return withTenant(ctx.organizationId, async (db) => {
    const j = await jobRow(db, jobId);
    if (!j || !visibleTo(ctx, j)) throw notFound('Job');
    const r = await db.query<{ stdout: string | null; stderr: string | null; preview_out: string | null; preview_err: string | null; endpoint_name: string }>(
      `SELECT o.stdout, o.stderr, r.stdout_preview AS preview_out, r.stderr_preview AS preview_err, e.name AS endpoint_name
         FROM fleet_job_results r JOIN endpoints e ON e.id = r.endpoint_id LEFT JOIN fleet_job_outputs o ON o.result_id = r.id
        WHERE r.id = $1 AND r.job_id = $2`,
      [resultId, jobId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('Result');
    const text = (stream === 'stdout' ? (row.stdout ?? row.preview_out) : (row.stderr ?? row.preview_err)) ?? '';
    await audit(db, req, 'fleet.job_output_downloaded', { type: 'fleet_job', id: jobId }, { result_id: resultId, stream, bytes: Buffer.byteLength(text) });
    return { text, endpointName: row.endpoint_name };
  });
}

// ── Creating and changing ──────────────────────────────────────────────────────────────────────

/** The schedule's time zone when none was given: the site of the first computer (or group member). */
async function defaultTimeZone(db: Db, endpointIds: string[], groupId: string | null): Promise<string> {
  const r = await db.query<{ timezone: string | null }>(
    `SELECT s.timezone FROM endpoints e JOIN sites s ON s.organization_id = e.organization_id AND s.id = e.site_id
      WHERE ($1::uuid[] IS NOT NULL AND e.id = ANY($1::uuid[])) OR ($2::uuid IS NOT NULL AND e.fleet_group_id = $2)
      ORDER BY e.name LIMIT 1`,
    [endpointIds.length ? endpointIds : null, groupId],
  );
  return safeTimeZone(r.rows[0]?.timezone);
}

export async function createJob(req: Request, ctx: AuthContext, body: JobCreate): Promise<FleetJob> {
  const created = await withTenant(ctx.organizationId, async (db) => {
    const script = await scriptById(db, body.script_id);
    if (!script || (!isAdmin(ctx) && !script.technician_runnable)) {
      if (script && !isAdmin(ctx)) throw new AppError(403, 'script_not_runnable_by_technicians', 'An admin has not allowed technicians to run this script');
      throw notFound('Script');
    }
    if (script.archived_at) throw new AppError(409, 'script_archived', 'This script is archived');
    const version = body.script_version ?? script.current_version;
    const v = await scriptVersion(db, script.id, version);
    if (!v) throw notFound('Script version');
    const values = resolveParamValues(v.parameters, body.parameters);

    let endpointIds: string[] = [];
    let groupId: string | null = null;
    if (body.target.kind === 'endpoints') {
      endpointIds = body.target.endpoint_ids;
      const found = await db.query<{ id: string }>(`SELECT id FROM endpoints WHERE id = ANY($1::uuid[]) AND kind = 'agent'`, [endpointIds]);
      if (found.rowCount !== endpointIds.length) throw notFound('Endpoint');
    } else {
      groupId = body.target.fleet_group_id;
      const g = await db.query(`SELECT 1 FROM fleet_groups WHERE id = $1`, [groupId]);
      if (!g.rowCount) throw notFound('Group');
    }
    const tz = body.timezone ?? (await defaultTimeZone(db, endpointIds, groupId));
    const now = new Date();
    let nextRun: Date;
    if (body.schedule.kind === 'now') nextRun = now;
    else if (body.schedule.kind === 'once') {
      nextRun = new Date(body.schedule.run_at);
      if (nextRun.getTime() < now.getTime() - 60_000) throw new AppError(422, 'run_at_in_past', 'The time to run is in the past');
      if (nextRun.getTime() > now.getTime() + 366 * 86_400_000) throw new AppError(422, 'run_at_too_far', 'The time to run is more than a year ahead');
    } else {
      nextRun = nextOccurrence(
        { every: body.schedule.every, time: body.schedule.time, weekdays: body.schedule.weekdays ?? null, monthday: body.schedule.monthday ?? null },
        now,
        tz,
      );
    }
    const s = body.schedule;
    const name = body.name ?? script.name;
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO fleet_jobs (organization_id, name, script_id, script_version, parameters, target_kind, endpoint_ids, fleet_group_id,
                                 schedule_kind, run_at, recur_every, recur_time, recur_weekdays, recur_monthday, timezone, maintenance_only,
                                 expiry_minutes, next_run_at, created_by, created_by_email, created_by_role)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
        [
          ctx.organizationId,
          name,
          script.id,
          version,
          JSON.stringify(values),
          body.target.kind,
          endpointIds,
          groupId,
          s.kind,
          s.kind === 'once' ? s.run_at : null,
          s.kind === 'recurring' ? s.every : null,
          s.kind === 'recurring' ? s.time : null,
          s.kind === 'recurring' && s.every === 'weekly' ? s.weekdays : null,
          s.kind === 'recurring' && s.every === 'monthly' ? s.monthday : null,
          tz,
          body.maintenance_only,
          body.expiry_minutes,
          nextRun,
          ctx.userId,
          ctx.userEmail,
          ctx.role,
        ],
      )
    ).rows[0]!.id;
    await audit(db, req, 'fleet.job_created', { type: 'fleet_job', id }, {
      name,
      script_id: script.id,
      script_name: script.name,
      script_version: version,
      body_sha256: v.body_sha256,
      // Names and types only: values may be anything the admin typed.
      parameters: Object.keys(values),
      target: body.target.kind === 'endpoints' ? { endpoints: endpointIds.length } : { fleet_group_id: groupId },
      schedule: s,
      timezone: tz,
      maintenance_only: body.maintenance_only,
      expiry_minutes: body.expiry_minutes,
    });
    return id;
  });
  if (body.schedule.kind === 'now') await runDueJobs(ctx.organizationId, created);
  return withTenant(ctx.organizationId, async (db) => (await presentJobs(db, [(await jobRow(db, created))!]))[0]!);
}

/** Creates one run: a result per target computer (skipped where the script's OS does not fit). */
async function createRun(
  db: Db,
  orgId: string,
  j: JobRow,
  kind: FleetJobRun['kind'],
  scheduledFor: Date,
  by: string | null,
  onlyEndpoints: string[] | null = null,
  rerunOf: string | null = null,
): Promise<{ runId: string; targets: number }> {
  const run = (
    await db.query<{ id: string }>(
      `INSERT INTO fleet_job_runs (organization_id, job_id, kind, rerun_of, scheduled_for, expires_at, created_by_email)
       VALUES ($1,$2,$3,$4,$5, greatest($5, now()) + make_interval(mins => $6), $7) RETURNING id`,
      [orgId, j.id, kind, rerunOf, scheduledFor, j.expiry_minutes, by],
    )
  ).rows[0]!.id;
  const targets = await db.query<{ id: string; platform: string; status: string }>(
    onlyEndpoints
      ? `SELECT id, platform, status FROM endpoints WHERE id = ANY($1::uuid[]) AND kind = 'agent'`
      : j.target_kind === 'group'
        ? `SELECT id, platform, status FROM endpoints WHERE fleet_group_id = $1 AND kind = 'agent'`
        : `SELECT id, platform, status FROM endpoints WHERE id = ANY($1::uuid[]) AND kind = 'agent'`,
    [onlyEndpoints ?? (j.target_kind === 'group' ? j.fleet_group_id : j.endpoint_ids)],
  );
  for (const t of targets.rows) {
    const skip = t.status !== 'active' ? 'The computer is not enrolled (pending or revoked)' : t.platform !== j.script_os ? `The script is for ${j.script_os}; this computer runs ${t.platform}` : null;
    await db.query(
      `INSERT INTO fleet_job_results (organization_id, job_id, run_id, endpoint_id, state, skip_reason, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 = 'skipped' THEN now() END)`,
      [orgId, j.id, run, t.id, skip ? 'skipped' : 'pending', skip],
    );
  }
  await auditJobEvent(db, orgId, { type: 'fleet_job', id: j.id }, 'fleet.job_run_started', { run_id: run, kind, computers: targets.rowCount ?? 0, scheduled_for: scheduledFor.toISOString() });
  return { runId: run, targets: targets.rowCount ?? 0 };
}

async function lockJob(db: Db, id: string): Promise<JobRow | null> {
  await db.query(`SELECT 1 FROM fleet_jobs WHERE id = $1 FOR UPDATE`, [id]);
  return jobRow(db, id);
}

export async function runJobNow(req: Request, ctx: AuthContext, id: string): Promise<{ run_id: string; computers: number }> {
  const out = await withTenant(ctx.organizationId, async (db) => {
    const j = await lockJob(db, id);
    if (!j || !visibleTo(ctx, j)) throw notFound('Job');
    assertCanManage(ctx, j);
    if (j.state === 'cancelled') throw new AppError(409, 'job_cancelled', 'This job was cancelled');
    const s = await scriptById(db, j.script_id);
    if (s?.archived_at) throw new AppError(409, 'script_archived', 'This script is archived');
    const r = await createRun(db, ctx.organizationId, j, 'manual', new Date(), ctx.userEmail);
    await audit(db, req, 'fleet.job_run_now', { type: 'fleet_job', id }, { run_id: r.runId, computers: r.targets });
    return { run_id: r.runId, computers: r.targets };
  });
  await dispatchPending(ctx.organizationId);
  return out;
}

/** Reruns the computers that failed, expired or were cancelled in a run (default: the latest run). */
export async function rerunFailed(req: Request, ctx: AuthContext, id: string, runId: string | undefined): Promise<{ run_id: string; computers: number }> {
  const out = await withTenant(ctx.organizationId, async (db) => {
    const j = await lockJob(db, id);
    if (!j || !visibleTo(ctx, j)) throw notFound('Job');
    assertCanManage(ctx, j);
    if (j.state === 'cancelled') throw new AppError(409, 'job_cancelled', 'This job was cancelled');
    const run = (
      await db.query<{ id: string }>(
        runId ? `SELECT id FROM fleet_job_runs WHERE id = $2 AND job_id = $1` : `SELECT id FROM fleet_job_runs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
        runId ? [id, runId] : [id],
      )
    ).rows[0];
    if (!run) throw notFound('Run');
    const failed = await db.query<{ endpoint_id: string }>(`SELECT endpoint_id FROM fleet_job_results WHERE run_id = $1 AND state IN ('failed', 'expired', 'cancelled')`, [run.id]);
    if (!failed.rowCount) throw new AppError(409, 'nothing_to_rerun', 'No computer failed in this run');
    const r = await createRun(db, ctx.organizationId, j, 'rerun', new Date(), ctx.userEmail, failed.rows.map((x) => x.endpoint_id), run.id);
    await audit(db, req, 'fleet.job_rerun', { type: 'fleet_job', id }, { run_id: r.runId, rerun_of: run.id, computers: r.targets });
    return { run_id: r.runId, computers: r.targets };
  });
  await dispatchPending(ctx.organizationId);
  return out;
}

export async function pauseJob(req: Request, ctx: AuthContext, id: string, paused: boolean): Promise<FleetJob> {
  return withTenant(ctx.organizationId, async (db) => {
    const j = await lockJob(db, id);
    if (!j || !visibleTo(ctx, j)) throw notFound('Job');
    assertCanManage(ctx, j);
    if (j.state !== (paused ? 'active' : 'paused')) throw new AppError(409, 'job_state', paused ? 'Only an active job can be paused' : 'Only a paused job can be resumed');
    let next = j.next_run_at;
    if (!paused && j.schedule_kind === 'recurring') {
      next = nextOccurrence({ every: j.recur_every!, time: j.recur_time!, weekdays: j.recur_weekdays, monthday: j.recur_monthday }, new Date(), j.timezone);
    }
    await db.query(`UPDATE fleet_jobs SET state = $2, next_run_at = $3, updated_at = now() WHERE id = $1`, [id, paused ? 'paused' : 'active', next]);
    await audit(db, req, paused ? 'fleet.job_paused' : 'fleet.job_resumed', { type: 'fleet_job', id }, { name: j.name });
    return (await presentJobs(db, [(await jobRow(db, id))!]))[0]!;
  });
}

/**
 * Cancels a job: no further runs; results still waiting are cancelled; a command the agent has not
 * picked up is withdrawn; a script already running gets `script_cancel` (the agent stops its
 * process tree and answers "cancelled").
 */
export async function cancelJob(req: Request, ctx: AuthContext, id: string): Promise<FleetJob> {
  return withTenant(ctx.organizationId, async (db) => {
    const j = await lockJob(db, id);
    if (!j || !visibleTo(ctx, j)) throw notFound('Job');
    assertCanManage(ctx, j);
    if (j.state === 'cancelled') throw new AppError(409, 'job_cancelled', 'This job was already cancelled');
    await db.query(`UPDATE fleet_jobs SET state = 'cancelled', next_run_at = NULL, cancelled_at = now(), cancelled_by_email = $2, updated_at = now() WHERE id = $1`, [id, ctx.userEmail]);
    const pending = await db.query(`UPDATE fleet_job_results SET state = 'cancelled', waiting_for = NULL, finished_at = now() WHERE job_id = $1 AND state = 'pending'`, [id]);
    const queued = await db.query<{ id: string; endpoint_id: string; command_id: string; cmd_status: string }>(
      `SELECT r.id, r.endpoint_id, r.command_id, c.status AS cmd_status
         FROM fleet_job_results r JOIN endpoint_commands c ON c.id = r.command_id
        WHERE r.job_id = $1 AND r.state = 'queued'`,
      [id],
    );
    let withdrawn = 0;
    let stopping = 0;
    for (const q of queued.rows) {
      if (q.cmd_status === 'pending') {
        const w = await db.query(`UPDATE endpoint_commands SET status = 'expired', completed_at = now(), error = 'Cancelled before the agent picked it up' WHERE id = $1 AND status = 'pending'`, [q.command_id]);
        if (w.rowCount) {
          await db.query(`UPDATE fleet_job_results SET state = 'cancelled', finished_at = now(), error = 'Cancelled before the computer started it' WHERE id = $1`, [q.id]);
          withdrawn++;
          continue;
        }
      }
      await db.query(
        `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name) VALUES ($1,$2,'script_cancel',$3,$4,$5)`,
        [ctx.organizationId, q.endpoint_id, JSON.stringify({ result_id: q.id }), ctx.userId, ctx.userEmail],
      );
      stopping++;
    }
    await audit(db, req, 'fleet.job_cancelled', { type: 'fleet_job', id }, { name: j.name, cancelled_waiting: (pending.rowCount ?? 0) + withdrawn, stopping_running: stopping });
    return (await presentJobs(db, [(await jobRow(db, id))!]))[0]!;
  });
}

// ── Scheduler and dispatch ────────────────────────────────────────────────────────────────────

/** Creates the runs that are due (optionally of one job) and dispatches pending results. */
export async function runDueJobs(orgId?: string, jobId?: string): Promise<number> {
  const due = await withSystem(
    async (db) =>
      (
        await db.query<{ id: string; organization_id: string }>(
          `SELECT id, organization_id FROM fleet_jobs
            WHERE state = 'active' AND next_run_at <= now() AND ($1::uuid IS NULL OR organization_id = $1) AND ($2::uuid IS NULL OR id = $2)
            ORDER BY next_run_at LIMIT 100`,
          [orgId ?? null, jobId ?? null],
        )
      ).rows,
  );
  for (const d of due) {
    await withTenant(d.organization_id, async (db) => {
      const j = await lockJob(db, d.id);
      if (j?.state !== 'active' || !j.next_run_at || j.next_run_at.getTime() > Date.now()) return;
      const scheduledFor = j.next_run_at;
      await createRun(db, d.organization_id, j, 'scheduled', scheduledFor, j.created_by_email);
      if (j.schedule_kind === 'recurring') {
        // One run for missed occurrences (the server was down), then the next one after now.
        const next = nextOccurrence({ every: j.recur_every!, time: j.recur_time!, weekdays: j.recur_weekdays, monthday: j.recur_monthday }, new Date(), j.timezone);
        await db.query(`UPDATE fleet_jobs SET next_run_at = $2, updated_at = now() WHERE id = $1`, [j.id, next]);
      } else {
        await db.query(`UPDATE fleet_jobs SET state = 'finished', next_run_at = NULL, updated_at = now() WHERE id = $1`, [j.id]);
      }
    });
  }
  const orgs = orgId
    ? [orgId]
    : await withSystem(async (db) => (await db.query<{ organization_id: string }>(`SELECT DISTINCT organization_id FROM fleet_job_results WHERE state IN ('pending', 'queued')`)).rows.map((r) => r.organization_id));
  for (const o of orgs) await dispatchPending(o);
  return due.length;
}

/** The module job (every 15 s). */
export async function runJobScheduler(): Promise<void> {
  await runDueJobs();
}

interface PendingRow {
  id: string;
  job_id: string;
  run_id: string;
  endpoint_id: string;
  state: 'pending' | 'queued';
  expired: boolean;
  online: boolean;
  in_window: boolean;
  maintenance_only: boolean;
  job_state: string;
  script_id: string;
  script_version: number;
  language: 'powershell' | 'sh';
  parameters: Record<string, string | number | boolean>;
  created_by: string | null;
  created_by_email: string;
  created_by_role: string;
  timeout_s: number;
  answer_overdue: boolean;
  command_id: string | null;
}

/**
 * Hands pending results to computers that are online (and inside a maintenance window when the
 * job asks), expires those past the run's expiry, and fails queued ones whose agent never answered.
 */
export async function dispatchPending(orgId: string): Promise<{ queued: number; expired: number; overdue: number }> {
  return withTenant(orgId, async (db) => {
    const rows = (
      await db.query<PendingRow>(
        `SELECT r.id, r.job_id, r.run_id, r.endpoint_id, r.state, r.command_id,
                (ru.expires_at <= now()) AS expired,
                (e.status = 'active' AND e.last_heartbeat_at > now() - make_interval(secs => $1)) AS online,
                EXISTS (
                  SELECT 1 FROM maintenance_windows w
                   WHERE w.organization_id = e.organization_id AND (w.site_id IS NULL OR w.site_id = e.site_id)
                     AND (w.target_all OR e.device_id = ANY(w.device_ids))
                     AND maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, now()) IS NOT NULL
                ) AS in_window,
                j.maintenance_only, j.state AS job_state, j.script_id, j.script_version, s.language, j.parameters,
                j.created_by, j.created_by_email, j.created_by_role, v.timeout_s,
                (r.state = 'queued' AND r.queued_at < now() - make_interval(secs => v.timeout_s + $2)) AS answer_overdue
           FROM fleet_job_results r
           JOIN fleet_job_runs ru ON ru.id = r.run_id
           JOIN fleet_jobs j ON j.id = r.job_id
           JOIN fleet_scripts s ON s.id = j.script_id
           JOIN fleet_script_versions v ON v.script_id = j.script_id AND v.version = j.script_version
           JOIN endpoints e ON e.id = r.endpoint_id
          WHERE r.state IN ('pending', 'queued')
          ORDER BY r.created_at
          LIMIT 500
          FOR UPDATE OF r SKIP LOCKED`,
        [ONLINE_WITHIN_MS / 1000, ANSWER_GRACE_S],
      )
    ).rows;
    let queued = 0;
    let expired = 0;
    let overdue = 0;
    const versions = new Map<string, Awaited<ReturnType<typeof scriptVersion>>>();
    for (const r of rows) {
      if (r.state === 'queued') {
        if (!r.answer_overdue) continue;
        // The agent took the command and never answered (it stopped, or the result was lost).
        await db.query(`UPDATE endpoint_commands SET status = 'expired', completed_at = now() WHERE id = $1 AND status IN ('pending', 'delivered')`, [r.command_id]);
        await db.query(`UPDATE fleet_job_results SET state = 'failed', finished_at = now(), error = 'No result from the agent within the script timeout' WHERE id = $1`, [r.id]);
        await auditJobEvent(db, orgId, { type: 'fleet_job', id: r.job_id }, 'fleet.job_result', { run_id: r.run_id, result_id: r.id, endpoint_id: r.endpoint_id, state: 'failed', error: 'no_answer' });
        overdue++;
        continue;
      }
      if (r.job_state === 'cancelled') {
        await db.query(`UPDATE fleet_job_results SET state = 'cancelled', waiting_for = NULL, finished_at = now() WHERE id = $1`, [r.id]);
        continue;
      }
      if (r.expired) {
        await db.query(`UPDATE fleet_job_results SET state = 'expired', finished_at = now(), error = $2 WHERE id = $1`, [
          r.id,
          r.online ? 'No maintenance window opened before the run expired' : 'The computer did not come online before the run expired',
        ]);
        await auditJobEvent(db, orgId, { type: 'fleet_job', id: r.job_id }, 'fleet.job_result', { run_id: r.run_id, result_id: r.id, endpoint_id: r.endpoint_id, state: 'expired' });
        expired++;
        continue;
      }
      const waiting = !r.online ? 'online' : r.maintenance_only && !r.in_window ? 'maintenance_window' : null;
      if (waiting) {
        await db.query(`UPDATE fleet_job_results SET waiting_for = $2 WHERE id = $1 AND waiting_for IS DISTINCT FROM $2`, [r.id, waiting]);
        continue;
      }
      // The computer's group policy at the moment the script would go out: the job creator's role
      // must be one the group allows, and the group's maximum profile must allow the shell (a script
      // runs with the agent's full rights, like the shell). Address and hours are the operator's;
      // the scheduler sends jobs on its own, and maintenance windows already decide when.
      const refused = await toolRefusal(db, orgId, r.endpoint_id, { need: 'shell', role: r.created_by_role });
      if (refused) {
        await db.query(`UPDATE fleet_job_results SET state = 'failed', waiting_for = NULL, finished_at = now(), error = $2 WHERE id = $1`, [r.id, refused.message]);
        await auditJobEvent(db, orgId, { type: 'fleet_job', id: r.job_id }, 'fleet.job_result', { run_id: r.run_id, result_id: r.id, endpoint_id: r.endpoint_id, state: 'failed', error: refused.code });
        continue;
      }
      const key = `${r.script_id}:${r.script_version}`;
      if (!versions.has(key)) versions.set(key, await scriptVersion(db, r.script_id, r.script_version));
      const v = versions.get(key)!;
      if (!v) continue;
      const payload = {
        result_id: r.id,
        job_id: r.job_id,
        language: r.language,
        body: v.body,
        body_sha256: v.body_sha256,
        params: agentParams(v.parameters as FleetScriptParam[], r.parameters),
        timeout_s: v.timeout_s,
        max_output_bytes: MAX_OUTPUT_BYTES,
      };
      const cmd = (
        await db.query<{ id: string }>(
          `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name) VALUES ($1,$2,'script_run',$3,$4,$5) RETURNING id`,
          [orgId, r.endpoint_id, JSON.stringify(payload), r.created_by, r.created_by_email],
        )
      ).rows[0]!.id;
      await db.query(`UPDATE fleet_job_results SET state = 'queued', waiting_for = NULL, command_id = $2, queued_at = now() WHERE id = $1`, [r.id, cmd]);
      await auditJobEvent(db, orgId, { type: 'endpoint', id: r.endpoint_id }, 'fleet.job_dispatched', {
        job_id: r.job_id,
        run_id: r.run_id,
        result_id: r.id,
        command_id: cmd,
        script_version: r.script_version,
        body_sha256: v.body_sha256,
      });
      queued++;
    }
    return { queued, expired, overdue };
  });
}

/** What the agent answered to `script_run` (from applyCommandResults, inside its transaction). */
export interface ScriptRunData {
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  stdout_bytes?: number;
  stderr_bytes?: number;
  capped?: boolean;
  duration_ms?: number;
  timed_out?: boolean;
  cancelled?: boolean;
}

export async function applyScriptResult(db: Db, orgId: string, endpointId: string, payload: Record<string, unknown>, ok: boolean, data: ScriptRunData | null, error: string | null): Promise<void> {
  const resultId = typeof payload.result_id === 'string' ? payload.result_id : null;
  if (!resultId) return;
  const d = data ?? {};
  const exit = Number.isInteger(d.exit_code) ? d.exit_code! : null;
  const state: FleetJobResultState = d.cancelled ? 'cancelled' : ok && exit === 0 && !d.timed_out ? 'succeeded' : 'failed';
  const stdout = typeof d.stdout === 'string' ? d.stdout : '';
  const stderr = typeof d.stderr === 'string' ? d.stderr : '';
  const err = d.timed_out ? `Stopped after the script timeout${error ? `: ${error}` : ''}` : (error ?? (state === 'failed' && exit !== null ? `Exit code ${exit}` : null));
  const updated = await db.query<{ job_id: string; run_id: string }>(
    `UPDATE fleet_job_results
        SET state = $3, exit_code = $4, stdout_preview = $5, stderr_preview = $6, stdout_bytes = $7, stderr_bytes = $8,
            output_capped = $9, duration_ms = $10, error = $11, finished_at = now()
      WHERE id = $1 AND endpoint_id = $2 AND state = 'queued'
      RETURNING job_id, run_id`,
    [
      resultId,
      endpointId,
      state,
      exit,
      stdout.slice(0, PREVIEW_CHARS),
      stderr.slice(0, PREVIEW_CHARS),
      Number.isInteger(d.stdout_bytes) ? d.stdout_bytes : Buffer.byteLength(stdout),
      Number.isInteger(d.stderr_bytes) ? d.stderr_bytes : Buffer.byteLength(stderr),
      d.capped === true,
      Number.isInteger(d.duration_ms) ? d.duration_ms : null,
      err ? err.slice(0, 2000) : null,
    ],
  );
  const row = updated.rows[0];
  if (!row) return;
  await db.query(
    `INSERT INTO fleet_job_outputs (result_id, organization_id, stdout, stderr) VALUES ($1,$2,$3,$4)
     ON CONFLICT (result_id) DO UPDATE SET stdout = EXCLUDED.stdout, stderr = EXCLUDED.stderr`,
    [resultId, orgId, stdout, stderr],
  );
  // Exit code and duration only: the output stays with the result, never in the audit.
  await auditJobEvent(db, orgId, { type: 'fleet_job', id: row.job_id }, 'fleet.job_result', {
    run_id: row.run_id,
    result_id: resultId,
    endpoint_id: endpointId,
    state,
    exit_code: exit,
    duration_ms: d.duration_ms ?? null,
    timed_out: d.timed_out === true,
  });
}

export { OPEN_STATES };
