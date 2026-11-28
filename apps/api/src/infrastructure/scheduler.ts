import type pg from 'pg';
import { lockPool } from './db.ts';
import { logger } from './logger.ts';
import type { JobDefinition } from './module.ts';

/**
 * In-process scheduler coordinated through PostgreSQL advisory locks: correct with several API
 * instances and needs no extra infrastructure. Each job is idempotent and set-based.
 * (BullMQ/Redis becomes worthwhile once jobs are per-tenant fan-out work — see docs/roadmap.)
 *
 * Fault isolation: every run is wrapped, so an exception — thrown by the job, or by acquiring its
 * connection or lock — is logged with the job's name and recorded in its health; it never stops the
 * scheduler, the job's next run, or any other job. A job that cannot be scheduled is skipped and
 * logged; the others (and the API) keep running.
 */

export interface ScheduledJob extends JobDefinition {
  /** Name of the module that owns the job. */
  readonly module: string;
}

export interface JobHealth {
  name: string;
  module: string;
  interval_seconds: number;
  /** not_scheduled: this process does not run the scheduler (or the job could not be scheduled). */
  state: 'not_scheduled' | 'idle' | 'running';
  runs: number;
  failures: number;
  consecutive_failures: number;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  /** Last time the run was skipped because another API instance held the job's lock. */
  last_skipped_at: string | null;
  last_error: { at: string; message: string } | null;
  /**
   * The job has not started (or is still running) longer than its interval × OVERDUE_GRACE_FACTOR
   * plus OVERDUE_SLACK_MS after its last start, its last lock skip, or the moment it was scheduled.
   * Always false for a job this process does not schedule.
   */
  overdue: boolean;
  /** When the job becomes overdue if it does not start (or finish, when running) before then. Null when not scheduled. */
  overdue_at: string | null;
}

/** A job is overdue once it misses this many intervals (plus OVERDUE_SLACK_MS). */
export const OVERDUE_GRACE_FACTOR = 2;
/** Extra slack so start-up delays and slow single runs of short jobs are not flagged. */
export const OVERDUE_SLACK_MS = 60_000;

interface MutableHealth {
  scheduled: boolean;
  scheduledAt: Date | null;
  running: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastSkippedAt: Date | null;
  lastError: { at: Date; message: string } | null;
}

const timers: NodeJS.Timeout[] = [];
const running = new Set<Promise<void>>();
const health = new Map<string, MutableHealth>();
/** When a run of any job last ended (finished, failed or skipped), and when startJobs ran. */
let lastProgressAt: Date | null = null;
let schedulerStartedAt: Date | null = null;

function healthOf(name: string): MutableHealth {
  let h = health.get(name);
  if (!h) {
    h = {
      scheduled: false,
      scheduledAt: null,
      running: false,
      runs: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastSkippedAt: null,
      lastError: null,
    };
    health.set(name, h);
  }
  return h;
}

/**
 * The error text kept for the health report: one line, bounded, and with any credentials of a
 * connection string removed. Stack traces and error objects stay in the server log only.
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
  return (
    raw
      .replace(/[\r\n\t]+/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\/\/[^\s/@:]+:[^\s/@]+@/g, '//[redacted]@')
      .slice(0, 300) || 'Unknown error'
  );
}

function recordFailure(job: ScheduledJob, h: MutableHealth, err: unknown): void {
  h.failures++;
  h.consecutiveFailures++;
  h.lastError = { at: new Date(), message: safeErrorMessage(err) };
  logger.error({ err, job: job.name, module: job.module }, 'background job failed');
}

/**
 * At most this many jobs run at once; the others wait in line (first come, first served). Before,
 * all ~25 jobs started within seconds of boot and competed with requests for the same connections.
 */
export const MAX_CONCURRENT_JOBS = 4;
/**
 * A run that lasts longer than this gives its slot back so one stuck job (a router that never
 * answers) cannot stop every other job. It keeps running and keeps its lock until it ends, and it is
 * not started again before then (at most RUN_DEADLINE_MS); the health report shows it as running / overdue.
 */
export const SLOT_TIMEOUT_MS = 5 * 60_000;

/**
 * Total deadline of one run (unless the job sets its own `timeoutMs`). Past it the run's signal is
 * aborted, the run is recorded as failed ("timed out"), its lock is released and the job's next run
 * starts on schedule, so a job stuck on something that never answers cannot hold its loop forever.
 * Whatever the abandoned run was still doing is left to end by itself (jobs are idempotent).
 */
