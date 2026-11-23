import { Router } from 'express';
import { z } from 'zod';
import type { CheckRole, CheckState, Comparison, Incident, NetworkEvent, PeriodStats, Snapshot, SnapshotDevice } from '@nigafiy/shared-types';
import { AppError, auth, parse } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { EVENT_SELECT } from '../events/index.ts';
import { INCIDENT_SELECT } from '../incidents/index.ts';

/**
 * Network Time Machine — reconstructs past state from what was recorded at the time:
 * availability intervals, IP history, check samples / hourly roll-ups, events and incidents.
 * Nothing is interpolated: where no record exists the answer is "unknown".
 */
export const timeMachineRouter: Router = Router();

const timestamp = z.iso.datetime({ offset: true });
const RAW_WINDOW_DAYS = 25; // older periods are answered from hourly roll-ups
const MAX_PERIOD_MS = 92 * 86_400_000;

const DEVICE_AT = `
  SELECT d.id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS name,
         coalesce((SELECT host(h.ip) FROM device_ip_history h WHERE h.device_id = d.id AND h.first_seen_at <= $1 ORDER BY h.first_seen_at DESC LIMIT 1),
                  host(d.current_ip)) AS ip,
         d.primary_mac::text AS mac, d.device_type, d.first_seen_at`;

timeMachineRouter.get('/time-machine/snapshot', async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ at: timestamp, site_id: z.uuid().optional() }), req.query);
  const at = new Date(q.at);
  if (at.getTime() > Date.now() + 60_000) throw new AppError(400, 'invalid_time', 'The Time Machine only goes backwards');
  const site = q.site_id ?? null;

  const snapshot = await withTenant(ctx.organizationId, async (db): Promise<Snapshot> => {
    const devices = await db.query<SnapshotDevice>(
      `${DEVICE_AT},
         coalesce((SELECT a.status FROM availability_history a
                    WHERE a.device_id = d.id AND a.started_at <= $1 AND (a.ended_at IS NULL OR a.ended_at > $1)
                    ORDER BY a.started_at DESC LIMIT 1), 'unknown') AS status
         FROM devices d
        WHERE d.first_seen_at <= $1 AND ($2::uuid IS NULL OR d.site_id = $2)
        ORDER BY d.current_ip NULLS LAST LIMIT 2000`,
      [at, site],
    );
    const checks = await db.query<{ id: string; name: string; role: CheckRole; transition: string | null; samples: number; latency: number | null; loss: number | null }>(
      `SELECT c.id, c.name, c.role,
              (SELECT e.type FROM network_events e
                WHERE e.check_id = c.id AND e.type IN ('check_down', 'check_degraded', 'check_recovered') AND e.occurred_at <= $1
                ORDER BY e.occurred_at DESC LIMIT 1) AS transition,
              coalesce(w.samples, 0)::int AS samples, w.latency::float8 AS latency, w.loss::float8 AS loss
         FROM monitoring_checks c
         LEFT JOIN LATERAL (
           SELECT count(*) AS samples, avg(latency_ms) FILTER (WHERE ok) AS latency, avg(loss_pct) AS loss
             FROM check_results WHERE check_id = c.id AND ts > $1::timestamptz - interval '10 minutes' AND ts <= $1) w ON true
        WHERE c.created_at <= $1 AND ($2::uuid IS NULL OR c.site_id = $2)
        ORDER BY array_position(ARRAY['gateway','internet','dns','service'], c.role), c.name`,
      [at, site],
    );
    const incidents = await db.query<Incident>(
      `${INCIDENT_SELECT} WHERE i.opened_at <= $1 AND (i.resolved_at IS NULL OR i.resolved_at > $1) AND ($2::uuid IS NULL OR i.site_id = $2) ORDER BY i.opened_at`,
      [at, site],
    );
    const events = await db.query<NetworkEvent>(
      `${EVENT_SELECT} WHERE e.occurred_at BETWEEN $1::timestamptz - interval '30 minutes' AND $1::timestamptz + interval '30 minutes'
          AND ($2::uuid IS NULL OR e.site_id = $2) ORDER BY e.occurred_at, e.id LIMIT 200`,
      [at, site],
    );
    const count = (s: string) => devices.rows.filter((d) => d.status === s).length;
    const stateOf = (c: (typeof checks.rows)[number]): CheckState =>
      c.transition === 'check_down' ? 'down' : c.transition === 'check_degraded' ? 'degraded' : c.transition === 'check_recovered' || c.samples > 0 ? 'ok' : 'unknown';
    return {
      at: at.toISOString(),
      devices: { total: devices.rows.length, online: count('online'), offline: count('offline'), unknown: count('unknown'), items: devices.rows },
      checks: checks.rows.map((c) => ({ id: c.id, name: c.name, role: c.role, state: stateOf(c), latency_ms: c.latency, loss_pct: c.loss, samples: c.samples })),
      incidents: incidents.rows,
      events: events.rows,
      method: [
        'Device status: the recorded availability interval that contains this moment (no interval → unknown).',
        'Device IP: the most recent address first seen on or before this moment.',
        'Check state: the last recorded state transition before this moment; latency and loss are the average of the 10 minutes before it.',
        'Incidents: those opened before and not yet resolved at this moment. Events: ±30 minutes.',
      ],
    };
  });
  res.json(snapshot);
});

