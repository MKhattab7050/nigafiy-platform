import { Router } from 'express';
import { z } from 'zod';
import type { CheckState, NetworkEvent, Overview } from '@lan-detective/shared-types';
import { auth, parse } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { EVENT_SELECT } from '../events/routes.ts';

export const overviewRouter: Router = Router();

const WORST: CheckState[] = ['down', 'degraded', 'ok', 'unknown'];
const worstState = (states: CheckState[]): CheckState | null => WORST.find((s) => states.includes(s)) ?? null;
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/**
 * Every number on the dashboard is computed here from stored observations.
 * When there is no data for a figure the API returns null and the UI shows an empty state.
 */
overviewRouter.get('/overview', async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ site_id: z.uuid().optional() }), req.query);
  const site = q.site_id ?? null;

  const overview = await withTenant(ctx.organizationId, async (db): Promise<Overview> => {
    const devices = await db.query<{ total: number; online: number; offline: number; unknown: number; new_24h: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'online')::int AS online,
              count(*) FILTER (WHERE status = 'offline')::int AS offline,
              count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
              count(*) FILTER (WHERE first_seen_at > now() - interval '24 hours')::int AS new_24h
         FROM devices WHERE ($1::uuid IS NULL OR site_id = $1)`,
      [site],
    );
    const collectors = await db.query<{ total: number; online: number; offline: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE connection_state = 'online')::int AS online,
              count(*) FILTER (WHERE connection_state = 'offline')::int AS offline
         FROM collectors WHERE status = 'active' AND ($1::uuid IS NULL OR site_id = $1)`,
      [site],
    );
    const checks = await db.query<{ role: string; state: CheckState }>(
      `SELECT role, state FROM monitoring_checks WHERE enabled AND ($1::uuid IS NULL OR site_id = $1)`,
      [site],
    );
    const lastHour = await db.query<{ role: string; samples: number; latency: string | null; loss: string | null }>(
      `SELECT c.role, count(*)::int AS samples, avg(r.latency_ms) FILTER (WHERE r.ok) AS latency, avg(r.loss_pct) AS loss
         FROM check_results r JOIN monitoring_checks c ON c.id = r.check_id
        WHERE r.ts > now() - interval '1 hour' AND c.enabled AND ($1::uuid IS NULL OR c.site_id = $1)
        GROUP BY c.role`,
      [site],
    );
    const availability = await db.query<{ ratio: string | null }>(
      `SELECT avg(r.ok::int) AS ratio
         FROM check_results r JOIN monitoring_checks c ON c.id = r.check_id
        WHERE r.ts > now() - interval '24 hours' AND c.role IN ('gateway', 'internet') AND ($1::uuid IS NULL OR c.site_id = $1)`,
      [site],
    );
    const criticalOffline = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM devices WHERE status = 'offline' AND is_critical AND ($1::uuid IS NULL OR site_id = $1)`,
      [site],
    );
    const events = await db.query<NetworkEvent>(
      `${EVENT_SELECT} WHERE ($1::uuid IS NULL OR e.site_id = $1) ORDER BY e.occurred_at DESC LIMIT 12`,
      [site],
    );
    const problemDevices = await db.query<Overview['problem_devices'][number]>(
      `SELECT d.id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS name,
              host(d.current_ip) AS current_ip, d.status, count(*)::int AS offline_events_7d
         FROM network_events e JOIN devices d ON d.id = e.device_id
        WHERE e.type = 'device_offline' AND e.occurred_at > now() - interval '7 days' AND ($1::uuid IS NULL OR e.site_id = $1)
        GROUP BY d.id ORDER BY count(*) DESC, d.last_seen_at LIMIT 5`,
      [site],
    );

    const byRole = (role: string) => {
      const window = lastHour.rows.find((r) => r.role === role);
      return {
        state: worstState(checks.rows.filter((c) => c.role === role).map((c) => c.state)),
        avg_latency_ms: num(window?.latency ?? null),
        avg_loss_pct: num(window?.loss ?? null),
        samples: window?.samples ?? 0,
      };
    };
    const count = (state: CheckState) => checks.rows.filter((c) => c.state === state).length;
    const dns = byRole('dns');
    const ratio = num(availability.rows[0]?.ratio ?? null);

    return {
      generated_at: new Date().toISOString(),
      devices: devices.rows[0]!,
      collectors: { total: collectors.rows[0]!.total, online: collectors.rows[0]!.online },
      checks: { total: checks.rows.length, ok: count('ok'), degraded: count('degraded'), down: count('down'), unknown: count('unknown') },
      internet: byRole('internet'),
      gateway: byRole('gateway'),
      dns: { state: dns.state, avg_latency_ms: dns.avg_latency_ms, samples: dns.samples },
      availability_24h_pct: ratio === null ? null : Math.round(ratio * 10_000) / 100,
      open_problems: count('down') + count('degraded') + criticalOffline.rows[0]!.n + collectors.rows[0]!.offline,
      recent_events: events.rows,
      problem_devices: problemDevices.rows,
    };
  });
  res.json(overview);
});
