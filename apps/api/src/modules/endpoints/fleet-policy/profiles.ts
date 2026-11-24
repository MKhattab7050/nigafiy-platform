import type { Request } from 'express';
import { FLEET_PERMISSION_KEYS, type FleetBuiltinProfileKey, type FleetPermissionKey, type FleetPermissionProfile, type FleetPermissions } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import type { ProfileCreate, ProfilePatch } from './schema.ts';

// Permission profiles (migration 035): what an operator may do inside a session. The three
// built-ins are seeded per organization (fleet_seed_builtin_profiles) and are read-only: the API
// refuses changes and RLS refuses UPDATE/DELETE of a built-in row for the app role as well.

const PROFILE_COLUMNS = `p.id, p.builtin_key, p.name, p.description, ${FLEET_PERMISSION_KEYS.map((k) => `p.${k}`).join(', ')},
  p.created_by_email, p.created_at, p.updated_at,
  (SELECT count(*)::int FROM fleet_groups g WHERE g.organization_id = p.organization_id AND (g.default_profile_id = p.id OR g.max_profile_id = p.id)) AS used_by_groups`;

/** Built-ins first (in the mockup's order), then custom profiles by name. */
const PROFILE_ORDER = `CASE p.builtin_key WHEN 'view_only' THEN 0 WHEN 'support' THEN 1 WHEN 'full_admin' THEN 2 ELSE 3 END, lower(p.name)`;

/** Makes sure the organization has its built-ins (organizations created after migration 035). */
export async function ensureBuiltinProfiles(db: Db, orgId: string): Promise<void> {
  const has = await db.query(`SELECT 1 FROM fleet_permission_profiles WHERE builtin_key = 'full_admin' LIMIT 1`);
  if (!has.rowCount) await db.query('SELECT fleet_seed_builtin_profiles($1)', [orgId]);
}

export function permissionsOf(p: FleetPermissions): FleetPermissions {
  return Object.fromEntries(FLEET_PERMISSION_KEYS.map((k) => [k, Boolean(p[k])])) as FleetPermissions;
}

/** Flags of `p` that `max` does not allow. */
export function exceeding(p: FleetPermissions, max: FleetPermissions): FleetPermissionKey[] {
  return FLEET_PERMISSION_KEYS.filter((k) => p[k] && !max[k]);
}

/** `p` limited to what `max` allows (a flag is granted only when both have it). */
export function clampPermissions(p: FleetPermissions, max: FleetPermissions): FleetPermissions {
  return Object.fromEntries(FLEET_PERMISSION_KEYS.map((k) => [k, Boolean(p[k] && max[k])])) as FleetPermissions;
}

/**
 * The permissions of a session from its rd_session cache. A session without them (none exist after
 * migration 035 backfilled the open ones) gets view only: nothing more is granted by accident.
 */
export function sessionPermissions(s: { permissions?: Partial<FleetPermissions> | null } | null | undefined): FleetPermissions {
  const p = s?.permissions;
  if (!p) return Object.fromEntries(FLEET_PERMISSION_KEYS.map((k) => [k, k === 'view'])) as FleetPermissions;
  return Object.fromEntries(FLEET_PERMISSION_KEYS.map((k) => [k, p[k] === true])) as FleetPermissions;
}

export async function listProfilesIn(db: Db): Promise<FleetPermissionProfile[]> {
  return (await db.query<FleetPermissionProfile>(`SELECT ${PROFILE_COLUMNS} FROM fleet_permission_profiles p ORDER BY ${PROFILE_ORDER}`)).rows;
}

export async function profileById(db: Db, id: string): Promise<FleetPermissionProfile | null> {
  return (await db.query<FleetPermissionProfile>(`SELECT ${PROFILE_COLUMNS} FROM fleet_permission_profiles p WHERE p.id = $1`, [id])).rows[0] ?? null;
}

export async function builtinProfile(db: Db, key: FleetBuiltinProfileKey): Promise<FleetPermissionProfile> {
  const r = await db.query<FleetPermissionProfile>(`SELECT ${PROFILE_COLUMNS} FROM fleet_permission_profiles p WHERE p.builtin_key = $1`, [key]);
  if (!r.rows[0]) throw new AppError(500, 'profiles_missing', 'The built-in permission profiles are missing');
  return r.rows[0];
}

