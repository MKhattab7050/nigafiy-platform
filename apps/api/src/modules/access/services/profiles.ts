import type { Request } from 'express';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { syncRouterPauses } from '../../routers/pause-block.ts';
import type { ProfileBody, ProfilePatchBody } from '../schema.ts';

// Access profiles: named rule sets (categories, domains, schedule) shared by several devices of a
// site, which can be paused together. `req` is passed only for the audit trail.

export function createProfile(req: Request, ctx: AuthContext, site_id: string, body: ProfileBody): Promise<{ id: string }> {
  return withTenant(ctx.organizationId, async (db) => {
    const exists = (await db.query(`SELECT 1 FROM access_profiles WHERE site_id = $1 AND lower(name) = lower($2)`, [site_id, body.name])).rowCount;
    if (exists) throw new AppError(409, 'name_in_use', 'A profile with this name already exists');
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO access_profiles (organization_id, site_id, name, blocked_categories, blocked_domains, allowed_domains, schedule)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.organizationId, site_id, body.name, body.blocked_categories, body.blocked_domains, body.allowed_domains, JSON.stringify(body.schedule)],
      )
    ).rows[0]!;
    await audit(db, req, 'access.profile.create', { type: 'access_profile', id: row.id }, { name: body.name });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return row;
  });
}

export async function updateProfile(req: Request, ctx: AuthContext, id: string, body: ProfilePatchBody): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      vals.push(k === 'schedule' ? JSON.stringify(v) : v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return;
    const r = await db.query(`UPDATE access_profiles SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
    if (!r.rowCount) throw notFound('Profile');
    await audit(db, req, 'access.profile.update', { type: 'access_profile', id }, body);
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

export async function deleteProfile(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`DELETE FROM access_profiles WHERE id = $1`, [id]);
    if (!r.rowCount) throw notFound('Profile');
    await audit(db, req, 'access.profile.delete', { type: 'access_profile', id }, {});
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

/** Pause (until > now) or resume (until = null) the internet for every device of the profile. */
export async function pauseProfile(req: Request, ctx: AuthContext, id: string, minutes: number | null, until: Date | null): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`UPDATE access_profiles SET paused_until = $2, updated_at = now() WHERE id = $1`, [id, until]);
    if (!r.rowCount) throw notFound('Profile');
    await audit(db, req, minutes === null ? 'access.profile.resume' : 'access.profile.pause', { type: 'access_profile', id }, { until });
    const members = (await db.query<{ id: string }>(`SELECT id FROM devices WHERE access_profile_id = $1`, [id])).rows.map((d) => d.id);
    await syncRouterPauses(db, members, { id: ctx.userId, email: ctx.userEmail });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}
