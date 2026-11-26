import type { Db } from '../../infrastructure/db.ts';
import { withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';

/**
 * Honest history when monitoring itself was off (UX review item 2).
 *
 * On an installed copy the database, the API and the Sensor all run on one PC. When that PC is off
 * (or asleep) nothing records anything, and the old history simply ran on across the gap: a device
 * that was "online" stayed online for the whole night, one that was "offline" was down all night.
 * Here such periods are recorded in `monitoring_gaps`, device history reads them as "the monitor
 * was off" (devices/routes.ts), and one calm notice says when it happened.
 *
 *  - kind 'api': the Nigafiy server was not running. The running API touches `monitor_alive`
 *    every ALIVE_TICK_MS; on start a silence longer than GAP_MIN_SECONDS is a gap for every
 *    organization that has a Sensor.
 *  - kind 'collector': a Sensor's heartbeats stopped for longer than GAP_MIN_SECONDS and resumed
 *    (ingest/heartbeat.ts). Its site only.
 */

/** The API marks itself alive this often. */
export const ALIVE_TICK_MS = 30_000;
/** Shorter silences (a quick restart, six missed 30-second heartbeats) are not recorded. */
export const GAP_MIN_SECONDS = 180;

/**
 * Until this moment the collector watch does not declare Sensors lost: right after the API starts,
 * Sensors have not had a chance to send a heartbeat yet. Set only by the API start-up (main.ts →
 * collectors lifecycle), so tests and other callers are unaffected.
 */
let collectorWatchGraceUntil = 0;
export const collectorWatchInGrace = (now = Date.now()): boolean => now < collectorWatchGraceUntil;
export function startCollectorWatchGrace(seconds: number, now = Date.now()): void {
  collectorWatchGraceUntil = now + seconds * 1000;
}

export interface MonitorGap {
  organization_id: string;
  started_at: Date;
  ended_at: Date;
}

/** Mark the API alive now (the scheduled `monitor-alive` job). */
export async function recordAliveTick(now: Date = new Date()): Promise<void> {
  await withSystem((db) =>
    db.query(
      `INSERT INTO monitor_alive (id, last_alive_at) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET last_alive_at = greatest(monitor_alive.last_alive_at, EXCLUDED.last_alive_at)`,
      [now],
    ),
  );
}

const durationText = (seconds: number): string => {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
};

/** The one notice per gap: an info event on the timeline (calm; channels with min severity "info" get it too). */
async function emitGapNotice(db: Db, organizationId: string, gap: { kind: 'api' | 'collector'; siteId: string | null; collectorId: string | null; collectorName?: string; from: Date; to: Date }): Promise<void> {
  const seconds = Math.round((gap.to.getTime() - gap.from.getTime()) / 1000);
  await emitEvent(db, organizationId, {
    siteId: gap.siteId,
    collectorId: gap.collectorId,
    type: 'monitoring_off',
    severity: 'info',
    title: `Monitoring was off for ${durationText(seconds)}`,
    details: {
      off_from: gap.from.toISOString(),
      off_until: gap.to.toISOString(),
      duration_seconds: seconds,
      kind: gap.kind,
      ...(gap.collectorName ? { collector: gap.collectorName } : {}),
      what_was_off: gap.kind === 'api' ? 'The Nigafiy server (database, API and Sensor run on this computer)' : 'The Sensor sent no heartbeats',
      possible_causes:
        gap.kind === 'api'
          ? ['The computer was off, asleep or restarting', 'Nigafiy was closed']
          : ['The Sensor computer was off, asleep or restarting', 'The Sensor was stopped', 'The Sensor could not reach the server'],
      history: 'Device history for this period is shown as "monitoring off", not as down or up.',
    },
    source: 'platform',
    occurredAt: gap.to,
  });
}

/**
 * Run once when the API starts: if the last alive tick is older than GAP_MIN_SECONDS, record a gap
 * from that tick until now for every organization with an enrolled Sensor, with one notice each.
 * Then marks the API alive. Returns the gaps recorded.
 */
export async function detectRestartGap(now: Date = new Date()): Promise<MonitorGap[]> {
  return withSystem(async (db) => {
    // Lock the row so two API instances starting together record the gap once.
    const prev = await db.query<{ last_alive_at: Date }>(`SELECT last_alive_at FROM monitor_alive WHERE id = 1 FOR UPDATE`);
    await db.query(
      `INSERT INTO monitor_alive (id, last_alive_at) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET last_alive_at = greatest(monitor_alive.last_alive_at, EXCLUDED.last_alive_at)`,
      [now],
    );
    const last = prev.rows[0]?.last_alive_at;
    // First start ever (no row): nothing was being monitored before, so there is no gap.
    if (!last || now.getTime() - last.getTime() <= GAP_MIN_SECONDS * 1000) return [];

    const orgs = await db.query<{ organization_id: string }>(
      `SELECT DISTINCT organization_id FROM collectors
        WHERE status = 'active' AND last_heartbeat_at IS NOT NULL AND created_at < $1`,
      [last],
    );
    const gaps: MonitorGap[] = [];
    for (const { organization_id } of orgs.rows) {
      await db.query(`INSERT INTO monitoring_gaps (organization_id, kind, started_at, ended_at) VALUES ($1, 'api', $2, $3)`, [organization_id, last, now]);
      await emitGapNotice(db, organization_id, { kind: 'api', siteId: null, collectorId: null, from: last, to: now });
      await notifyRealtime(db, organization_id, 'devices');
      gaps.push({ organization_id, started_at: last, ended_at: now });
    }
    if (gaps.length) logger.info({ off_from: last.toISOString(), off_until: now.toISOString(), organizations: gaps.length }, 'monitoring was off; gap recorded');
    return gaps;
  });
}

/**
 * Called from a Sensor heartbeat (inside its tenant transaction) with the previous heartbeat time.
 * Records a collector gap when the silence was longer than GAP_MIN_SECONDS. The notice is sent only
 * when nothing else said it already: not when the server itself was off over the same period (the
 * 'api' gap has its notice), and not when the collector watch already reported the Sensor lost
 * (`collector_offline` / `collector_online` tell that story).
 */
export async function recordCollectorGap(
  db: Db,
  c: { id: string; organizationId: string; siteId: string; name: string; connectionState: 'never' | 'online' | 'offline' },
  previousHeartbeat: Date | null,
  now: Date,
): Promise<boolean> {
  if (!previousHeartbeat || now.getTime() - previousHeartbeat.getTime() <= GAP_MIN_SECONDS * 1000) return false;
  await db.query(
    `INSERT INTO monitoring_gaps (organization_id, site_id, collector_id, kind, started_at, ended_at) VALUES ($1, $2, $3, 'collector', $4, $5)`,
    [c.organizationId, c.siteId, c.id, previousHeartbeat, now],
  );
  if (c.connectionState !== 'online') return true;
  const coveredByApiGap = await db.query(
    `SELECT 1 FROM monitoring_gaps WHERE organization_id = $1 AND kind = 'api' AND started_at < $3 AND ended_at > $2 LIMIT 1`,
    [c.organizationId, previousHeartbeat, now],
  );
  if (!coveredByApiGap.rowCount) {
    await emitGapNotice(db, c.organizationId, { kind: 'collector', siteId: c.siteId, collectorId: c.id, collectorName: c.name, from: previousHeartbeat, to: now });
  }
  return true;
}

export interface GapInterval {
  started_at: Date | string;
  ended_at: Date | string;
}

export interface AvailabilityInterval {
  status: 'online' | 'offline' | 'unknown';
  started_at: Date | string;
  ended_at: Date | string | null;
  monitor_off?: boolean;
}

const ms = (v: Date | string) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/**
 * Split recorded availability intervals around monitoring gaps: inside a gap the device's state was
 * not observed, so that part becomes `unknown` with `monitor_off: true` (never online or offline).
 * Uptime that skips `unknown` time therefore does not count the monitor's own downtime. Only time
 * the device already had an interval for is labelled; nothing is invented before it was first seen.
 */
export function applyMonitorGaps(intervals: AvailabilityInterval[], gaps: GapInterval[], now: Date = new Date()): AvailabilityInterval[] {
  if (!gaps.length) return intervals;
  // Merge overlapping gaps (an 'api' gap and its Sensor's 'collector' gap usually overlap).
  const merged: [number, number][] = [];
  for (const [s, e] of gaps.map((g) => [ms(g.started_at), ms(g.ended_at)] as [number, number]).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const out: AvailabilityInterval[] = [];
  for (const iv of intervals) {
    const start = ms(iv.started_at);
    const end = iv.ended_at === null ? now.getTime() : ms(iv.ended_at);
    let cursor = start;
    for (const [gs, ge] of merged) {
      if (ge <= cursor || gs >= end) continue;
      if (gs > cursor) out.push({ status: iv.status, started_at: new Date(cursor), ended_at: new Date(gs) });
      const offEnd = Math.min(ge, end);
      out.push({ status: 'unknown', started_at: new Date(Math.max(gs, cursor)), ended_at: new Date(offEnd), monitor_off: true });
      cursor = offEnd;
    }
    if (cursor === start) out.push(iv);
    else if (cursor < end || iv.ended_at === null) out.push({ status: iv.status, started_at: new Date(cursor), ended_at: iv.ended_at === null ? null : new Date(end) });
  }
  // A trailing zero-length open interval can appear when a gap ends exactly "now"; drop zero-length closed pieces.
  return out.filter((s) => s.ended_at === null || ms(s.ended_at) > ms(s.started_at));
}
