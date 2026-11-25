import { auditSystem } from '../../common/audit.ts';
import { AppError, type AuthContext } from '../../common/http.ts';
import { type Db, withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { type DeviceRef, capability, protectedDevice } from './control.ts';
import { ROUTER_SELECT, type RouterRow, delivery, expireStaleRequests, loadRouter, queueRequest } from './service.ts';

// Internet pauses enforced on the router (migration 049). A pause is a DNS-filter rule first, which
// a device that does not use the filter never sees. When the site has a connected router that can
// block devices, the pause also blocks the device on the router and lifts that block when the pause
// ends. Same rules as the product-enforced schedules (product-schedule.ts): one request at a time,
// only the pause's own block is ever lifted, and a block lifted by hand during the pause is
// respected until the pause ends.

export const PAUSE_RETRY_AFTER_MS = 60_000;

interface PauseBlockRow {
  id: string;
  organization_id: string;
  site_id: string;
  router_id: string;
  device_id: string | null;
  mac: string;
  acted_by: string | null;
  acted_by_email: string | null;
  block_request_id: string | null;
  unblock_request_id: string | null;
  overridden_until: Date | null;
  last_attempt_at: Date | null;
  last_error: string | null;
}

const SELECT = `SELECT id, organization_id, site_id, router_id, device_id, mac::text AS mac, acted_by, acted_by_email, block_request_id,
                       unblock_request_id, overridden_until, last_attempt_at, last_error
                  FROM router_pause_blocks`;

interface PausedDevice {
  device_id: string;
  organization_id: string;
  site_id: string;
  mac: string;
  until: Date;
}

/** Devices whose internet is paused at `now` (their own pause or their profile's), on sites with access control on. */
async function pausedDevices(db: Db, now: Date, deviceIds?: string[]): Promise<PausedDevice[]> {
  return (
    await db.query<PausedDevice>(
      `SELECT d.id AS device_id, d.organization_id, d.site_id, d.primary_mac::text AS mac,
              greatest(CASE WHEN d.internet_paused_until > $1 THEN d.internet_paused_until END,
                       CASE WHEN p.paused_until > $1 THEN p.paused_until END) AS until
         FROM devices d
         JOIN site_access a ON a.site_id = d.site_id AND a.enabled
         LEFT JOIN access_profiles p ON p.id = d.access_profile_id
        WHERE d.primary_mac IS NOT NULL
          AND (d.internet_paused_until > $1 OR p.paused_until > $1)
          AND ($2::uuid[] IS NULL OR d.id = ANY($2::uuid[]))`,
      [now, deviceIds ?? null],
    )
  ).rows;
}

/** The site's routers that can block a device right now. */
export async function blockingRouters(db: Db, siteId: string, now = new Date()): Promise<RouterRow[]> {
  const rows = (await db.query<RouterRow>(`${ROUTER_SELECT} WHERE r.site_id = $1 ORDER BY r.created_at`, [siteId])).rows;
  return rows.filter((r) => !!r.capabilities && !!capability(r, 'block')?.supported && delivery(r, now) === 'active');
}

async function ensureRows(db: Db, wanted: PausedDevice[], actor: { id: string | null; email: string | null } | null, now: Date): Promise<void> {
  const routersBySite = new Map<string, RouterRow[]>();
  for (const w of wanted) {
    let routers = routersBySite.get(w.site_id);
    if (!routers) {
      routers = await blockingRouters(db, w.site_id, now);
      routersBySite.set(w.site_id, routers);
    }
    for (const r of routers) {
      await db.query(
        `INSERT INTO router_pause_blocks (organization_id, site_id, router_id, device_id, mac, acted_by, acted_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (router_id, mac) DO UPDATE SET device_id = EXCLUDED.device_id,
           acted_by = coalesce(EXCLUDED.acted_by, router_pause_blocks.acted_by),
           acted_by_email = coalesce(EXCLUDED.acted_by_email, router_pause_blocks.acted_by_email)`,
        [w.organization_id, w.site_id, r.id, w.device_id, w.mac, actor?.id ?? null, actor?.email ?? null],
      );
    }
  }
}

async function update(db: Db, id: string, fields: Partial<Record<'block_request_id' | 'unblock_request_id' | 'overridden_until' | 'last_attempt_at' | 'last_error', unknown>>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.query(`UPDATE router_pause_blocks SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [
    id,
    ...keys.map((k) => fields[k as keyof typeof fields]),
  ]);
}

async function requestStatus(db: Db, id: string | null): Promise<{ status: string; error: string | null } | null> {
  if (!id) return null;
  return (await db.query<{ status: string; error: string | null }>(`SELECT status, error FROM router_requests WHERE id = $1`, [id])).rows[0] ?? null;
}

export type PauseOutcome = 'waiting' | 'blocked' | 'unblocked' | 'in_effect' | 'overridden' | 'refused' | 'gone';

/**
 * Brings the router in line with one device's pause (`until` = null: not paused). Idempotent: it
 * waits for its own request, never acts twice for the same change, and never lifts a block it did
 * not apply.
 */
export async function enforcePause(db: Db, s: PauseBlockRow, until: Date | null, now: Date): Promise<PauseOutcome> {
  const blockReq = await requestStatus(db, s.block_request_id);
  const unblockReq = await requestStatus(db, s.unblock_request_id);
  if (blockReq?.status === 'pending' || unblockReq?.status === 'pending') return 'waiting';
  if (s.block_request_id && blockReq?.status !== 'completed') {
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

  if (s.block_request_id && !ours) {
    // The pause's block is no longer open. Lifted by someone else while still paused: respect it.
    const endedByUs = !!(s.unblock_request_id && unblockReq?.status === 'completed');
    const fields: Record<string, unknown> = { block_request_id: null, unblock_request_id: null };
    if (!endedByUs && until) {
      fields.overridden_until = until;
      await auditSystem(db, s.organization_id, {
        automation: 'router_pause',
        action: 'router.pause.overridden',
        target: { type: 'device', id: s.device_id },
        siteId: s.site_id,
        metadata: { router_id: s.router_id, mac: s.mac, until },
      });
    }
    await update(db, s.id, fields);
    s.block_request_id = null;
    s.unblock_request_id = null;
    if (fields.overridden_until) s.overridden_until = until;
    ours = false;
  } else if (ours && s.unblock_request_id) {
    // Our unblock completed but the block is still open: try again.
    await update(db, s.id, { unblock_request_id: null });
    s.unblock_request_id = null;
  }

  const overridden = !!(until && s.overridden_until && s.overridden_until >= until);
  if (until && !overridden) {
    if (ours || open) return 'in_effect'; // someone else's block already stops the device; not ours to manage
    return (await act(db, s, 'block', now)) ? 'blocked' : 'refused';
  }
  if (ours) return (await act(db, s, 'unblock', now)) ? 'unblocked' : 'refused';
  if (!until) {
    await db.query(`DELETE FROM router_pause_blocks WHERE id = $1`, [s.id]);
    return 'gone';
  }
  return 'overridden';
}

async function act(db: Db, s: PauseBlockRow, action: 'block' | 'unblock', now: Date): Promise<boolean> {
  // Retry a failed attempt only after a while; a first attempt (or one after success) goes at once.
  if (s.last_error && s.last_attempt_at && now.getTime() - new Date(s.last_attempt_at).getTime() < PAUSE_RETRY_AFTER_MS) return false;
  const fail = async (message: string) => {
    await update(db, s.id, { last_attempt_at: now, last_error: message });
    return false;
  };
  try {
    const r = await loadRouter(db, s.router_id, true);
    if (!r.capabilities || !capability(r, 'block')?.supported) return await fail('The router no longer reports that it can block devices');
    if (delivery(r, now) !== 'active') return await fail('The router cannot be reached from Nigafiy right now');
    const pending = await db.query(`SELECT 1 FROM router_requests WHERE router_id = $1 AND mac = $2::macaddr AND action IN ('block','unblock') AND status = 'pending'`, [
      s.router_id,
      s.mac,
    ]);
    if (pending.rowCount) return false;
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
      // Made on behalf of whoever paused the device (null for an automation).
      userId: s.acted_by as string,
      userEmail: s.acted_by_email ?? 'internet pause',
      sessionId: '',
      role: 'admin',
    };
    const q = await queueRequest(db, ctx, r, action, { mac: s.mac, deviceId: s.device_id, params: { pause: true } });
    await update(db, s.id, {
      [action === 'block' ? 'block_request_id' : 'unblock_request_id']: q.request_id,
      last_attempt_at: now,
      last_error: null,
    });
    await auditSystem(db, s.organization_id, {
      automation: 'router_pause',
      action: `router.pause.${action}`,
      target: { type: 'device', id: s.device_id },
      siteId: s.site_id,
      metadata: { router_id: s.router_id, router: r.name, mac: s.mac, request_id: q.request_id, paused_by: s.acted_by_email },
    });
    return true;
  } catch (err) {
    if (err instanceof AppError) return await fail(err.message);
    throw err;
  }
}

async function enforceRows(db: Db, rows: PauseBlockRow[], wanted: Map<string, Date>, now: Date): Promise<boolean> {
  let changed = false;
  for (const s of rows) {
    await db.query('SAVEPOINT router_pause');
    try {
      const out = await enforcePause(db, s, s.device_id ? (wanted.get(s.device_id) ?? null) : null, now);
      await db.query('RELEASE SAVEPOINT router_pause');
      if (out === 'blocked' || out === 'unblocked' || out === 'gone') changed = true;
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT router_pause');
      logger.warn({ err, pause_block: s.id }, 'router pause could not be enforced');
    }
  }
  return changed;
}

/**
 * Right after a pause or resume, inside the caller's tenant transaction: brings the routers in
 * line for these devices at once, so the user does not wait for the job.
 */
export async function syncRouterPauses(db: Db, deviceIds: string[], actor: { id: string | null; email: string | null } | null): Promise<void> {
  if (!deviceIds.length) return;
  const now = new Date();
  // The DNS pause stands on its own: a router problem must never undo it. The job retries.
  await db.query('SAVEPOINT router_pause_sync');
  try {
    const wanted = await pausedDevices(db, now, deviceIds);
    await ensureRows(db, wanted, actor, now);
    const rows = (await db.query<PauseBlockRow>(`${SELECT} WHERE device_id = ANY($1::uuid[])`, [deviceIds])).rows;
    await enforceRows(db, rows, new Map(wanted.map((w) => [w.device_id, w.until])), now);
    await db.query('RELEASE SAVEPOINT router_pause_sync');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT router_pause_sync');
    logger.warn({ err, devices: deviceIds }, 'router pause sync failed; the router-pauses job will retry');
  }
}

/** The `router-pauses` job: starts blocks for pauses it has not seen yet, lifts them when pauses end, retries failures. */
export async function runRouterPauses(now = new Date()): Promise<void> {
  await withSystem(async (db) => {
    await expireStaleRequests(db);
    const wanted = await pausedDevices(db, now);
    await ensureRows(db, wanted, null, now);
    const rows = (await db.query<PauseBlockRow>(`${SELECT} ORDER BY organization_id, router_id`)).rows;
    const byDevice = new Map(wanted.map((w) => [w.device_id, w.until]));
    const orgs = new Set<string>();
    for (const s of rows) {
      if (await enforceRows(db, [s], byDevice, now)) orgs.add(s.organization_id);
    }
    for (const org of orgs) await notifyRealtime(db, org, 'devices');
  });
}

/** What the access page shows per device: is a router block for its pause on its way, and did it fail. */
export async function pauseBlockStates(db: Db, siteId: string): Promise<Map<string, { pending: boolean; error: string | null }>> {
  const rows = (
    await db.query<{ device_id: string; pending: boolean; error: string | null }>(
      `SELECT b.device_id, bool_or(q.status = 'pending') AS pending, max(b.last_error) AS error
         FROM router_pause_blocks b
         LEFT JOIN router_requests q ON q.id = b.block_request_id
        WHERE b.site_id = $1 AND b.device_id IS NOT NULL
        GROUP BY b.device_id`,
      [siteId],
    )
  ).rows;
  return new Map(rows.map((r) => [r.device_id, { pending: !!r.pending, error: r.error }]));
}
