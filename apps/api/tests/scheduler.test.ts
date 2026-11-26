import { afterAll, describe, expect, it } from 'vitest';
import { lockPool, systemPool } from '../src/infrastructure/db.ts';
import { MAX_CONCURRENT_JOBS, queuedJobCount, runJobOnce, type ScheduledJob, schedulerReadiness, STALL_AFTER_MS, startJobs, stopJobs } from '../src/infrastructure/scheduler.ts';

const job = (n: number, run: () => Promise<void>): ScheduledJob => ({ name: `sched-test-${n}`, module: 'test', everyMs: 3_600_000, lockKey: 991_000 + n, run });

describe('scheduler and database connections', () => {
  afterAll(async () => {
    await stopJobs();
  });

  it(`runs at most ${MAX_CONCURRENT_JOBS} jobs at once and queues the rest`, async () => {
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const jobs = Array.from({ length: 10 }, (_, i) =>
      job(i, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active--;
      }),
    );
    const runs = jobs.map((j) => runJobOnce(j));
    await waitFor(() => gates.length === MAX_CONCURRENT_JOBS);
    expect(queuedJobCount()).toBe(10 - MAX_CONCURRENT_JOBS);
    // Release them one by one; each freed slot goes to the next job in line.
    while (gates.length || queuedJobCount()) {
      await waitFor(() => gates.length > 0);
      gates.shift()!();
    }
    await Promise.all(runs);
    expect(peak).toBe(MAX_CONCURRENT_JOBS);
  });

  it('a running job does not hold a systemPool connection: requests still get one', async () => {
    const release: Array<() => void> = [];
    const runs = Array.from({ length: MAX_CONCURRENT_JOBS }, (_, i) =>
      runJobOnce(
        job(20 + i, async () => {
          await systemPool.query('SELECT 1'); // the job's own work uses the normal pool, briefly
          await new Promise<void>((resolve) => release.push(resolve));
        }),
      ),
    );
    await waitFor(() => release.length === MAX_CONCURRENT_JOBS);
    // Every running job's lock sits on lockPool; systemPool is free for everyone else.
    expect(lockPool.totalCount).toBeGreaterThanOrEqual(MAX_CONCURRENT_JOBS);
    const started = performance.now();
    await Promise.all(Array.from({ length: 12 }, () => systemPool.query('SELECT 1')));
    expect(performance.now() - started).toBeLessThan(2000);
    for (const r of release) r();
    await Promise.all(runs);
  });

  it('reports a stalled scheduler only when no run ends for a long time', async () => {
    expect(schedulerReadiness([]).state).toBe('not_running');
    const idle = job(40, async () => {});
    startJobs([idle]);
    await runJobOnce(idle);
    expect(schedulerReadiness([idle]).state).toBe('ok');
    const later = new Date(Date.now() + STALL_AFTER_MS + 1000);
    expect(schedulerReadiness([idle], later).state).toBe('stalled');
    await stopJobs();
    expect(schedulerReadiness([idle]).state).toBe('not_running');
  });
});

async function waitFor(ok: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
