import type { Request } from 'express';
import type { FleetScript, FleetScriptOs, FleetScriptParam, FleetScriptVersion } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { sha256 } from '../../../common/crypto.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import type { ScriptCreate, ScriptPatch } from './schema.ts';

// Scripts library (Fleet Pro, migration 042): saved PowerShell (Windows) and /bin/sh (Linux, macOS)
// scripts with typed parameters. Every change of the body, the parameters or the timeout is a new
// version; a version never changes, so a job always runs exactly what it was created with. Admins
// create, edit and archive; technicians read and run only scripts marked technician_runnable.
// Audit rows keep the name, version and SHA-256 of the body, never the body.

export const languageFor = (os: FleetScriptOs): 'powershell' | 'sh' => (os === 'windows' ? 'powershell' : 'sh');

const SCRIPT_COLUMNS = `s.id, s.name, s.description, s.os, s.language, s.technician_runnable, s.current_version, s.archived_at,
  s.created_by_email, s.created_at, s.updated_at,
  v.version AS v_version, v.body AS v_body, v.body_sha256 AS v_body_sha256, v.parameters AS v_parameters, v.timeout_s AS v_timeout_s,
  v.note AS v_note, v.created_by_email AS v_created_by_email, v.created_at AS v_created_at`;

interface ScriptRow extends Omit<FleetScript, 'current' | 'created_at' | 'updated_at' | 'archived_at'> {
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  v_version: number;
  v_body: string;
  v_body_sha256: string;
  v_parameters: FleetScriptParam[];
  v_timeout_s: number;
  v_note: string | null;
  v_created_by_email: string;
  v_created_at: Date;
}

function present(r: ScriptRow): FleetScript {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    os: r.os,
    language: r.language,
    technician_runnable: r.technician_runnable,
    current_version: r.current_version,
    archived_at: r.archived_at ? r.archived_at.toISOString() : null,
    created_by_email: r.created_by_email,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    current: {
      version: r.v_version,
      body: r.v_body,
      body_sha256: r.v_body_sha256,
      parameters: r.v_parameters,
      timeout_s: r.v_timeout_s,
      note: r.v_note,
      created_by_email: r.v_created_by_email,
      created_at: r.v_created_at.toISOString(),
    },
  };
}

export async function scriptById(db: Db, id: string): Promise<FleetScript | null> {
  const r = await db.query<ScriptRow>(
    `SELECT ${SCRIPT_COLUMNS} FROM fleet_scripts s JOIN fleet_script_versions v ON v.script_id = s.id AND v.version = s.current_version WHERE s.id = $1`,
    [id],
  );
  return r.rows[0] ? present(r.rows[0]) : null;
}

export async function scriptVersion(db: Db, scriptId: string, version: number): Promise<FleetScriptVersion | null> {
  const r = await db.query<Omit<FleetScriptVersion, 'created_at'> & { created_at: Date }>(
    `SELECT version, body, body_sha256, parameters, timeout_s, note, created_by_email, created_at FROM fleet_script_versions WHERE script_id = $1 AND version = $2`,
    [scriptId, version],
  );
  const v = r.rows[0];
  return v ? { ...v, created_at: v.created_at.toISOString() } : null;
}

const isAdmin = (ctx: AuthContext) => ctx.role === 'owner' || ctx.role === 'admin';

/** Technicians see only the scripts they may run. */
export async function listScripts(ctx: AuthContext, q: { os?: FleetScriptOs; archived: 'true' | 'false' }): Promise<FleetScript[]> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<ScriptRow>(
      `SELECT ${SCRIPT_COLUMNS} FROM fleet_scripts s JOIN fleet_script_versions v ON v.script_id = s.id AND v.version = s.current_version
        WHERE ($1::text IS NULL OR s.os = $1) AND (s.archived_at IS NOT NULL) = $2 AND ($3 OR s.technician_runnable)
        ORDER BY lower(s.name)`,
      [q.os ?? null, q.archived === 'true', isAdmin(ctx)],
    );
    return r.rows.map(present);
  });
}

export async function getScript(ctx: AuthContext, id: string): Promise<FleetScript & { versions: Array<Omit<FleetScriptVersion, 'body'>> }> {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await scriptById(db, id);
    if (!s || (!isAdmin(ctx) && !s.technician_runnable)) throw notFound('Script');
    const v = await db.query<Omit<FleetScriptVersion, 'body' | 'created_at'> & { created_at: Date }>(
      `SELECT version, body_sha256, parameters, timeout_s, note, created_by_email, created_at FROM fleet_script_versions WHERE script_id = $1 ORDER BY version DESC`,
      [id],
    );
    return { ...s, versions: v.rows.map((x) => ({ ...x, created_at: x.created_at.toISOString() })) };
  });
}

