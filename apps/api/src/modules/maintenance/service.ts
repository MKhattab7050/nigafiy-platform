import type { Request } from 'express';
import type { MaintenanceList, MaintenanceRun, MaintenanceWindow } from '@nigafiy/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../common/http.ts';
import { type Db, systemPool, withTenant } from '../../infrastructure/db.ts';
import type { MaintenanceCreate, MaintenancePatch } from './schema.ts';
import { emitRunEnded, watchMaintenance } from './watch.ts';

interface WindowDbRow {
  id: string;
  site_id: string | null;
  site_name: string | null;
  reason: string;
  timezone: string;
  starts_local: string;
  ends_local: string;
  weekdays: number[] | null;
  recur_until: string | null;
  target_all: boolean;
  device_ids: string[];
  check_ids: string[];
  collector_ids: string[];
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  active: boolean;
  cur_start: Date | null;
  cur_end: Date | null;
  nxt_start: Date | null;
  nxt_end: Date | null;
}

const WINDOW_SELECT = `
  SELECT w.id, w.site_id, s.name AS site_name, w.reason, w.timezone,
         to_char(w.starts_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_local,
         to_char(w.ends_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_local,
         w.weekdays::int[] AS weekdays,
         w.recur_until::text AS recur_until,
         w.target_all, w.device_ids, w.check_ids, w.collector_ids,
         w.created_by, w.created_by_name, w.created_at, w.updated_at,
         (occ.cur IS NOT NULL) AS active,
         lower(occ.cur) AS cur_start, upper(occ.cur) AS cur_end,
         lower(occ.nxt) AS nxt_start, upper(occ.nxt) AS nxt_end
    FROM maintenance_windows w
    LEFT JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id
    LEFT JOIN LATERAL (
      SELECT maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, now()) AS cur,
             maintenance_next_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, now()) AS nxt
    ) occ ON true`;

const RUN_SELECT = `
  SELECT r.id, r.window_id, r.site_id, s.name AS site_name, r.reason,
         r.occurrence_start, r.occurrence_end, r.scope, r.started_at, r.ended_at
    FROM maintenance_runs r
    LEFT JOIN sites s ON s.organization_id = r.organization_id AND s.id = r.site_id`;

function formatWindow(r: WindowDbRow): MaintenanceWindow {
  return {
    id: r.id,
    site_id: r.site_id,
    site_name: r.site_name,
    reason: r.reason,
    timezone: r.timezone,
    starts_local: r.starts_local,
    ends_local: r.ends_local,
    weekdays: r.weekdays,
    recur_until: r.recur_until,
    target_all: r.target_all,
    device_ids: r.device_ids,
    check_ids: r.check_ids,
    collector_ids: r.collector_ids,
    created_by: r.created_by,
    created_by_name: r.created_by_name,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
    active: r.active,
    current_occurrence:
      r.cur_start && r.cur_end
        ? { start: new Date(r.cur_start).toISOString(), end: new Date(r.cur_end).toISOString() }
        : null,
    next_occurrence:
      r.nxt_start && r.nxt_end
        ? { start: new Date(r.nxt_start).toISOString(), end: new Date(r.nxt_end).toISOString() }
        : null,
  };
}

interface ValidatedWindowSpec {
  site_id: string | null;
  reason: string;
  timezone: string;
  starts_local: string;
  ends_local: string;
  weekdays: number[] | null;
  recur_until: string | null;
  target_all: boolean;
  device_ids: string[];
  check_ids: string[];
  collector_ids: string[];
}

