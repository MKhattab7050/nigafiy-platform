import type pg from 'pg';
import { systemPool } from './db.ts';
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
}

interface MutableHealth {
  scheduled: boolean;
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

function healthOf(name: string): MutableHealth {
  let h = health.get(name);
  if (!h) {
    h = {
      scheduled: false,
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

/** One run of a job, single-runner across instances. Never rejects. */
export async function runJobOnce(job: ScheduledJob): Promise<void> {
  const h = healthOf(job.name);
  let client: pg.PoolClient | undefined;
  try {
    client = await systemPool.connect();
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [job.lockKey]);
    if (!lock.rows[0]?.locked) {
      h.lastSkippedAt = new Date(); // another instance is running it
      return;
    }
    h.running = true;
    h.runs++;
    h.lastStartedAt = new Date();
    try {
      await job.run();
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
  }
}

function schedule(job: ScheduledJob, initialDelayMs = 1000): void {
  if (!Number.isFinite(job.everyMs) || job.everyMs < 1000) throw new Error(`invalid interval ${job.everyMs} ms`);
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
  healthOf(job.name).scheduled = true;
}

export function startJobs(jobs: readonly ScheduledJob[]): void {
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
  for (const h of health.values()) h.scheduled = false;
  await Promise.allSettled([...running]);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Health of the given jobs as seen by this API instance. */
export function jobHealth(jobs: readonly ScheduledJob[]): JobHealth[] {
  return jobs.map((job) => {
    const h = health.get(job.name);
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
    };
  });
}