async function periodStats(db: Db, from: Date, to: Date, site: string | null): Promise<PeriodStats> {
  const devices = await db.query<{ seen: number; fresh: number }>(
    `SELECT (SELECT count(DISTINCT a.device_id) FROM availability_history a JOIN devices d ON d.id = a.device_id
              WHERE a.status = 'online' AND a.started_at < $2 AND coalesce(a.ended_at, now()) > $1 AND ($3::uuid IS NULL OR d.site_id = $3))::int AS seen,
            (SELECT count(*) FROM devices d WHERE d.first_seen_at >= $1 AND d.first_seen_at < $2 AND ($3::uuid IS NULL OR d.site_id = $3))::int AS fresh`,
    [from, to, site],
  );
  const incidents = await db.query<{ n: number; minutes: number }>(
    `SELECT count(*)::int AS n,
            coalesce(sum(extract(epoch FROM (least(coalesce(resolved_at, now()), $2) - greatest(opened_at, $1))) / 60), 0)::float8 AS minutes
       FROM incidents WHERE opened_at < $2 AND coalesce(resolved_at, now()) > $1 AND ($3::uuid IS NULL OR site_id = $3)`,
    [from, to, site],
  );
  const events = await db.query<{ type: string; n: number }>(
    `SELECT type, count(*)::int AS n FROM network_events WHERE occurred_at >= $1 AND occurred_at < $2 AND ($3::uuid IS NULL OR site_id = $3) GROUP BY type`,
    [from, to, site],
  );
  const useRaw = from.getTime() > Date.now() - RAW_WINDOW_DAYS * 86_400_000;
  const checks = await db.query<{ role: CheckRole; samples: number; ok: number; latency: number | null; loss: number | null }>(
    useRaw
      ? `SELECT c.role, count(*)::int AS samples, count(*) FILTER (WHERE r.ok)::int AS ok,
                (avg(r.latency_ms) FILTER (WHERE r.ok))::float8 AS latency, avg(r.loss_pct)::float8 AS loss
           FROM check_results r JOIN monitoring_checks c ON c.id = r.check_id
          WHERE r.ts >= $1 AND r.ts < $2 AND ($3::uuid IS NULL OR c.site_id = $3) GROUP BY c.role`
      : `SELECT c.role, sum(h.samples)::int AS samples, sum(h.ok_samples)::int AS ok,
                (sum(h.latency_avg * h.ok_samples) / nullif(sum(h.ok_samples) FILTER (WHERE h.latency_avg IS NOT NULL), 0))::float8 AS latency,
                (sum(h.loss_avg * h.samples) / nullif(sum(h.samples) FILTER (WHERE h.loss_avg IS NOT NULL), 0))::float8 AS loss
           FROM check_results_hourly h JOIN monitoring_checks c ON c.id = h.check_id
          WHERE h.bucket >= $1 AND h.bucket < $2 AND ($3::uuid IS NULL OR c.site_id = $3) GROUP BY c.role`,
    [from, to, site],
  );
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    devices_seen: devices.rows[0]!.seen,
    new_devices: devices.rows[0]!.fresh,
    incidents: incidents.rows[0]!.n,
    incident_minutes: Math.round(incidents.rows[0]!.minutes),
    events: Object.fromEntries(events.rows.map((e) => [e.type, e.n])),
    checks: (['gateway', 'internet', 'dns', 'service'] as const).flatMap((role) => {
      const row = checks.rows.find((c) => c.role === role);
      return row ? [{ role, samples: row.samples, availability_pct: row.samples ? Math.round((row.ok / row.samples) * 10_000) / 100 : null, latency_ms: row.latency, loss_pct: row.loss }] : [];
    }),
  };
}

/** Devices that were online at some point in period X but never in period Y. */
function onlyIn(db: Db, x: [Date, Date], y: [Date, Date], site: string | null) {
  return db.query<SnapshotDevice>(
    `${DEVICE_AT.replace('$1', '$2')}, d.status
       FROM devices d
      WHERE ($5::uuid IS NULL OR d.site_id = $5)
        AND EXISTS (SELECT 1 FROM availability_history a WHERE a.device_id = d.id AND a.status = 'online' AND a.started_at < $2 AND coalesce(a.ended_at, now()) > $1)
        AND NOT EXISTS (SELECT 1 FROM availability_history a WHERE a.device_id = d.id AND a.status = 'online' AND a.started_at < $4 AND coalesce(a.ended_at, now()) > $3)
      ORDER BY d.current_ip NULLS LAST LIMIT 200`,
    [x[0], x[1], y[0], y[1], site],
  );
}

timeMachineRouter.get('/time-machine/compare', async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ a_from: timestamp, a_to: timestamp, b_from: timestamp, b_to: timestamp, site_id: z.uuid().optional() }), req.query);
  const a: [Date, Date] = [new Date(q.a_from), new Date(q.a_to)];
  const b: [Date, Date] = [new Date(q.b_from), new Date(q.b_to)];
  for (const [from, to] of [a, b]) {
    if (to <= from) throw new AppError(400, 'invalid_range', 'Each period must end after it starts');
    if (to.getTime() - from.getTime() > MAX_PERIOD_MS) throw new AppError(400, 'invalid_range', 'A period can be at most 92 days');
  }
  const site = q.site_id ?? null;
  const comparison = await withTenant(ctx.organizationId, async (db): Promise<Comparison> => {
    const incidentsIn = (p: [Date, Date]) =>
      db.query<Incident>(`${INCIDENT_SELECT} WHERE i.opened_at < $2 AND coalesce(i.resolved_at, now()) > $1 AND ($3::uuid IS NULL OR i.site_id = $3) ORDER BY i.opened_at LIMIT 50`, [p[0], p[1], site]);
    return {
      a: await periodStats(db, a[0], a[1], site),
      b: await periodStats(db, b[0], b[1], site),
      devices_only_in_a: (await onlyIn(db, a, b, site)).rows,
      devices_only_in_b: (await onlyIn(db, b, a, site)).rows,
      incidents_a: (await incidentsIn(a)).rows,
      incidents_b: (await incidentsIn(b)).rows,
    };
  });
  res.json(comparison);
});
