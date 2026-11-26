import type { JobHealth } from '../../infrastructure/scheduler.ts';
import type { ReportLine, SchedulerState, SystemHealthReport } from '@nigafiy/shared-types';
import { withTenant } from '../../infrastructure/db.ts';

/**
 * GET /system/health: the answers a user wants about Nigafiy itself, in facts the web words as plain
 * sentences. Derived from the scheduler's own job health (the same data as GET /system/modules), the
 * organization's Sensors, the recorded monitoring gaps and the optional outside heartbeat.
 *
 * Read-only and cheap: one tenant transaction with a handful of small queries.
 */

const line = (code: string, params: ReportLine['params'], text: string): ReportLine => ({ code, params, text });

/** A job counts as late once the scheduler flags it overdue; failing = its last runs failed (and it is not late). */
export function schedulerSummary(jobs: readonly JobHealth[]): SystemHealthReport['scheduler'] {
  const scheduled = jobs.filter((j) => j.state !== 'not_scheduled');
  const late = scheduled.filter((j) => j.overdue).map((j) => ({ name: j.name, module: j.module, since: j.overdue_at ?? j.last_started_at ?? new Date().toISOString() }));
  const failing = scheduled
    .filter((j) => !j.overdue && j.consecutive_failures > 0 && j.last_error)
    .map((j) => ({ name: j.name, module: j.module, failures: j.consecutive_failures, last_success_at: j.last_success_at, last_error_at: j.last_error!.at, message: j.last_error!.message }));
  let state: SchedulerState;
  if (!scheduled.length) state = 'not_running';
  else if (late.length && late.length * 2 >= scheduled.length) state = 'stalled';
  else if (late.length || failing.length) state = 'degraded';
  else state = 'ok';
  return { state, jobs: scheduled.length, late, failing };
}

/** What needs the user, most important first. Kept short: only what they can act on. */
export function healthActions(r: Omit<SystemHealthReport, 'actions' | 'checked_at'>): ReportLine[] {
  const out: ReportLine[] = [];
  if (!r.database.reachable) out.push(line('database_unreachable', {}, 'The database does not answer. Restart Nigafiy.'));
  if (r.scheduler.state === 'stalled' || r.scheduler.state === 'not_running') {
    out.push(line('scheduler_stopped', {}, 'Background work has stopped, so nothing is being checked. Restart Nigafiy.'));
  } else if (r.scheduler.late.length || r.scheduler.failing.length) {
    // A single failing job usually recovers by itself; say so only when it keeps failing.
    const stuck = r.scheduler.late.length + r.scheduler.failing.filter((f) => f.failures >= 3).length;
    if (stuck) out.push(line('jobs_stuck', { n: stuck }, `${stuck} background task${stuck === 1 ? ' is' : 's are'} late or keep failing. If it lasts, restart Nigafiy.`));
  }
  if (!r.monitoring.sensors.length) out.push(line('no_sensor', {}, 'No Sensor is set up yet, so nothing on your network is watched.'));
  else if (!r.monitoring.active) {
    const s = r.monitoring.sensors.find((x) => x.state === 'offline') ?? r.monitoring.sensors[0]!;
    out.push(line('sensor_offline', { name: s.name, since: s.last_heartbeat_at ?? '' }, `The Sensor "${s.name}" is not reporting. Check that its computer is on and connected.`));
  }
  if (r.outside_heartbeat.configured && r.outside_heartbeat.ok === false) {
    out.push(line('heartbeat_failing', {}, 'The outside check does not get its pings. Check the address in "Tell me if Nigafiy itself stops".'));
  }
  return out;
}

const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

export async function systemHealth(organizationId: string, jobs: readonly JobHealth[], version: string | null, now = new Date()): Promise<SystemHealthReport> {
  let database: SystemHealthReport['database'] = { reachable: false, latency_ms: null };
  let monitoring: SystemHealthReport['monitoring'] = { active: false, sensors: [], last_gap: null };
  let outside: SystemHealthReport['outside_heartbeat'] = { configured: false, ok: null, last_ping_at: null };
  let instant = 0;
  try {
    const t0 = performance.now();
    await withTenant(organizationId, async (db) => {
      await db.query('SELECT 1');
      database = { reachable: true, latency_ms: Math.round(performance.now() - t0) };
      const sensors = await db.query<{ id: string; name: string; connection_state: 'never' | 'online' | 'offline'; last_heartbeat_at: Date | null }>(
        `SELECT id, name, connection_state, last_heartbeat_at FROM collectors WHERE status = 'active' ORDER BY name`,
      );
      const gap = await db.query<{ kind: 'api' | 'collector'; started_at: Date; ended_at: Date }>(
        `SELECT kind, started_at, ended_at FROM monitoring_gaps ORDER BY ended_at DESC, (kind = 'api') DESC LIMIT 1`,
      );
      const hb = await db.query<{ last_ping_at: Date | null; last_error: string | null }>(`SELECT last_ping_at, last_error FROM monitor_heartbeat LIMIT 1`);
      const ch = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_channels WHERE enabled AND kind IN ('telegram', 'ntfy')`);
      const g = gap.rows[0];
      monitoring = {
        active: sensors.rows.some((s) => s.connection_state === 'online'),
        sensors: sensors.rows.map((s) => ({ id: s.id, name: s.name, state: s.connection_state, last_heartbeat_at: s.last_heartbeat_at?.toISOString() ?? null })),
        last_gap: g
          ? { kind: g.kind, started_at: g.started_at.toISOString(), ended_at: g.ended_at.toISOString(), duration_seconds: Math.round((g.ended_at.getTime() - g.started_at.getTime()) / 1000) }
          : null,
      };
      const h = hb.rows[0];
      outside = h ? { configured: true, ok: h.last_ping_at ? !h.last_error : null, last_ping_at: h.last_ping_at?.toISOString() ?? null } : outside;
      instant = ch.rows[0]?.n ?? 0;
    });
  } catch {
    database = { reachable: false, latency_ms: null };
  }
  const base = {
    api: { running: true as const, started_at: STARTED_AT.toISOString(), version },
    database,
    scheduler: schedulerSummary(jobs),
    monitoring,
    outside_heartbeat: outside,
    instant_channels: instant,
  };
  return { checked_at: now.toISOString(), ...base, actions: healthActions(base) };
}
