import { systemPool } from '../infrastructure/db.ts';
import { logger } from '../infrastructure/logger.ts';

/** Enforce each organization's configured retention. Set-based, safe to re-run at any time. */
export async function applyRetention(): Promise<void> {
  const metrics = await systemPool.query(
    `DELETE FROM check_results r USING organizations o
      WHERE o.id = r.organization_id AND r.ts < now() - make_interval(days => o.metric_retention_days)`,
  );
  const runs = await systemPool.query(
    `DELETE FROM discovery_runs r USING organizations o
      WHERE o.id = r.organization_id AND r.finished_at < now() - make_interval(days => o.metric_retention_days)`,
  );
  const events = await systemPool.query(
    `DELETE FROM network_events e USING organizations o
      WHERE o.id = e.organization_id AND e.occurred_at < now() - make_interval(days => o.event_retention_days)`,
  );
  await systemPool.query(`DELETE FROM ingest_batches WHERE received_at < now() - interval '14 days'`);
  await systemPool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  if ((metrics.rowCount ?? 0) + (runs.rowCount ?? 0) + (events.rowCount ?? 0) > 0) {
    logger.info({ check_results: metrics.rowCount, discovery_runs: runs.rowCount, events: events.rowCount }, 'retention applied');
  }
}
