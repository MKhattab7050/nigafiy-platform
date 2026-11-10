import { systemPool } from '../infrastructure/db.ts';

/**
 * Maintain hourly aggregates of check_results. Recomputes the last 48 hours on every run, so
 * samples that arrive late (uploaded from a collector's buffer after an outage) are included.
 * Idempotent: running it twice gives the same rows.
 */
export async function rollupCheckResults(): Promise<void> {
  await systemPool.query(
    `INSERT INTO check_results_hourly (check_id, bucket, organization_id, samples, ok_samples, latency_avg, latency_max, loss_avg, jitter_avg)
     SELECT check_id, date_trunc('hour', ts), organization_id, count(*), count(*) FILTER (WHERE ok),
            avg(latency_ms) FILTER (WHERE ok), max(latency_ms) FILTER (WHERE ok), avg(loss_pct), avg(jitter_ms) FILTER (WHERE ok)
       FROM check_results
      WHERE ts >= date_trunc('hour', now()) - interval '48 hours'
      GROUP BY check_id, date_trunc('hour', ts), organization_id
     ON CONFLICT (check_id, bucket) DO UPDATE
       SET samples = EXCLUDED.samples, ok_samples = EXCLUDED.ok_samples, latency_avg = EXCLUDED.latency_avg,
           latency_max = EXCLUDED.latency_max, loss_avg = EXCLUDED.loss_avg, jitter_avg = EXCLUDED.jitter_avg`,
  );
}
