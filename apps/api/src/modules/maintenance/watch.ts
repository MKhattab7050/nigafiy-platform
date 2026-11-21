import { type Db, withSystem } from '../../infrastructure/db.ts';
import { refreshSiteCorrelation } from '../correlation/index.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';

interface ClosedRunRow {
  id: string;
  organization_id: string;
  window_id: string | null;
  site_id: string | null;
  reason: string;
  occurrence_start: Date;
  occurrence_end: Date;
  scope: Record<string, unknown>;
}

interface ActiveWindowRow {
  id: string;
  organization_id: string;
  site_id: string | null;
  reason: string;
  target_all: boolean;
  device_ids: string[];
  check_ids: string[];
  collector_ids: string[];
  occurrence_start: Date;
  occurrence_end: Date;
}

export async function emitRunEnded(db: Db, run: ClosedRunRow, at = new Date()): Promise<void> {
  await emitEvent(db, run.organization_id, {
    siteId: run.site_id,
    type: 'maintenance_ended',
    severity: 'info',
    title: `Maintenance window ended: ${run.reason}`,
    details: {
      window_id: run.window_id,
      run_id: run.id,
      reason: run.reason,
      occurrence_start: new Date(run.occurrence_start).toISOString(),
      occurrence_end: new Date(run.occurrence_end).toISOString(),
      scope: run.scope,
    },
    source: 'platform',
    occurredAt: at,
  });
  const siteIds = run.site_id
    ? [run.site_id]
    : (await db.query<{ id: string }>(`SELECT id FROM sites WHERE organization_id = $1`, [run.organization_id])).rows.map((s) => s.id);
  for (const siteId of siteIds) {
    await refreshSiteCorrelation(db, run.organization_id, siteId, at);
  }
  await notifyRealtime(db, run.organization_id, 'events');
}

/**
 * Starts `maintenance_runs` for active windows (emitting `maintenance_started`) and closes expired
 * or deactivated runs (emitting `maintenance_ended`). Safe to run concurrently and repeatedly.
 */
export async function watchMaintenance(now = new Date()): Promise<void> {
  await withSystem(async (db) => {
    // 1. End open runs whose occurrence has finished or whose parent window is no longer active at `now`.
    const closed = await db.query<ClosedRunRow>(
      `UPDATE maintenance_runs r
          SET ended_at = $1
        WHERE r.ended_at IS NULL
          AND (
            r.occurrence_end <= $1
            OR (
              r.window_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM maintenance_windows w
                 WHERE w.id = r.window_id
                   AND maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, $1) IS NOT NULL
              )
            )
          )
        RETURNING r.id, r.organization_id, r.window_id, r.site_id, r.reason, r.occurrence_start, r.occurrence_end, r.scope`,
      [now],
    );
    for (const run of closed.rows) {
      await emitRunEnded(db, run, now);
    }

    // 2. Open runs for windows currently in an occurrence at `now`.
    const active = await db.query<ActiveWindowRow>(
      `SELECT w.id, w.organization_id, w.site_id, w.reason,
              w.target_all, w.device_ids, w.check_ids, w.collector_ids,
              lower(occ.r) AS occurrence_start, upper(occ.r) AS occurrence_end
         FROM maintenance_windows w
         CROSS JOIN LATERAL (
           SELECT maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, $1) AS r
         ) occ
        WHERE occ.r IS NOT NULL`,
      [now],
    );

    for (const w of active.rows) {
      const scope = {
        target_all: w.target_all,
        device_ids: w.device_ids,
        check_ids: w.check_ids,
        collector_ids: w.collector_ids,
      };
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO maintenance_runs
           (organization_id, window_id, site_id, reason, occurrence_start, occurrence_end, scope, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (window_id, occurrence_start) DO NOTHING
         RETURNING id`,
        [
          w.organization_id,
          w.id,
          w.site_id,
          w.reason,
          w.occurrence_start,
          w.occurrence_end,
          JSON.stringify(scope),
          now,
        ],
      );
      if (inserted.rows[0]) {
        await emitEvent(db, w.organization_id, {
          siteId: w.site_id,
          type: 'maintenance_started',
          severity: 'info',
          title: `Maintenance window started: ${w.reason}`,
          details: {
            window_id: w.id,
            run_id: inserted.rows[0].id,
            reason: w.reason,
            occurrence_start: new Date(w.occurrence_start).toISOString(),
            occurrence_end: new Date(w.occurrence_end).toISOString(),
            scope,
          },
          source: 'platform',
          occurredAt: now,
        });
        await notifyRealtime(db, w.organization_id, 'events');
      }
    }
  });
}
