import type { Request } from 'express';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { syncRouterPauses } from '../../routers/pause-block.ts';
import type { DeviceAccessBody } from '../schema.ts';

// Per-device access control: pause, the device's own rule layer, and its DNS activity.
// `req` is passed only for the audit trail.

export async function pauseDevice(req: Request, ctx: AuthContext, id: string, minutes: number | null, until: Date | null): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`UPDATE devices SET internet_paused_until = $2 WHERE id = $1`, [id, until]);
    if (!r.rowCount) throw notFound('Device');
    await audit(db, req, minutes === null ? 'device.internet.resume' : 'device.internet.pause', { type: 'device', id }, { until });
    // Also block (or unblock) the device on the site's router, where one is connected and can block.
    await syncRouterPauses(db, [id], { id: ctx.userId, email: ctx.userEmail });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

export async function setDeviceAccess(req: Request, ctx: AuthContext, id: string, body: DeviceAccessBody): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const device = (await db.query<{ site_id: string }>(`SELECT site_id FROM devices WHERE id = $1`, [id])).rows[0];
    if (!device) throw notFound('Device');
    if (body.profile_id) {
      const p = (await db.query(`SELECT 1 FROM access_profiles WHERE id = $1 AND site_id = $2`, [body.profile_id, device.site_id])).rowCount;
      if (!p) throw new AppError(422, 'bad_profile', 'The profile does not belong to this device’s site');
    }
    const cols: Record<string, unknown> = {
      access_profile_id: body.profile_id,
      access_blocked_domains: body.blocked_domains,
      access_allowed_domains: body.allowed_domains,
      access_schedule: body.schedule === undefined ? undefined : JSON.stringify(body.schedule),
    };
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(cols)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (sets.length) await db.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(db, req, 'device.access', { type: 'device', id }, body);
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

/** DNS activity of one device over the last `hours`: totals, top domains, hourly counts. */
export function deviceActivity(organizationId: string, id: string, hours: number) {
  return withTenant(organizationId, async (db) => {
    const exists = (await db.query(`SELECT 1 FROM devices WHERE id = $1`, [id])).rowCount;
    if (!exists) throw notFound('Device');
    const totals = (
      await db.query<{ queries: number; blocked: number; first: string | null; last: string | null }>(
        `SELECT coalesce(sum(queries),0)::int AS queries, coalesce(sum(blocked),0)::int AS blocked, min(window_start) AS first, max(window_end) AS last
           FROM dns_stats WHERE device_id = $1 AND window_end > now() - make_interval(hours => $2)`,
        [id, hours],
      )
    ).rows[0]!;
    const domains = (
      await db.query<{ domain: string; count: number; blocked: number; category: string | null; reason: string | null; last_seen: string }>(
        `SELECT t->>'domain' AS domain, sum((t->>'count')::int)::int AS count, sum((t->>'blocked')::int)::int AS blocked,
                max(t->>'category') AS category, max(t->>'reason') AS reason, max(s.window_end) AS last_seen
           FROM dns_stats s, jsonb_array_elements(s.top_domains) t
          WHERE s.device_id = $1 AND s.window_end > now() - make_interval(hours => $2)
          GROUP BY 1 ORDER BY (sum((t->>'blocked')::int) > 0) DESC, sum((t->>'count')::int) DESC LIMIT 40`,
        [id, hours],
      )
    ).rows;
    const hourly = (
      await db.query<{ hour: string; queries: number; blocked: number }>(
        `SELECT date_trunc('hour', window_end) AS hour, sum(queries)::int AS queries, sum(blocked)::int AS blocked
           FROM dns_stats WHERE device_id = $1 AND window_end > now() - make_interval(hours => $2) GROUP BY 1 ORDER BY 1`,
        [id, hours],
      )
    ).rows;
    return { hours, ...totals, domains, hourly };
  });
}