export const RUN_DEADLINE_MS = 30 * 60_000;

/** The error a run that passed its deadline ends with (and the reason its signal carries). */
export class JobDeadlineError extends Error {
  constructor(job: string, ms: number) {
    super(`timed out: ${job} did not finish within ${Math.round(ms / 1000)} s`);
    this.name = 'JobDeadlineError';
  }
}

/** Runs the job with its total deadline: resolves or rejects no later than the deadline. */
async function runWithDeadline(job: ScheduledJob): Promise<void> {
  const ms = job.timeoutMs ?? RUN_DEADLINE_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const run = (async () => {
    if (SIMULATED_JOB_WAIT_MS) await new Promise((r) => setTimeout(r, SIMULATED_JOB_WAIT_MS));
    await job.run(controller.signal);
  })();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new JobDeadlineError(job.name, ms);
      logger.warn({ job: job.name, module: job.module, deadline_ms: ms }, 'background job passed its deadline; giving up on this run');
      controller.abort(err);
      reject(err);
    }, ms);
    timer.unref();
  });
  try {
    await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
    // An abandoned run that fails later must not become an unhandled rejection.
    run.catch((err: unknown) => {
      if (controller.signal.aborted) logger.warn({ err, job: job.name, module: job.module }, 'background job ended after its deadline');
    });
  }
}

/**
 * Tests only (NODE_ENV=test): every run first waits this long, as real jobs do while a router, the
 * Internet or a big table answers. On an empty test database jobs end in milliseconds and never
 * overlap, which hid the connection starvation; tests/boot.test.ts sets it.
 */
const SIMULATED_JOB_WAIT_MS = process.env.NODE_ENV === 'test' ? Number(process.env.NIGAFIY_TEST_JOB_WAIT_MS) || 0 : 0;

let freeSlots = MAX_CONCURRENT_JOBS;
const waiting: Array<() => void> = [];

/** Wait for a free slot; the returned function gives it back (only the first call counts). */
async function takeSlot(): Promise<() => void> {
  if (freeSlots > 0) freeSlots--;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  let given = false;
  return () => {
    if (given) return;
    given = true;
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next job in line
    else freeSlots++;
  };
}

/** Jobs waiting for a slot right now (for the health report). */
export function queuedJobCount(): number {
  return waiting.length;
}

/** One run of a job, single-runner across instances. Never rejects. */
export async function runJobOnce(job: ScheduledJob): Promise<void> {
  const h = healthOf(job.name);
  const giveBack = await takeSlot();
  const slotTimer = setTimeout(() => {
    logger.warn({ job: job.name, module: job.module, after_ms: SLOT_TIMEOUT_MS }, 'background job is taking long; letting other jobs run');
    giveBack();
  }, SLOT_TIMEOUT_MS);
  slotTimer.unref();
  try {
    await runLocked(job, h);
  } finally {
    clearTimeout(slotTimer);
    giveBack();
  }
}

async function runLocked(job: ScheduledJob, h: MutableHealth): Promise<void> {
  let client: pg.PoolClient | undefined;
  try {
    // Only the advisory lock lives on this connection; the job's queries use the normal pools.
    client = await lockPool.connect();
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [job.lockKey]);
    if (!lock.rows[0]?.locked) {
      h.lastSkippedAt = new Date(); // another instance is running it
      return;
    }
    h.running = true;
    h.runs++;
    h.lastStartedAt = new Date();
    try {
      await runWithDeadline(job);
      h.lastSuccessAt = new Date();
      h.consecutiveFailures = 0;
    } finally {
      h.running = false;
      h.lastFinishedAt = new Date();
      await client.query('SELECT pg_advisory_unlock($1)', [job.lockKey]);
    }
  } catch (err) {
    recordFailure(job, h, err);
  } finally {
    client?.release();
    lastProgressAt = new Date();
  }
}

function schedule(job: ScheduledJob, initialDelayMs = 1000): void {
  if (!Number.isFinite(job.everyMs) || job.everyMs < 1000) throw new Error(`invalid interval ${job.everyMs} ms`);
  if (job.timeoutMs !== undefined && (!Number.isFinite(job.timeoutMs) || job.timeoutMs <= 0)) throw new Error(`invalid deadline ${job.timeoutMs} ms`);
  let busy = false;
  const tick = () => {
    if (busy) return; // never overlap with itself
    busy = true;
    const p = runJobOnce(job).finally(() => {
      busy = false;
      running.delete(p);
    });
    running.add(p);
  };
  timers.push(setInterval(tick, job.everyMs));
  const first = setTimeout(tick, initialDelayMs);
  first.unref();
  timers.push(first);
  const h = healthOf(job.name);
  h.scheduled = true;
  h.scheduledAt = new Date();
}

