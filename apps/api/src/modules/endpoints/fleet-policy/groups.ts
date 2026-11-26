import type { Request } from 'express';
import type { FleetGroup } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { builtinProfile, ensureBuiltinProfiles, exceeding, permissionsOf, profileById } from './profiles.ts';
import type { GroupCreate, GroupPatch } from './schema.ts';

// Fleet groups (migration 035): groups of computers, each with its access policy. The address book
// (a later Fleet Pro builder) shows these as its groups; an endpoint is in at most one group
// (endpoints.fleet_group_id), and one in no group uses the organization default policy.

const GROUP_COLUMNS = `g.id, g.name, g.description, g.color, g.access_mode, g.consent_timeout_s, g.refuse_window_s, g.allowed_hours,
  g.allowed_roles, g.default_profile_id, g.max_profile_id, g.mfa_required, g.approval_required, g.approval_ttl_minutes,
  g.ip_allowlist::text[] AS ip_allowlist, g.recording_mode, g.recording_retention_days, g.user_may_view_recordings, g.shell_enabled, g.shell_idle_timeout_minutes, g.banner_mode, g.created_by_email, g.created_at, g.updated_at,
  (SELECT count(*)::int FROM endpoints e WHERE e.organization_id = g.organization_id AND e.fleet_group_id = g.id) AS endpoint_count`;

export async function groupById(db: Db, id: string): Promise<FleetGroup | null> {
  return (await db.query<FleetGroup>(`SELECT ${GROUP_COLUMNS} FROM fleet_groups g WHERE g.id = $1`, [id])).rows[0] ?? null;
}

export async function listGroups(ctx: AuthContext): Promise<FleetGroup[]> {
  return withTenant(ctx.organizationId, async (db) => (await db.query<FleetGroup>(`SELECT ${GROUP_COLUMNS} FROM fleet_groups g ORDER BY lower(g.name)`)).rows);
}

/** The default profile must exist and allow nothing the maximum does not. */
async function checkProfiles(db: Db, defaultId: string, maxId: string): Promise<void> {
  const def = await profileById(db, defaultId);
  const max = await profileById(db, maxId);
  if (!def || !max) throw new AppError(422, 'profile_not_found', 'The permission profile does not exist');
  const over = exceeding(permissionsOf(def), permissionsOf(max));
  if (over.length) {
    throw new AppError(422, 'profile_default_exceeds_max', `The default profile allows more than the maximum (${over.join(', ')})`);
  }
}