export async function listProfiles(ctx: AuthContext): Promise<FleetPermissionProfile[]> {
  return withTenant(ctx.organizationId, async (db) => {
    await ensureBuiltinProfiles(db, ctx.organizationId);
    return listProfilesIn(db);
  });
}

function nameTaken(err: unknown): boolean {
  return (err as { code?: string; constraint?: string }).code === '23505';
}

export async function createProfile(req: Request, ctx: AuthContext, body: ProfileCreate): Promise<FleetPermissionProfile> {
  return withTenant(ctx.organizationId, async (db) => {
    await ensureBuiltinProfiles(db, ctx.organizationId);
    const flags = permissionsOf(body);
    let id: string;
    try {
      id = (
        await db.query<{ id: string }>(
          `INSERT INTO fleet_permission_profiles (organization_id, name, description, ${FLEET_PERMISSION_KEYS.join(', ')}, created_by_email)
           VALUES ($1, $2, $3, ${FLEET_PERMISSION_KEYS.map((_, i) => `$${i + 4}`).join(', ')}, $${FLEET_PERMISSION_KEYS.length + 4}) RETURNING id`,
          [ctx.organizationId, body.name, body.description, ...FLEET_PERMISSION_KEYS.map((k) => flags[k]), ctx.userEmail],
        )
      ).rows[0]!.id;
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, 'profile_name_taken', 'A permission profile with this name already exists');
      throw err;
    }
    await audit(db, req, 'fleet.profile_created', { type: 'fleet_profile', id }, { name: body.name, permissions: flags });
    return (await profileById(db, id))!;
  });
}

export async function updateProfile(req: Request, ctx: AuthContext, id: string, body: ProfilePatch): Promise<FleetPermissionProfile> {
  return withTenant(ctx.organizationId, async (db) => {
    const cur = await profileById(db, id);
    if (!cur) throw notFound('Permission profile');
    if (cur.builtin_key) throw new AppError(409, 'profile_builtin', 'Built-in profiles cannot be changed. Create a custom profile instead.');
    const next = { ...cur, ...body };
    const flags = permissionsOf(next);
    // A group's default profile must stay within its maximum.
    const groups = await db.query<{ name: string; default_profile_id: string; max_profile_id: string }>(
      `SELECT name, default_profile_id, max_profile_id FROM fleet_groups WHERE default_profile_id = $1 OR max_profile_id = $1`,
      [id],
    );
    for (const g of groups.rows) {
      const def = g.default_profile_id === id ? flags : permissionsOf((await profileById(db, g.default_profile_id))!);
      const max = g.max_profile_id === id ? flags : permissionsOf((await profileById(db, g.max_profile_id))!);
      if (exceeding(def, max).length) {
        throw new AppError(409, 'profile_default_exceeds_max', `This change would give the group "${g.name}" a default profile that allows more than its maximum`);
      }
    }
    try {
      await db.query(
        `UPDATE fleet_permission_profiles SET name = $2, description = $3, ${FLEET_PERMISSION_KEYS.map((k, i) => `${k} = $${i + 4}`).join(', ')}, updated_at = now()
          WHERE id = $1`,
        [id, next.name, next.description, ...FLEET_PERMISSION_KEYS.map((k) => flags[k])],
      );
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, 'profile_name_taken', 'A permission profile with this name already exists');
      throw err;
    }
    await audit(db, req, 'fleet.profile_updated', { type: 'fleet_profile', id }, { name: next.name, before: permissionsOf(cur), after: flags });
    return (await profileById(db, id))!;
  });
}

export async function deleteProfile(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const cur = await profileById(db, id);
    if (!cur) throw notFound('Permission profile');
    if (cur.builtin_key) throw new AppError(409, 'profile_builtin', 'Built-in profiles cannot be deleted');
    if (cur.used_by_groups > 0) throw new AppError(409, 'profile_in_use', 'Groups use this profile as their default or maximum. Change those groups first.');
    await db.query(`DELETE FROM fleet_permission_profiles WHERE id = $1`, [id]);
    await audit(db, req, 'fleet.profile_deleted', { type: 'fleet_profile', id }, { name: cur.name, permissions: permissionsOf(cur) });
  });
}