export function startJobs(jobs: readonly ScheduledJob[]): void {
  schedulerStartedAt = new Date();
  for (const [index, job] of jobs.entries()) {
    try {
      schedule(job, 1000 + index * 250);
    } catch (err) {
      // One job that cannot be scheduled must not keep the others (or the API) from running.
      recordFailure(job, healthOf(job.name), err);
      logger.error({ err, job: job.name, module: job.module }, 'background job could not be scheduled');
    }
  }
}

/** Graceful shutdown: stop scheduling, then let in-flight runs finish. */
export async function stopJobs(): Promise<void> {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  schedulerStartedAt = null;
  for (const h of health.values()) {
    h.scheduled = false;
    h.scheduledAt = null;
  }
  await Promise.allSettled([...running]);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * When a job counts as overdue: a running job once its current run has lasted longer than the grace
 * window; an idle job once the grace window has passed since the last sign of life (its last start,
 * its last lock skip — another instance ran it — or the moment it was scheduled).
 */
export function overdueAt(everyMs: number, h: Pick<MutableHealth, 'scheduled' | 'running' | 'scheduledAt' | 'lastStartedAt' | 'lastSkippedAt'> | undefined): Date | null {
  if (!h || (!h.scheduled && !h.running)) return null;
  const grace = everyMs * OVERDUE_GRACE_FACTOR + OVERDUE_SLACK_MS;
  const marks = h.running ? [h.lastStartedAt] : [h.lastStartedAt, h.lastSkippedAt, h.scheduledAt];
  const last = Math.max(...marks.map((d) => d?.getTime() ?? 0));
  return last > 0 ? new Date(last + grace) : null;
}

export interface SchedulerReadiness {
  /**
   * not_running: this process does not schedule jobs (tests, a web-only instance);
   * ok; degraded: some jobs are overdue but others still finish; stalled: no run of any job has
   * ended for STALL_AFTER_MS although jobs are scheduled — the scheduler is stuck.
   */
  state: 'not_running' | 'ok' | 'degraded' | 'stalled';
  overdue_jobs: string[];
  queued: number;
  last_progress_at: string | null;
}

/** No run of any job ended for this long while jobs are scheduled = stuck (the fastest jobs run every few seconds). */
export const STALL_AFTER_MS = 3 * 60_000;

/** Is the scheduler of this process doing its work? Used by /readyz. */
export function schedulerReadiness(jobs: readonly ScheduledJob[], now: Date = new Date()): SchedulerReadiness {
  const report = jobHealth(jobs, now);
  const scheduled = report.filter((j) => j.state !== 'not_scheduled');
  const overdue = report.filter((j) => j.overdue).map((j) => j.name);
  const base = { overdue_jobs: overdue, queued: waiting.length, last_progress_at: iso(lastProgressAt) };
  if (!scheduled.length) return { state: 'not_running', ...base };
  const since = Math.max(lastProgressAt?.getTime() ?? 0, schedulerStartedAt?.getTime() ?? 0);
  if (since > 0 && now.getTime() - since > STALL_AFTER_MS) return { state: 'stalled', ...base };
  return { state: overdue.length ? 'degraded' : 'ok', ...base };
}

/** Health of the given jobs as seen by this API instance. */
export function jobHealth(jobs: readonly ScheduledJob[], now: Date = new Date()): JobHealth[] {
  return jobs.map((job) => {
    const h = health.get(job.name);
    const due = overdueAt(job.everyMs, h);
    return {
      name: job.name,
      module: job.module,
      interval_seconds: Math.round(job.everyMs / 1000),
      state: !h?.scheduled && !h?.running ? 'not_scheduled' : h.running ? 'running' : 'idle',
      runs: h?.runs ?? 0,
      failures: h?.failures ?? 0,
      consecutive_failures: h?.consecutiveFailures ?? 0,
      last_started_at: iso(h?.lastStartedAt ?? null),
      last_finished_at: iso(h?.lastFinishedAt ?? null),
      last_success_at: iso(h?.lastSuccessAt ?? null),
      last_skipped_at: iso(h?.lastSkippedAt ?? null),
      last_error: h?.lastError ? { at: h.lastError.at.toISOString(), message: h.lastError.message } : null,
      overdue: due !== null && now.getTime() > due.getTime(),
      overdue_at: iso(due),
    };
  });
}
