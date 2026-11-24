import type { Request } from 'express';
import type { FleetItActivityItem, FleetPermissionProfile, FleetShellEndReason, FleetShellSession, FleetShellTranscriptChunk } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { randomToken } from '../../../common/crypto.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { ONLINE_WITHIN_MS } from '../repo.ts';
import type { EndpointContext } from '../schema.ts';
import { effectivePolicy, evaluatePolicy, loadProfiles, normalizeIp } from '../fleet-policy/policy.ts';
import { checkStepUpToken, operatorHasMfa } from '../fleet-policy/step-up.ts';
import { newTranscriptKey, openChunk, openTranscriptKey, sealChunk } from './transcript.ts';
import type { ShellOpen } from './schema.ts';

// Remote shell (Fleet Pro, migration 042): an interactive PowerShell (Windows) or the agent
// account's shell (Linux, macOS) through the agent's WebSocket (hub.ts).
//
// Who may open one: admins (and owners) only; the computer's fleet group must have the shell
// switched on (it is off by default, and a computer in no group never gets one); the group's access
// policy applies (operator roles, address, hours, MFA step-up when the policy asks); the profile
// picked (up to the group's maximum) must have the `shell` flag. Each refusal is audited as
// fleet.policy_refused with its code.
//
// While a shell is open the person at the computer sees "Shell open by <operator>" on the session
// bar, with End, and it is listed in their IT activity. Everything typed and printed is kept in an
// encrypted transcript (transcript.ts), linked from the audit rows; the plain audit log never
// holds it. A shell ends on End (operator or person), when the shell exits, after the group's idle
// timeout, when the transcript reaches its size limit, or when the agent's socket goes.

export const SHELL_CHANNEL = 'ld_fleet_shell';
/** Most open shells per computer. */
export const MAX_OPEN_PER_ENDPOINT = 3;
/** Transcript size limit: the shell ends (it never runs unrecorded). */
export const MAX_TRANSCRIPT_BYTES = 32 << 20;
/** An "opening" shell the agent never connected ends after this. */
const OPEN_TIMEOUT_S = 90;

export type ShellRefusal =
  | 'shell_admin_only'
  | 'shell_disabled_by_policy'
  | 'profile_forbids_shell'
  | 'too_many_shells'
  | 'quick_support_limited';

export const SHELL_MESSAGES: Record<ShellRefusal, string> = {
  shell_admin_only: 'Only an admin can open a remote shell',
  shell_disabled_by_policy: 'The remote shell is switched off for this computer (turn it on in its group’s access policy)',
  profile_forbids_shell: 'The permission profile does not allow the remote shell',
  too_many_shells: `At most ${MAX_OPEN_PER_ENDPOINT} shells can be open on one computer`,
  quick_support_limited: 'A Quick Support computer allows the session and its files only',
};

export const SHELL_COLUMNS = `sh.id, sh.public_id, sh.endpoint_id, e.name AS endpoint_name, sh.operator_id, sh.operator_email, sh.reason, sh.profile_name,
  sh.fleet_group_id, sh.mfa_verified, sh.state, sh.shell, sh.pty, sh.cols, sh.rows, sh.idle_timeout_s, sh.max_transcript_bytes,
  sh.transcript_chunks, sh.bytes_in::float8 AS bytes_in, sh.bytes_out::float8 AS bytes_out, sh.created_at, sh.opened_at, sh.last_activity_at,
  sh.ended_at, sh.end_reason, sh.ended_by, sh.exit_code, sh.error`;
const SHELL_FROM = `fleet_shell_sessions sh JOIN endpoints e ON e.id = sh.endpoint_id`;

const isAdmin = (role: string) => role === 'owner' || role === 'admin';

/** Shell audit rows always carry the link to the transcript (the transcript itself stays encrypted). */
export const transcriptLink = (endpointId: string, shellId: string) => `/fleet/endpoints/${endpointId}/shell/${shellId}`;