/** One earlier version with its body (admins, and technicians for runnable scripts). */
export async function getScriptVersion(ctx: AuthContext, id: string, version: number): Promise<FleetScriptVersion> {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await scriptById(db, id);
    if (!s || (!isAdmin(ctx) && !s.technician_runnable)) throw notFound('Script');
    const v = await scriptVersion(db, id, version);
    if (!v) throw notFound('Script version');
    return v;
  });
}

function nameTaken(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

export async function createScript(req: Request, ctx: AuthContext, body: ScriptCreate): Promise<FleetScript> {
  return withTenant(ctx.organizationId, async (db) => {
    let id: string;
    try {
      id = (
        await db.query<{ id: string }>(
          `INSERT INTO fleet_scripts (organization_id, name, description, os, language, technician_runnable, created_by, created_by_email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [ctx.organizationId, body.name, body.description, body.os, languageFor(body.os), body.technician_runnable, ctx.userId, ctx.userEmail],
        )
      ).rows[0]!.id;
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, 'script_name_taken', 'A script with this name already exists');
      throw err;
    }
    const digest = sha256(body.body);
    await db.query(
      `INSERT INTO fleet_script_versions (script_id, organization_id, version, body, parameters, timeout_s, note, body_sha256, created_by_email)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`,
      [id, ctx.organizationId, body.body, JSON.stringify(body.parameters), body.timeout_s, body.note, digest, ctx.userEmail],
    );
    await audit(db, req, 'fleet.script_created', { type: 'fleet_script', id }, {
      name: body.name,
      os: body.os,
      version: 1,
      body_sha256: digest,
      body_bytes: Buffer.byteLength(body.body),
      parameters: body.parameters.map((p) => `${p.name}:${p.type}`),
      technician_runnable: body.technician_runnable,
    });
    return (await scriptById(db, id))!;
  });
}

export async function updateScript(req: Request, ctx: AuthContext, id: string, body: ScriptPatch): Promise<FleetScript> {
  return withTenant(ctx.organizationId, async (db) => {
    const cur = await scriptById(db, id);
    if (!cur) throw notFound('Script');
    if (cur.archived_at) throw new AppError(409, 'script_archived', 'This script is archived');
    const newVersion = body.body !== undefined || body.parameters !== undefined || body.timeout_s !== undefined;
    let version = cur.current_version;
    let digest = cur.current.body_sha256;
    if (newVersion) {
      const text = body.body ?? cur.current.body;
      digest = sha256(text);
      version = cur.current_version + 1;
      await db.query(
        `INSERT INTO fleet_script_versions (script_id, organization_id, version, body, parameters, timeout_s, note, body_sha256, created_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, ctx.organizationId, version, text, JSON.stringify(body.parameters ?? cur.current.parameters), body.timeout_s ?? cur.current.timeout_s, body.note ?? null, digest, ctx.userEmail],
      );
    }
    try {
      await db.query(
        `UPDATE fleet_scripts SET name = $2, description = $3, technician_runnable = $4, current_version = $5, updated_at = now() WHERE id = $1`,
        [id, body.name ?? cur.name, body.description !== undefined ? body.description : cur.description, body.technician_runnable ?? cur.technician_runnable, version],
      );
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, 'script_name_taken', 'A script with this name already exists');
      throw err;
    }
    await audit(db, req, 'fleet.script_updated', { type: 'fleet_script', id }, {
      name: body.name ?? cur.name,
      changed: Object.keys(body),
      version,
      new_version: newVersion,
      body_sha256: digest,
      technician_runnable: body.technician_runnable ?? cur.technician_runnable,
    });
    return (await scriptById(db, id))!;
  });
}

/** Archive (or restore): an archived script cannot get new jobs; its scheduled jobs are paused. */
export async function archiveScript(req: Request, ctx: AuthContext, id: string, archived: boolean): Promise<FleetScript> {
  return withTenant(ctx.organizationId, async (db) => {
    const cur = await scriptById(db, id);
    if (!cur) throw notFound('Script');
    try {
      await db.query(`UPDATE fleet_scripts SET archived_at = CASE WHEN $2 THEN coalesce(archived_at, now()) END, updated_at = now() WHERE id = $1`, [id, archived]);
    } catch (err) {
      if (nameTaken(err)) throw new AppError(409, 'script_name_taken', 'A script with this name already exists');
      throw err;
    }
    let paused = 0;
    if (archived) {
      paused = (await db.query(`UPDATE fleet_jobs SET state = 'paused', updated_at = now() WHERE script_id = $1 AND state = 'active' AND schedule_kind <> 'now'`, [id])).rowCount ?? 0;
    }
    await audit(db, req, archived ? 'fleet.script_archived' : 'fleet.script_restored', { type: 'fleet_script', id }, { name: cur.name, jobs_paused: paused });
    return (await scriptById(db, id))!;
  });
}