function nameTaken(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

/** What the audit keeps of a policy (every field: the policy is the security decision). */
function policySnapshot(g: Omit<FleetGroup, 'id' | 'endpoint_count' | 'created_by_email' | 'created_at' | 'updated_at'>): Record<string, unknown> {
  return {
    name: g.name,
    access_mode: g.access_mode,
    consent_timeout_s: g.consent_timeout_s,
    refuse_window_s: g.refuse_window_s,
    allowed_hours: g.allowed_hours,
    allowed_roles: g.allowed_roles,
    default_profile_id: g.default_profile_id,
    max_profile_id: g.max_profile_id,
    mfa_required: g.mfa_required,
    approval_required: g.approval_required,
    approval_ttl_minutes: g.approval_ttl_minutes,
    ip_allowlist: g.ip_allowlist,
    recording_mode: g.recording_mode,
    recording_retention_days: g.recording_retention_days,
    user_may_view_recordings: g.user_may_view_recordings,
    shell_enabled: g.shell_enabled,
    shell_idle_timeout_minutes: g.shell_idle_timeout_minutes,
    banner_mode: g.banner_mode,
  };
}

/**
 * A minimized or hidden banner is for company-owned, enrolled computers that IT reaches without
 * asking (unattended). An attended group always shows the full banner.
 */
function checkBannerMode(g: { access_mode: FleetGroup['access_mode']; banner_mode: FleetGroup['banner_mode'] }): void {
  if (g.banner_mode !== 'shown' && g.access_mode !== 'unattended') {
    throw new AppError(
      422,
      'banner_mode_needs_unattended',
      'A minimized or hidden session banner is only for unattended groups of company-managed computers. Set the access mode to unattended first, or keep the banner shown.',
    );
  }
}

export async function createGroup(req: Request, ctx: AuthContext, input: GroupCreate): Promise<FleetGroup> {
  // No banner_mode given: off for an unattended group (silent by default), shown for an attended one.
  const body = { ...input, banner_mode: input.banner_mode ?? (input.access_mode === 'unattended' ? 'off' : 'shown') } as const;
  return withTenant(ctx.organizationId, async (db) => {
    checkBannerMode(body);
    await ensureBuiltinProfiles(db, ctx.organizationId);
    const defaultId = body.default_profile_id ?? (await builtinProfile(db, 'support')).id;
    const maxId = body.max_profile_id ?? (await builtinProfile(db, 'full_admin')).id;
    await checkProfiles(db, defaultId, maxId);
    let id: string;
    try {
      id = (
        await db.query<{ id: string }>(
          `INSERT INTO fleet_groups (organization_id, name, description, color, access_mode, consent_timeout_s, refuse_window_s, allowed_hours,
                                     allowed_roles, default_profile_id, max_profile_id, mfa_required, approval_required, approval_ttl_minutes,
                                     ip_allowlist, created_by_email, recording_mode, recording_retention_days, user_may_view_recordings,
                                     shell_enabled, shell_idle_timeout_minutes, banner_mode)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::cidr[],$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
          [
            ctx.organizationId,
            body.name,
            body.description,
            body.color,
            body.access_mode,
            body.consent_timeout_s,
            body.refuse_window_s,
            JSON.stringify(body.allowed_hours),
            body.allowed_roles,
            defaultId,
            maxId,
            body.mfa_required,
            body.approval_required,
            body.approval_ttl_minutes,
            body.ip_allowlist,
            ctx.userEmail,
            body.recording_mode,
            body.recording_retention_days,
            body.user_may_view_recordings,
            body.shell_enabled,
            body.shell_idle_timeout_minutes,
            body.banner_mode,
          ],
        )
      ).rows[0]!.id;
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, 'group_name_taken', 'A group with this name already exists');
      throw err;
    }
    const g = (await groupById(db, id))!;
    await audit(db, req, 'fleet.group_created', { type: 'fleet_group', id }, { policy: policySnapshot(g) });
    return g;
  });
}

export async function updateGroup(req: Request, ctx: AuthContext, id: string, body: GroupPatch): Promise<FleetGroup> {
  return withTenant(ctx.organizationId, async (db) => {
    const cur = await groupById(db, id);
    if (!cur) throw notFound('Group');
    const next = { ...cur, ...body };
    checkBannerMode(next);
    await checkProfiles(db, next.default_profile_id, next.max_profile_id);
    try {
      await db.query(
        `UPDATE fleet_groups SET name = $2, description = $3, color = $4, access_mode = $5, consent_timeout_s = $6, refuse_window_s = $7,
                allowed_hours = $8, allowed_roles = $9, default_profile_id = $10, max_profile_id = $11, mfa_required = $12,
                approval_required = $13, approval_ttl_minutes = $14, ip_allowlist = $15::cidr[], recording_mode = $16,
                recording_retention_days = $17, user_may_view_recordings = $18, shell_enabled = $19, shell_idle_timeout_minutes = $20, banner_mode = $21, updated_at = now()
          WHERE id = $1`,
        [
          id,
          next.name,
          next.description,
          next.color,
          next.access_mode,
          next.consent_timeout_s,
          next.refuse_window_s,
          JSON.stringify(next.allowed_hours),
          next.allowed_roles,
          next.default_profile_id,
          next.max_profile_id,
          next.mfa_required,
          next.approval_required,
          next.approval_ttl_minutes,
          next.ip_allowlist,
          next.recording_mode,
          next.recording_retention_days,
          next.user_may_view_recordings,
          next.shell_enabled,
          next.shell_idle_timeout_minutes,
          next.banner_mode,
        ],
      );
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, 'group_name_taken', 'A group with this name already exists');
      throw err;
    }
    const g = (await groupById(db, id))!;
    const changed = Object.keys(body);
    const policyChanged = changed.some((k) => !['name', 'description', 'color'].includes(k));
    await audit(db, req, policyChanged ? 'fleet.policy_updated' : 'fleet.group_updated', { type: 'fleet_group', id }, { changed, before: policySnapshot(cur), after: policySnapshot(g) });
    return g;
  });
}

export async function deleteGroup(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const cur = await groupById(db, id);
    if (!cur) throw notFound('Group');
    // Its endpoints fall back to the organization default (ON DELETE SET NULL).
    await db.query(`DELETE FROM fleet_groups WHERE id = $1`, [id]);
    await audit(db, req, 'fleet.group_deleted', { type: 'fleet_group', id }, { name: cur.name, endpoints_released: cur.endpoint_count });
  });
}

export async function assignEndpoints(req: Request, ctx: AuthContext, endpointIds: string[], groupId: string | null): Promise<{ updated: number }> {
  return withTenant(ctx.organizationId, async (db) => {
    let groupName: string | null = null;
    if (groupId) {
      const g = await groupById(db, groupId);
      if (!g) throw notFound('Group');
      groupName = g.name;
    }
    const found = await db.query<{ id: string }>(`SELECT id FROM endpoints WHERE id = ANY($1::uuid[])`, [endpointIds]);
    if (found.rowCount !== endpointIds.length) throw notFound('Endpoint');
    const r = await db.query(`UPDATE endpoints SET fleet_group_id = $2 WHERE id = ANY($1::uuid[]) AND fleet_group_id IS DISTINCT FROM $2`, [endpointIds, groupId]);
    await audit(db, req, 'fleet.group_assigned', groupId ? { type: 'fleet_group', id: groupId } : null, {
      group: groupName,
      fleet_group_id: groupId,
      endpoint_ids: endpointIds,
      changed: r.rowCount ?? 0,
    });
    return { updated: r.rowCount ?? 0 };
  });
}