async function auditShellEvent(db: Db, orgId: string, endpointId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
     VALUES ($1, NULL, NULL, $2, 'endpoint', $3, $4, 'system')`,
    [orgId, action, endpointId, JSON.stringify({ ...metadata, source: 'fleet_shell' })],
  );
}

export async function shellById(db: Db, id: string): Promise<FleetShellSession | null> {
  return (await db.query<FleetShellSession>(`SELECT ${SHELL_COLUMNS} FROM ${SHELL_FROM} WHERE sh.id = $1`, [id])).rows[0] ?? null;
}

/** Writes one transcript event ("opened", "ended: idle") with the next sequence number. */
export async function transcriptEvent(db: Db, orgId: string, shell: { id: string; public_id: string }, keySealed: string, text: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [shell.id]);
  const seq = (await db.query<{ n: number }>(`SELECT coalesce(max(seq) + 1, 0)::int AS n FROM fleet_shell_transcript WHERE shell_id = $1`, [shell.id])).rows[0]!.n;
  const key = openTranscriptKey(keySealed);
  await db.query(`INSERT INTO fleet_shell_transcript (shell_id, organization_id, seq, direction, at, ciphertext) VALUES ($1,$2,$3,'e',now(),$4)`, [
    shell.id,
    orgId,
    seq,
    sealChunk(key, shell.public_id, seq, 'e', Buffer.from(text, 'utf8')),
  ]);
  await db.query(`UPDATE fleet_shell_sessions SET transcript_chunks = transcript_chunks + 1 WHERE id = $1`, [shell.id]);
}

type Refused = { refused: true; status: number; code: string; message: string; trail: unknown[]; group: string | null };

export async function openShell(req: Request, ctx: AuthContext, endpointId: string, body: ShellOpen): Promise<FleetShellSession> {
  const requestIp = normalizeIp(req.ip);
  const stepUp = checkStepUpToken(body.step_up_token, ctx);
  const hasMfa = await operatorHasMfa(ctx.userId);
  const out = await withTenant(ctx.organizationId, async (db): Promise<Refused | { refused: false; shell: FleetShellSession }> => {
    const ep = (
      await db.query<{ id: string; name: string; platform: string; status: string; last_heartbeat_at: Date | null; kind: string; shell_enabled: boolean | null; idle_min: number | null }>(
        `SELECT e.id, e.name, e.platform, e.status, e.last_heartbeat_at, e.kind, g.shell_enabled, g.shell_idle_timeout_minutes AS idle_min
           FROM endpoints e LEFT JOIN fleet_groups g ON g.organization_id = e.organization_id AND g.id = e.fleet_group_id
          WHERE e.id = $1`,
        [endpointId],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    const refuse = (status: number, code: string, message: string, trail: unknown[] = [], group: string | null = null): Refused => ({ refused: true, status, code, message, trail, group });
    if (ep.kind === 'quick_support') return refuse(409, 'quick_support_limited', SHELL_MESSAGES.quick_support_limited);
    if (!isAdmin(ctx.role)) return refuse(403, 'shell_admin_only', SHELL_MESSAGES.shell_admin_only);
    const eff = (await effectivePolicy(db, ctx.organizationId, endpointId))!;
    // Off in the default policy: only a group with the switch on allows a shell.
    if (eff.source !== 'group' || !ep.shell_enabled) {
      return refuse(403, 'shell_disabled_by_policy', SHELL_MESSAGES.shell_disabled_by_policy, [{ check: 'shell', result: 'fail', detail: eff.source === 'group' ? 'off for the group' : 'no group (organization default: off)' }], eff.group?.name ?? null);
    }
    const { requested, max } = await loadProfiles(db, eff.policy, body.profile_id);
    if (!requested) throw new AppError(422, 'profile_not_found', 'The permission profile does not exist');
    // The shell does not need to see the screen: evaluate role, address, hours and MFA with "view" set.
    const asShell = (p: FleetPermissionProfile): FleetPermissionProfile => ({ ...p, view: true });
    const decision = evaluatePolicy({
      policy: eff.policy,
      timezone: eff.timezone,
      role: ctx.role,
      requestIp,
      now: new Date(),
      operatorHasMfa: hasMfa,
      stepUp,
      requested: asShell(requested),
      max: asShell(max),
    });
    if (!decision.ok) return refuse(403, decision.code, decision.message, decision.trail, eff.group?.name ?? null);
    if (!decision.permissions.shell) {
      return refuse(403, 'profile_forbids_shell', SHELL_MESSAGES.profile_forbids_shell, [...decision.trail, { check: 'shell', result: 'fail', detail: `${requested.name} (max ${max.name}) has no shell` }], eff.group?.name ?? null);
    }
    if (ep.status !== 'active' || !ep.last_heartbeat_at || ep.last_heartbeat_at.getTime() < Date.now() - ONLINE_WITHIN_MS) {
      throw new AppError(409, 'endpoint_offline', 'This endpoint is not currently online');
    }
    const open = await db.query(`SELECT 1 FROM fleet_shell_sessions WHERE endpoint_id = $1 AND state <> 'closed'`, [endpointId]);
    if ((open.rowCount ?? 0) >= MAX_OPEN_PER_ENDPOINT) return refuse(409, 'too_many_shells', SHELL_MESSAGES.too_many_shells);

    const trail = [...decision.trail, { check: 'shell', result: 'pass', detail: `on for ${eff.group!.name}; ${requested.name}${decision.clamped.length ? ` limited by ${max.name}` : ''}` }];
    const publicId = randomToken(18);
    const { sealed } = newTranscriptKey();
    const idleS = (ep.idle_min ?? 15) * 60;
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO fleet_shell_sessions (organization_id, endpoint_id, public_id, operator_id, operator_email, reason, fleet_group_id, profile_id, profile_name,
                                           policy_trail, mfa_verified, request_ip, cols, rows, idle_timeout_s, max_transcript_bytes, transcript_key_sealed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          ctx.organizationId,
          endpointId,
          publicId,
          ctx.userId,
          ctx.userEmail,
          body.reason,
          eff.group!.id,
          requested.id,
          requested.name,
          JSON.stringify(trail),
          decision.mfaVerified,
          requestIp,
          body.cols,
          body.rows,
          idleS,
          MAX_TRANSCRIPT_BYTES,
          sealed,
        ],
      )
    ).rows[0]!.id;
    await transcriptEvent(db, ctx.organizationId, { id, public_id: publicId }, sealed, `opened by ${ctx.userEmail}; reason: ${body.reason}`);
    const cmd = (
      await db.query<{ id: string }>(
        `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name) VALUES ($1,$2,'shell_open',$3,$4,$5) RETURNING id`,
        [
          ctx.organizationId,
          endpointId,
          JSON.stringify({ shell_id: publicId, operator: ctx.userEmail, reason: body.reason, cols: body.cols, rows: body.rows, idle_timeout_s: idleS, max_transcript_bytes: MAX_TRANSCRIPT_BYTES }),
          ctx.userId,
          ctx.userEmail,
        ],
      )
    ).rows[0]!.id;
    await db.query(`UPDATE fleet_shell_sessions SET command_id = $2 WHERE id = $1`, [id, cmd]);
    await audit(db, req, 'fleet.shell_opened', { type: 'endpoint', id: endpointId }, {
      shell_id: id,
      reason: body.reason,
      profile: requested.name,
      group: eff.group!.name,
      mfa_verified: decision.mfaVerified,
      trail,
      transcript: transcriptLink(endpointId, id),
    });
    return { refused: false, shell: (await shellById(db, id))! };
  });
  if (out.refused) {
    await withTenant(ctx.organizationId, (db) =>
      audit(db, req, 'fleet.policy_refused', { type: 'endpoint', id: endpointId }, { code: out.code, what: 'shell', group: out.group, trail: out.trail, reason: body.reason }),
    );
    throw new AppError(out.status, out.code, out.message);
  }
  return out.shell;
}

/**
 * Ends a shell (once): the row is closed, the event goes into the transcript, the agent is told
 * (`shell_close`; the hub also closes the sockets on every API instance through SHELL_CHANNEL), and
 * the end is audited with the transcript link. Returns false when it was already closed.
 */
export async function endShell(
  db: Db,
  orgId: string,
  shellId: string,
  reason: FleetShellEndReason,
  by: { userId: string; email: string; req?: Request } | { system: string },
  extra: { exitCode?: number | null; error?: string | null } = {},
): Promise<boolean> {
  const r = await db.query<{ id: string; public_id: string; endpoint_id: string; transcript_key_sealed: string; bytes_in: number; bytes_out: number; created_at: Date }>(
    `UPDATE fleet_shell_sessions
        SET state = 'closed', ended_at = now(), end_reason = $2, ended_by = $3, exit_code = $4, error = $5
      WHERE id = $1 AND state <> 'closed'
      RETURNING id, public_id, endpoint_id, transcript_key_sealed, bytes_in::float8 AS bytes_in, bytes_out::float8 AS bytes_out, created_at`,
    [shellId, reason, 'email' in by ? by.email : by.system, extra.exitCode ?? null, extra.error?.slice(0, 500) ?? null],
  );
  const row = r.rows[0];
  if (!row) return false;
  await transcriptEvent(db, orgId, row, row.transcript_key_sealed, `ended: ${reason}${extra.exitCode !== undefined && extra.exitCode !== null ? ` (exit code ${extra.exitCode})` : ''}`);
  await db.query(
    `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name) VALUES ($1,$2,'shell_close',$3,$4,$5)`,
    [orgId, row.endpoint_id, JSON.stringify({ shell_id: row.public_id, reason }), 'userId' in by ? by.userId : null, 'email' in by ? by.email : 'Nigafiy'],
  );
  await db.query('SELECT pg_notify($1, $2)', [SHELL_CHANNEL, `end|${row.public_id}|${reason}`]);
  const meta = {
    shell_id: row.id,
    end_reason: reason,
    exit_code: extra.exitCode ?? null,
    bytes_in: row.bytes_in,
    bytes_out: row.bytes_out,
    duration_s: Math.round((Date.now() - row.created_at.getTime()) / 1000),
    transcript: transcriptLink(row.endpoint_id, row.id),
  };
  if ('req' in by && by.req) await audit(db, by.req, 'fleet.shell_closed', { type: 'endpoint', id: row.endpoint_id }, meta);
  else await auditShellEvent(db, orgId, row.endpoint_id, 'fleet.shell_closed', { ...meta, ended_by: 'email' in by ? by.email : by.system });
  return true;
}

export async function closeShell(req: Request, ctx: AuthContext, endpointId: string, shellId: string): Promise<FleetShellSession> {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await shellById(db, shellId);
    if (!s || s.endpoint_id !== endpointId) throw notFound('Shell');
    // The operator who opened it, or any admin.
    if (s.operator_id !== ctx.userId && !isAdmin(ctx.role)) throw new AppError(403, 'forbidden', 'You do not have permission to do this');
    await endShell(db, ctx.organizationId, shellId, 'operator', { userId: ctx.userId, email: ctx.userEmail, req });
    return (await shellById(db, shellId))!;
  });
}

/** The agent could not start the shell (old agent, no shell program, ...). */
export async function applyShellOpenFailure(db: Db, orgId: string, _endpointId: string, payload: Record<string, unknown>, error: string | null): Promise<void> {
  const publicId = typeof payload.shell_id === 'string' ? payload.shell_id : null;
  if (!publicId) return;
  const s = (await db.query<{ id: string }>(`SELECT id FROM fleet_shell_sessions WHERE public_id = $1`, [publicId])).rows[0];
  if (s) await endShell(db, orgId, s.id, 'open_failed', { system: 'agent' }, { error: error ?? 'The agent could not start the shell' });
}

/** POST /api/v1/agent/shell-end: the shell ended on the computer. */
export async function agentShellEnd(ep: EndpointContext, publicId: string, reason: 'user' | 'exited' | 'idle' | 'limit' | 'agent_gone', exitCode: number | null): Promise<boolean> {
  return withTenant(ep.organizationId, async (db) => {
    const s = (await db.query<{ id: string }>(`SELECT id FROM fleet_shell_sessions WHERE public_id = $1 AND endpoint_id = $2`, [publicId, ep.id])).rows[0];
    if (!s) return false;
    return endShell(db, ep.organizationId, s.id, reason, { system: reason === 'user' ? 'endpoint user' : 'agent' }, { exitCode });
  });
}

export async function listShells(ctx: AuthContext, q: { endpoint_id?: string; state?: string; limit: number }): Promise<FleetShellSession[]> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<FleetShellSession>(
      `SELECT ${SHELL_COLUMNS} FROM ${SHELL_FROM}
        WHERE ($1::uuid IS NULL OR sh.endpoint_id = $1) AND ($2::text IS NULL OR sh.state = $2)
        ORDER BY sh.created_at DESC LIMIT $3`,
      [q.endpoint_id ?? null, q.state ?? null, q.limit],
    );
    return r.rows;
  });
}

export async function getShell(ctx: AuthContext, endpointId: string, shellId: string): Promise<FleetShellSession> {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await shellById(db, shellId);
    if (!s || s.endpoint_id !== endpointId) throw notFound('Shell');
    return s;
  });
}

/** The decrypted transcript (admins only; every read is audited). */
export async function readTranscript(req: Request, ctx: AuthContext, endpointId: string, shellId: string): Promise<{ shell: FleetShellSession; chunks: FleetShellTranscriptChunk[]; unreadable: number }> {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await shellById(db, shellId);
    if (!s || s.endpoint_id !== endpointId) throw notFound('Shell');
    const key = openTranscriptKey((await db.query<{ k: string }>(`SELECT transcript_key_sealed AS k FROM fleet_shell_sessions WHERE id = $1`, [shellId])).rows[0]!.k);
    const rows = await db.query<{ seq: number; direction: 'i' | 'o' | 'e'; at: Date; ciphertext: Buffer }>(
      `SELECT seq, direction, at, ciphertext FROM fleet_shell_transcript WHERE shell_id = $1 ORDER BY at, seq`,
      [shellId],
    );
    let unreadable = 0;
    const chunks: FleetShellTranscriptChunk[] = [];
    for (const r of rows.rows) {
      const plain = openChunk(key, s.public_id, r.seq, r.direction, r.ciphertext);
      if (!plain) {
        unreadable++;
        continue;
      }
      chunks.push({ seq: r.seq, direction: r.direction, at: r.at.toISOString(), text: plain.toString('utf8') });
    }
    await audit(db, req, 'fleet.shell_transcript_viewed', { type: 'endpoint', id: endpointId }, { shell_id: shellId, chunks: chunks.length, unreadable });
    return { shell: s, chunks, unreadable };
  });
}

/** Shells the agent never connected, and shells idle past their timeout on no instance's watch. */
export async function runShellSweep(): Promise<number> {
  const due = await withSystem(
    async (db) =>
      (
        await db.query<{ id: string; organization_id: string; why: 'open_failed' | 'idle' }>(
          `SELECT id, organization_id, CASE WHEN state = 'opening' THEN 'open_failed' ELSE 'idle' END AS why
             FROM fleet_shell_sessions
            WHERE (state = 'opening' AND created_at < now() - make_interval(secs => $1))
               OR (state = 'open' AND last_activity_at < now() - make_interval(secs => idle_timeout_s + 60))
            LIMIT 200`,
          [OPEN_TIMEOUT_S],
        )
      ).rows,
  );
  for (const d of due) {
    await withTenant(d.organization_id, (db) =>
      endShell(db, d.organization_id, d.id, d.why, { system: 'Nigafiy' }, d.why === 'open_failed' ? { error: 'The agent did not open the shell in time' } : {}),
    );
  }
  return due.length;
}

/**
 * The person's "IT activity" list (agent tray): remote sessions, shells and jobs on this computer
 * in the last 30 days, newest first, by whom. Nothing here can be switched off.
 */
export async function itActivity(ep: EndpointContext): Promise<FleetItActivityItem[]> {
  return withTenant(ep.organizationId, async (db) => {
    const r = await db.query<{ kind: FleetItActivityItem['kind']; by: string; what: string; reason: string | null; at: Date; ended_at: Date | null }>(
      `(SELECT 'session' AS kind, coalesce(operator_email, 'IT') AS by, 'Remote support session' AS what, reason, started_at AS at, ended_at
          FROM fleet_sessions WHERE endpoint_id = $1 AND started_at > now() - interval '30 days')
       UNION ALL
       (SELECT 'shell', operator_email, 'Remote shell', reason, created_at, ended_at
          FROM fleet_shell_sessions WHERE endpoint_id = $1 AND created_at > now() - interval '30 days')
       UNION ALL
       (SELECT 'job', j.created_by_email, 'Script: ' || s.name, j.name, coalesce(r.queued_at, r.created_at), r.finished_at
          FROM fleet_job_results r JOIN fleet_jobs j ON j.id = r.job_id JOIN fleet_scripts s ON s.id = j.script_id
         WHERE r.endpoint_id = $1 AND r.queued_at IS NOT NULL AND r.created_at > now() - interval '30 days')
       UNION ALL
       -- File manager transfers (one row per file and hour; the audit has one row per chunk).
       (SELECT 'file_transfer', coalesce(user_email, 'IT'),
               CASE WHEN metadata->>'op' = 'upload' THEN 'File sent to this computer: ' ELSE 'File copied from this computer: ' END || coalesce(metadata->>'path', ''),
               NULL, min(created_at), max(created_at)
          FROM audit_logs
         WHERE target_type = 'endpoint' AND target_id = $1::text AND action = 'endpoint.fs_op' AND metadata->>'op' IN ('upload', 'download')
           AND created_at > now() - interval '30 days'
         GROUP BY metadata->>'op', metadata->>'path', user_email, date_trunc('hour', created_at))
       UNION ALL
       -- Files sent or received in a remote support session.
       (SELECT 'file_transfer', coalesce(user_email, 'IT'),
               CASE WHEN metadata->>'direction' = 'to_remote' THEN 'File sent to this computer: ' ELSE 'File copied from this computer: ' END || coalesce(metadata->>'name', ''),
               NULL, created_at, created_at
          FROM audit_logs
         WHERE target_type = 'endpoint' AND target_id = $1::text AND action = 'fleet.session_file_transfer' AND created_at > now() - interval '30 days')
       UNION ALL
       -- Update installs (patch policy): when, which updates, and the window.
       (SELECT 'patch', 'Nigafiy patching',
               'Updates: ' || (SELECT string_agg(coalesce(u->>'kb', u->>'title'), ', ') FROM jsonb_array_elements(i.updates) u),
               i.window_label, i.queued_at, i.finished_at
          FROM fleet_patch_installs i WHERE i.endpoint_id = $1 AND i.queued_at > now() - interval '30 days')
       ORDER BY at DESC LIMIT 40`,
      [ep.id],
    );
    return r.rows.map((x) => ({ ...x, at: x.at.toISOString(), ended_at: x.ended_at ? x.ended_at.toISOString() : null }));
  });
}

