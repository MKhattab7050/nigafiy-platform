import { systemPool } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';

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
  await systemPool.query(
    `DELETE FROM check_results_hourly h USING organizations o
      WHERE o.id = h.organization_id AND h.bucket < now() - make_interval(days => o.rollup_retention_days)`,
  );
  await systemPool.query(
    `DELETE FROM dns_stats s USING organizations o
      WHERE o.id = s.organization_id AND s.window_end < now() - make_interval(days => least(o.metric_retention_days, 30))`,
  );
  await systemPool.query(
    `DELETE FROM switch_port_samples s USING organizations o
      WHERE o.id = s.organization_id AND s.ts < now() - make_interval(days => o.metric_retention_days)`,
  );
  await systemPool.query(
    `DELETE FROM toolbox_runs r USING organizations o
      WHERE o.id = r.organization_id AND r.created_at < now() - make_interval(days => least(o.metric_retention_days, 30))`,
  );
  await systemPool.query(
    `DELETE FROM endpoint_samples s USING organizations o
      WHERE o.id = s.organization_id AND s.ts < now() - make_interval(days => o.metric_retention_days)`,
  );
  await systemPool.query(
    `DELETE FROM endpoint_commands c USING organizations o
      WHERE o.id = c.organization_id AND c.created_at < now() - make_interval(days => o.event_retention_days)`,
  );
  await systemPool.query(
    `DELETE FROM endpoint_commands WHERE kind IN ('rd_capture', 'rd_input') AND created_at < now() - interval '5 minutes'`,
  );
  await systemPool.query(
    `DELETE FROM router_requests r USING organizations o
      WHERE o.id = r.organization_id AND r.created_at < now() - make_interval(days => o.event_retention_days)`,
  );
  await systemPool.query(
    `DELETE FROM maintenance_runs r USING organizations o
      WHERE o.id = r.organization_id AND r.ended_at IS NOT NULL AND r.ended_at < now() - make_interval(days => o.event_retention_days)`,
  );
  await systemPool.query(`DELETE FROM ingest_batches WHERE received_at < now() - interval '14 days'`);
  await systemPool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await systemPool.query(`DELETE FROM auth_tokens WHERE expires_at < now() OR (used_at IS NOT NULL AND used_at < now() - interval '1 day')`);
  if ((metrics.rowCount ?? 0) + (runs.rowCount ?? 0) + (events.rowCount ?? 0) > 0) {
    logger.info({ check_results: metrics.rowCount, discovery_runs: runs.rowCount, events: events.rowCount }, 'retention applied');
  }
}
