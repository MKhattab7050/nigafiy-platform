import type { Request } from 'express';
import { audit, auditSystem } from '../../common/audit.ts';
import { AppError, type AuthContext } from '../../common/http.ts';
import { type Db, withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { type DeviceRef, capability, protectedDevice } from './control.ts';
import { type RouterRow, assertControllable, delivery, expireStaleRequests, loadRouter, queueRequest } from './service.ts';

// Schedules LAN Detective enforces itself (migration 029). For a router that can block a device but
// cannot schedule it (no driver support, or the router ignores its own schedule), the windows are
// stored here and the `router-schedules` job switches the router's own block on at the start of a
// window and off at the end. Only blocks the schedule applied are ever lifted by it: a block an
// administrator made stays. Lifting the schedule's block by hand during a window pauses the
// schedule until that window ends.

export interface ScheduleWindow {
  days: number[];
  start: string;
  end: string;
}

export interface ProductScheduleRow {
  id: string;
  organization_id: string;
  site_id: string;
  router_id: string;
  device_id: string | null;
  mac: string;
  windows: ScheduleWindow[];
  timezone: string;
  created_by: string | null;
  created_by_email: string | null;
  created_at: Date;
  updated_at: Date;
  block_request_id: string | null;
  unblock_request_id: string | null;
  paused_until: Date | null;
  removing: boolean;
  last_attempt_at: Date | null;
  last_error: string | null;
}

const SELECT = `SELECT id, organization_id, site_id, router_id, device_id, mac::text AS mac, windows, timezone, created_by, created_by_email, created_at,
                       updated_at, block_request_id, unblock_request_id, paused_until, removing, last_attempt_at, last_error
                  FROM router_product_schedules`;

/** Minimum time between two attempts of the same schedule (a refusal or failure is not retried in a loop). */
export const RETRY_AFTER_MS = 60_000;
export const PRODUCT_SCHEDULE_NOTE =
  'LAN Detective enforces this schedule itself: it turns the router’s block for the device on at the start of each window and off at the end. It works only while LAN Detective and the site’s collector are running.';

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock weekday (0 = Sunday) and minute of the day at `now` in `tz`. */
export function localClock(now: Date, tz: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: WEEKDAY[get('weekday')] ?? 0, minute: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

/**
 * Whether `now` falls inside one of the windows, and how many minutes remain of the longest active
 * one. A window whose end is not after its start crosses midnight into the next day.
 */
export function windowState(windows: ScheduleWindow[], now: Date, tz: string): { active: boolean; minutesLeft: number } {
  const { day, minute } = localClock(now, tz);
  const prev = (day + 6) % 7;
  let left = 0;
  for (const w of windows) {
    const s = toMinutes(w.start);
    const e = toMinutes(w.end);
    if (s < e) {
      if (w.days.includes(day) && minute >= s && minute < e) left = Math.max(left, e - minute);
    } else {
      if (w.days.includes(day) && minute >= s) left = Math.max(left, 1440 - minute + e);
      if (w.days.includes(prev) && minute < e) left = Math.max(left, e - minute);
    }
  }
  return { active: left > 0, minutesLeft: left };
}

/** Rules the stored windows must meet (the API schema already checked the shape). */
export function checkWindows(windows: ScheduleWindow[]): void {
  for (const w of windows) {
    if (w.start === w.end) throw new AppError(422, 'invalid_window', 'A window needs different start and end times');
  }
}

/** Whether LAN Detective enforces schedules for this router itself: the router can block but not schedule. */
export function productScheduling(r: RouterRow): boolean {
  if (!r.capabilities) return false;
  return !capability(r, 'schedule')?.supported && !!capability(r, 'block')?.supported;
}

export async function findProductSchedule(db: Db, routerId: string, mac: string): Promise<ProductScheduleRow | null> {
  return (await db.query<ProductScheduleRow>(`${SELECT} WHERE router_id = $1 AND mac = $2::macaddr`, [routerId, mac])).rows[0] ?? null;
}

/** What the device card shows of a stored schedule. */
export function presentProductSchedule(s: ProductScheduleRow, now = new Date()) {
  const state = s.removing ? null : windowState(s.windows, now, s.timezone);
  return {
    mode: 'product' as const,
    windows: s.windows,
    timezone: s.timezone,
    created_by_email: s.created_by_email,
    updated_at: s.updated_at,
    removing: s.removing,
    in_window: state?.active ?? false,
    paused_until: s.paused_until && s.paused_until > now ? s.paused_until : null,
    blocking: !!s.block_request_id,
    last_error: s.last_error,
  };
}

/** Create, replace or remove (windows null) the device's product-enforced schedule; then enforce it at once. */
export async function saveProductSchedule(
  db: Db,
  req: Request,
  ctx: AuthContext,
  r: RouterRow,
  d: DeviceRef & { mac: string },
  windows: ScheduleWindow[] | null,
  timezone: string,
) {
  const existing = await findProductSchedule(db, r.id, d.mac);
  let row: ProductScheduleRow | null;
  if (windows) {
    checkWindows(windows);
    if (!validTimeZone(timezone)) throw new AppError(422, 'invalid_timezone', `Unknown time zone "${timezone}"`);
    row = (
      await db.query<ProductScheduleRow>(
        `INSERT INTO router_product_schedules (organization_id, site_id, router_id, device_id, mac, windows, timezone, created_by, created_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (router_id, mac) DO UPDATE SET windows = EXCLUDED.windows, timezone = EXCLUDED.timezone, device_id = EXCLUDED.device_id,
           created_by = EXCLUDED.created_by, created_by_email = EXCLUDED.created_by_email, updated_at = now(), removing = false, paused_until = NULL,
           last_attempt_at = NULL, last_error = NULL
         RETURNING id`,
        [ctx.organizationId, r.site_id, r.id, d.id, d.mac, JSON.stringify(windows), timezone, ctx.userId, ctx.userEmail],
      )
    ).rows[0]!;
    row = await findProductSchedule(db, r.id, d.mac);
  } else {
    if (!existing) throw new AppError(404, 'no_schedule', 'This device has no schedule on this router');
    await db.query(`UPDATE router_product_schedules SET removing = true, updated_at = now(), last_attempt_at = NULL WHERE id = $1`, [existing.id]);
    row = await findProductSchedule(db, r.id, d.mac);
  }
  await audit(db, req, windows ? 'router.schedule' : 'router.schedule.clear', { type: 'device', id: d.id }, {
    router_id: r.id,
    mac: d.mac,
    mode: 'product',
    windows,
    timezone: windows ? timezone : existing?.timezone,
  });
  const outcome = row ? await enforceSchedule(db, row, new Date()) : 'gone';
  await notifyRealtime(db, ctx.organizationId, 'devices');
  const after = await findProductSchedule(db, r.id, d.mac);
  return { mode: 'product' as const, outcome, schedule: after ? presentProductSchedule(after) : null };
}

type Outcome = 'waiting' | 'blocked' | 'unblocked' | 'in_effect' | 'idle' | 'paused' | 'refused' | 'gone';

async function requestStatus(db: Db, id: string | null): Promise<{ status: string; error: string | null } | null> {
  if (!id) return null;
  return (await db.query<{ status: string; error: string | null }>(`SELECT status, error FROM router_requests WHERE id = $1`, [id])).rows[0] ?? null;
}

async function update(db: Db, id: string, fields: Partial<Record<'block_request_id' | 'unblock_request_id' | 'paused_until' | 'last_attempt_at' | 'last_error', unknown>>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.query(`UPDATE router_product_schedules SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [
    id,
    ...keys.map((k) => fields[k as keyof typeof fields]),
  ]);
}

/**
 * Brings the router in line with one schedule. Idempotent: it acts only on a window edge, never
 * twice for the same edge (it waits for its own request), and never on a block it did not apply.
 */
export async function enforceSchedule(db: Db, s: ProductScheduleRow, now: Date): Promise<Outcome> {
  // 1. Settle the requests the schedule queued earlier.
  const blockReq = await requestStatus(db, s.block_request_id);
  const unblockReq = await requestStatus(db, s.unblock_request_id);
  if (blockReq?.status === 'pending' || unblockReq?.status === 'pending') return 'waiting';
  if (s.block_request_id && (!blockReq || blockReq.status !== 'completed')) {
    await update(db, s.id, { block_request_id: null, unblock_request_id: null, last_error: blockReq?.error ?? 'The block request was not completed' });
    s.block_request_id = null;
    s.unblock_request_id = null;
  }
  if (s.unblock_request_id && unblockReq && unblockReq.status !== 'completed') {
    await update(db, s.id, { unblock_request_id: null, last_error: unblockReq.error ?? 'The unblock request was not completed' });
    s.unblock_request_id = null;
  }

  const open = (
    await db.query<{ request_id: string | null; pre_existing: boolean }>(
      `SELECT request_id, pre_existing FROM router_blocks WHERE router_id = $1 AND mac = $2::macaddr AND released_at IS NULL`,
      [s.router_id, s.mac],
    )
  ).rows[0];
  let ours = !!(s.block_request_id && open && !open.pre_existing && open.request_id === s.block_request_id);
  const state = windowState(s.windows, now, s.timezone);

  if (s.block_request_id && !ours) {
    // The schedule's block is no longer open (or never became the schedule's own).
    const own = (await db.query<{ pre_existing: boolean; released_at: Date | null }>(`SELECT pre_existing, released_at FROM router_blocks WHERE request_id = $1`, [s.block_request_id])).rows[0];
    const endedByUs = !!(s.unblock_request_id && unblockReq?.status === 'completed');
    const overridden = !!(own && !own.pre_existing && own.released_at && !endedByUs);
    const fields: Record<string, unknown> = { block_request_id: null, unblock_request_id: null };
    if (overridden && state.active && !s.removing) {
      // Lifted by hand (from LAN Detective or on the router) during a window: respect it until the window ends.
      fields.paused_until = new Date(now.getTime() + state.minutesLeft * 60_000);
      await auditSystem(db, s.organization_id, {
        automation: 'router_schedule',
        action: 'router.schedule.paused',
        target: { type: 'device', id: s.device_id },
        siteId: s.site_id,
        metadata: { router_id: s.router_id, mac: s.mac, schedule_id: s.id, until: fields.paused_until },
      });
    }
    await update(db, s.id, fields);
    s.block_request_id = null;
    s.unblock_request_id = null;
    if (fields.paused_until) s.paused_until = fields.paused_until as Date;
    ours = false;
  } else if (ours && s.unblock_request_id) {
    // Our unblock completed but the block is still open (e.g. not applied on the router): try again later.
    await update(db, s.id, { unblock_request_id: null });
    s.unblock_request_id = null;
  }

  // 2. Removal: lift the schedule's own block, then forget the schedule.
  if (s.removing) {
    if (!ours) {
      await db.query(`DELETE FROM router_product_schedules WHERE id = $1`, [s.id]);
      return 'gone';
    }
    return (await act(db, s, 'unblock', now)) ? 'unblocked' : 'refused';
  }

  const paused = !!(s.paused_until && s.paused_until > now);
  if (s.paused_until && !paused) await update(db, s.id, { paused_until: null });

  // 3. The window edges.
  if (state.active && !paused) {
    if (ours) return 'in_effect';
    if (open) return 'in_effect'; // already blocked by someone else; that block is not the schedule's to manage
    return (await act(db, s, 'block', now)) ? 'blocked' : 'refused';
  }
  if (ours) return (await act(db, s, 'unblock', now)) ? 'unblocked' : 'refused';
  return paused ? 'paused' : 'idle';
}

/** Queues the router's block or unblock for a schedule, through the normal request path. */
async function act(db: Db, s: ProductScheduleRow, action: 'block' | 'unblock', now: Date): Promise<boolean> {
  if (s.last_attempt_at && now.getTime() - new Date(s.last_attempt_at).getTime() < RETRY_AFTER_MS) return false;
  const fail = async (message: string) => {
    await update(db, s.id, { last_attempt_at: now, last_error: message });
    return false;
  };
  try {
    const r = await loadRouter(db, s.router_id, true);
    if (!r.capabilities || !capability(r, 'block')?.supported) return await fail('The router no longer reports that it can block devices');
    if (delivery(r) !== 'active') assertControllable(r);
    const pending = await db.query(`SELECT 1 FROM router_requests WHERE router_id = $1 AND mac = $2::macaddr AND action IN ('block','unblock') AND status = 'pending'`, [
      s.router_id,
      s.mac,
    ]);
    if (pending.rowCount) return false; // someone else's request is on its way; look again next run
    if (action === 'block' && s.device_id) {
      const d = (
        await db.query<DeviceRef>(
          `SELECT id, site_id, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label, host(current_ip) AS ip, primary_mac::text AS mac
             FROM devices WHERE id = $1`,
          [s.device_id],
        )
      ).rows[0];
      const guard = d ? await protectedDevice(db, d, null) : null;
      if (guard) return await fail(guard.message);
    }
    const ctx: AuthContext = {
      organizationId: s.organization_id,
      // The request is made on behalf of the administrator who set the schedule.
      userId: s.created_by as string,
      userEmail: s.created_by_email ?? 'schedule',
      sessionId: '',
      role: 'admin',
    };
    const q = await queueRequest(db, ctx, r, action, { mac: s.mac, deviceId: s.device_id, params: { schedule_id: s.id } });
    await update(db, s.id, {
      [action === 'block' ? 'block_request_id' : 'unblock_request_id']: q.request_id,
      last_attempt_at: now,
      last_error: null,
    });
    await auditSystem(db, s.organization_id, {
      automation: 'router_schedule',
      action: `router.schedule.${action}`,
      target: { type: 'device', id: s.device_id },
      siteId: s.site_id,
      metadata: { router_id: s.router_id, router: r.name, mac: s.mac, schedule_id: s.id, request_id: q.request_id, set_by: s.created_by_email },
    });
    return true;
  } catch (err) {
    if (err instanceof AppError) return await fail(err.message);
    throw err;
  }
}

/** The `router-schedules` job: every stored schedule of every organization, each in its own savepoint. */
export async function runProductSchedules(now = new Date()): Promise<void> {
  await withSystem(async (db) => {
    await expireStaleRequests(db);
    const rows = (await db.query<ProductScheduleRow>(`${SELECT} ORDER BY organization_id, router_id`)).rows;
    const touched = new Set<string>();
    for (const s of rows) {
      await db.query('SAVEPOINT product_schedule');
      try {
        const out = await enforceSchedule(db, s, now);
        await db.query('RELEASE SAVEPOINT product_schedule');
        if (out === 'blocked' || out === 'unblocked' || out === 'gone') touched.add(s.organization_id);
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT product_schedule');
        logger.warn({ err, schedule: s.id }, 'router schedule could not be enforced');
      }
    }
    for (const org of touched) await notifyRealtime(db, org, 'devices');
  });
}