async function normalizeAndValidateSpec(
  db: Db,
  spec: {
    site_id: string | null;
    reason: string;
    timezone?: string;
    starts_local: string;
    ends_local: string;
    weekdays: number[] | null;
    recur_until: string | null;
    target_all?: boolean;
    device_ids: string[];
    check_ids: string[];
    collector_ids: string[];
  },
): Promise<ValidatedWindowSpec> {
  let siteTimezone = 'UTC';
  if (spec.site_id) {
    const siteRes = await db.query<{ timezone: string }>(`SELECT timezone FROM sites WHERE id = $1`, [spec.site_id]);
    if (!siteRes.rows[0]) throw notFound('Site');
    siteTimezone = siteRes.rows[0].timezone;
  }
  const timezone = spec.timezone ?? siteTimezone;

  const startMs = Date.parse(`${spec.starts_local}Z`);
  const endMs = Date.parse(`${spec.ends_local}Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new AppError(400, 'invalid_window', 'The end time must be after the start time');
  }

  const weekdays =
    spec.weekdays && spec.weekdays.length > 0 ? [...new Set(spec.weekdays)].sort((a, b) => a - b) : null;
  if (spec.weekdays && spec.weekdays.length === 0 && spec.recur_until) {
    throw new AppError(400, 'invalid_window', 'Select at least one weekday for a repeating window');
  }
  if (spec.recur_until && !weekdays) {
    throw new AppError(400, 'invalid_window', 'recur_until can only be set on a repeating window');
  }

  const durationMs = endMs - startMs;
  const maxDurationMs = (weekdays ? 7 : 90) * 24 * 3600_000;
  if (durationMs > maxDurationMs) {
    throw new AppError(
      400,
      'invalid_window',
      weekdays
        ? 'A repeating occurrence can be at most 7 days long'
        : 'A one-off maintenance window can be at most 90 days long',
    );
  }

  const deviceIds = [...new Set(spec.device_ids)];
  const checkIds = [...new Set(spec.check_ids)];
  const collectorIds = [...new Set(spec.collector_ids)];
  const hasSpecificTargets = deviceIds.length + checkIds.length + collectorIds.length > 0;
  const targetAll = spec.target_all ?? !hasSpecificTargets;

  if (!targetAll && !hasSpecificTargets) {
    throw new AppError(
      400,
      'empty_target',
      'Select at least one device, check or collector, or target the whole scope',
    );
  }

  return {
    site_id: spec.site_id,
    reason: spec.reason,
    timezone,
    starts_local: spec.starts_local,
    ends_local: spec.ends_local,
    weekdays,
    recur_until: spec.recur_until,
    target_all: targetAll,
    device_ids: targetAll ? [] : deviceIds,
    check_ids: targetAll ? [] : checkIds,
    collector_ids: targetAll ? [] : collectorIds,
  };
}

export async function listMaintenance(organizationId: string, siteId?: string): Promise<MaintenanceList> {
  return withTenant(organizationId, async (db) => {
    const windows = await db.query<WindowDbRow>(
      `${WINDOW_SELECT}
        WHERE ($1::uuid IS NULL OR w.site_id = $1 OR w.site_id IS NULL)
        ORDER BY (occ.cur IS NOT NULL) DESC, lower(occ.nxt) ASC NULLS LAST, w.created_at DESC`,
      [siteId ?? null],
    );
    const runs = await db.query<MaintenanceRun>(
      `${RUN_SELECT}
        WHERE r.ended_at IS NULL AND ($1::uuid IS NULL OR r.site_id = $1 OR r.site_id IS NULL)
        ORDER BY r.started_at DESC`,
      [siteId ?? null],
    );
    return {
      items: windows.rows.map(formatWindow),
      active_runs: runs.rows,
    };
  });
}

export async function createMaintenanceWindow(
  req: Request,
  ctx: AuthContext,
  body: MaintenanceCreate,
): Promise<MaintenanceWindow> {
  const userRes = await systemPool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [
    ctx.userId,
  ]);
  const createdByName = userRes.rows[0]?.display_name ?? ctx.userEmail;

  const id = await withTenant(ctx.organizationId, async (db) => {
    const spec = await normalizeAndValidateSpec(db, body);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO maintenance_windows
         (organization_id, site_id, reason, timezone, starts_local, ends_local, weekdays, recur_until,
          target_all, device_ids, check_ids, collector_ids, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        ctx.organizationId,
        spec.site_id,
        spec.reason,
        spec.timezone,
        spec.starts_local,
        spec.ends_local,
        spec.weekdays,
        spec.recur_until,
        spec.target_all,
        spec.device_ids,
        spec.check_ids,
        spec.collector_ids,
        ctx.userId,
        createdByName,
      ],
    );
    const windowId = inserted.rows[0]!.id;
    await audit(db, req, 'maintenance.created', { type: 'maintenance_window', id: windowId }, {
      site_id: spec.site_id,
      reason: spec.reason,
      starts_local: spec.starts_local,
      ends_local: spec.ends_local,
      timezone: spec.timezone,
      target_all: spec.target_all,
    });
    return windowId;
  });

  await watchMaintenance();

  return withTenant(ctx.organizationId, async (db) => {
    const row = (await db.query<WindowDbRow>(`${WINDOW_SELECT} WHERE w.id = $1`, [id])).rows[0]!;
    return formatWindow(row);
  });
}

export async function updateMaintenanceWindow(
  req: Request,
  ctx: AuthContext,
  id: string,
  body: MaintenancePatch,
): Promise<MaintenanceWindow> {
  await withTenant(ctx.organizationId, async (db) => {
    const existing = (await db.query<WindowDbRow>(`${WINDOW_SELECT} WHERE w.id = $1 FOR UPDATE OF w`, [id])).rows[0];
    if (!existing) throw notFound('Maintenance window');

    const merged = {
      site_id: body.site_id !== undefined ? body.site_id : existing.site_id,
      reason: body.reason ?? existing.reason,
      timezone: body.timezone ?? existing.timezone,
      starts_local: body.starts_local ?? existing.starts_local,
      ends_local: body.ends_local ?? existing.ends_local,
      weekdays: body.weekdays !== undefined ? body.weekdays : existing.weekdays,
      recur_until: body.recur_until !== undefined ? body.recur_until : existing.recur_until,
      target_all:
        body.target_all !== undefined
          ? body.target_all
          : body.device_ids !== undefined || body.check_ids !== undefined || body.collector_ids !== undefined
            ? undefined
            : existing.target_all,
      device_ids: body.device_ids ?? existing.device_ids,
      check_ids: body.check_ids ?? existing.check_ids,
      collector_ids: body.collector_ids ?? existing.collector_ids,
    };

    const spec = await normalizeAndValidateSpec(db, merged);

    await db.query(
      `UPDATE maintenance_windows
          SET site_id = $2,
              reason = $3,
              timezone = $4,
              starts_local = $5,
              ends_local = $6,
              weekdays = $7,
              recur_until = $8,
              target_all = $9,
              device_ids = $10,
              check_ids = $11,
              collector_ids = $12,
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        spec.site_id,
        spec.reason,
        spec.timezone,
        spec.starts_local,
        spec.ends_local,
        spec.weekdays,
        spec.recur_until,
        spec.target_all,
        spec.device_ids,
        spec.check_ids,
        spec.collector_ids,
      ],
    );

    await audit(db, req, 'maintenance.updated', { type: 'maintenance_window', id }, body);
  });

  await watchMaintenance();

  return withTenant(ctx.organizationId, async (db) => {
    const row = (await db.query<WindowDbRow>(`${WINDOW_SELECT} WHERE w.id = $1`, [id])).rows[0];
    if (!row) throw notFound('Maintenance window');
    return formatWindow(row);
  });
}

export async function deleteMaintenanceWindow(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const existing = (
      await db.query<{ id: string; reason: string; site_id: string | null }>(
        `SELECT id, reason, site_id FROM maintenance_windows WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!existing) throw notFound('Maintenance window');

    const closedRuns = await db.query<{
      id: string;
      organization_id: string;
      window_id: string | null;
      site_id: string | null;
      reason: string;
      occurrence_start: Date;
      occurrence_end: Date;
      scope: Record<string, unknown>;
    }>(
      `UPDATE maintenance_runs
          SET ended_at = now()
        WHERE window_id = $1 AND ended_at IS NULL
        RETURNING id, organization_id, window_id, site_id, reason, occurrence_start, occurrence_end, scope`,
      [id],
    );
    for (const run of closedRuns.rows) {
      await emitRunEnded(db, run);
    }

    await db.query(`DELETE FROM maintenance_windows WHERE id = $1`, [id]);
    await audit(db, req, 'maintenance.deleted', { type: 'maintenance_window', id }, {
      reason: existing.reason,
      site_id: existing.site_id,
    });
  });
}
