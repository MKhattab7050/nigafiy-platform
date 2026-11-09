import { systemPool } from '../infrastructure/db.ts';
import { logger } from '../infrastructure/logger.ts';
import { watchCollectors } from './collector-watch.ts';
import { dispatchNotifications } from './notification-dispatch.ts';
import { applyRetention } from './retention.ts';

interface Job {
  name: string;
  everyMs: number;
  /** Stable key for the PostgreSQL advisory lock that makes the job single-runner across API instances. */
  lockKey: number;
  run: () => Promise<void>;
}

// In-process scheduler coordinated through PostgreSQL advisory locks: correct with several API
// instances and needs no extra infrastructure. Each job is idempotent and set-based.
// (BullMQ/Redis becomes worthwhile once jobs are per-tenant fan-out work — see docs/roadmap.)
const JOBS: Job[] = [
  { name: 'collector-watch', everyMs: 15_000, lockKey: 727101, run: watchCollectors },
  { name: 'notification-dispatch', everyMs: 5_000, lockKey: 727102, run: dispatchNotifications },
  { name: 'retention', everyMs: 3600_000, lockKey: 727103, run: applyRetention },
];

const timers: NodeJS.Timeout[] = [];
const running = new Set<Promise<void>>();

async function runExclusive(job: Job): Promise<void> {
  const client = await systemPool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [job.lockKey]);
    if (!lock.rows[0]?.locked) return; // another instance is running it
    try {
      await job.run();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [job.lockKey]);
    }
  } catch (err) {
    logger.error({ err, job: job.name }, 'background job failed');
  } finally {
    client.release();
  }
}

export function startJobs(): void {
  for (const job of JOBS) {
    let busy = false;
    const tick = () => {
      if (busy) return; // never overlap with itself
      busy = true;
      const p = runExclusive(job).finally(() => {
        busy = false;
        running.delete(p);
      });
      running.add(p);
    };
    timers.push(setInterval(tick, job.everyMs));
    setTimeout(tick, 1000).unref();
  }
}

/** Graceful shutdown: stop scheduling, then let in-flight runs finish. */
export async function stopJobs(): Promise<void> {
  for (const t of timers) clearInterval(t);
  await Promise.allSettled([...running]);
}
