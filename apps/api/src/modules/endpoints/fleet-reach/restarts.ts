import type { Request } from 'express';
import type { FleetBootState, FleetRestart, FleetSession, RemoteDesktopSession } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { sessionPermissions } from '../fleet-policy/profiles.ts';
import { auditEndpointEvent, endOpenSession, fleetSessionByPublicId, FLEET_SESSION_COLUMNS } from '../remote-desktop/sessions.ts';
import { startSession } from '../remote-desktop/service.ts';

// Restart and reconnect (migration 037), normal or Safe Mode with Networking.
//
//   operator (session holder, profile "restart") → fleet_restart command → the agent answers
//   (safe mode: it set the safe-boot flag and registered its service under SafeBoot\Network, then
//   asks Windows to restart) → state restarting, the session ends with end_reason "restart"
//   → the agent's first heartbeat after the boot marks agent_back_at → the requesting operator's
//   console (polling GET …/restart) resumes the session: same reason, profile, Windows session,
//   recording rule; the policy is checked again (role, address, hours; the MFA step of the
//   original session carries over); an attended computer asks its user again.
//
// Safe boot is ALWAYS cleared afterwards: the agent clears it itself as soon as it starts after the
// restart (before anything else), and the API queues fleet_safe_boot_clear whenever a heartbeat
// still reports the flag, when the agent refuses or fails, and when the restart times out (the
// command waits for the agent's return). Nothing on this path runs bcdedit on the API's machine.

const COLUMNS = `id, endpoint_id, fleet_session_id, resumed_session_id, mode, state, requested_by_email, reason, safe_boot_set,
  safe_boot_cleared_at, agent_back_at, timeout_at, error, created_at, decided_at`;

export async function requestRestart(req: Request, ctx: AuthContext, endpointId: string, body: { mode: 'normal' | 'safe_mode'; reason: string; timeout_s: number }): Promise<FleetRestart> {
  return withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{ platform: string; rd_session: (RemoteDesktopSession & { operator_user_id?: string }) | null; service: boolean | null; kind: string }>(
        `SELECT platform, rd_session, (boot_state->>'service')::boolean AS service, kind FROM endpoints WHERE id = $1`,
        [endpointId],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    const s = ep.rd_session;
    const noSession = () => new AppError(409, 'no_remote_session', 'Restart and reconnect works from a live session');
    if (!s) throw noSession();
    if (s.state !== 'active') throw noSession();
    if (s.operator_user_id !== ctx.userId) throw new AppError(403, 'not_session_holder', 'Only the operator holding the session can restart the computer');
    if (!sessionPermissions(s).restart) throw new AppError(403, 'profile_forbids_restart', 'The permission profile of this session does not allow restarting the computer');
    if (ep.kind === 'quick_support') throw new AppError(409, 'quick_support_no_restart', 'A Quick Support computer cannot be restarted and reconnected: the program does not start again by itself');
    if (body.mode === 'safe_mode') {
      if (ep.platform !== 'windows') throw new AppError(409, 'safe_mode_windows_only', 'Safe Mode with Networking is available on Windows only');
      if (!ep.service) throw new AppError(409, 'safe_mode_needs_service', 'Safe Mode with Networking needs the Nigafiy agent installed as a service, so it can start in safe mode');
    }
    const open = await db.query(`SELECT 1 FROM fleet_restarts WHERE endpoint_id = $1 AND state IN ('queued', 'restarting')`, [endpointId]);
    if (open.rowCount) throw new AppError(409, 'restart_in_progress', 'A restart of this computer is already in progress');
    const fs = await fleetSessionByPublicId(db, endpointId, s.id);
    const row = (
      await db.query<FleetRestart & { id: string }>(
        `INSERT INTO fleet_restarts (organization_id, endpoint_id, fleet_session_id, mode, requested_by, requested_by_email, reason, timeout_s, timeout_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::int, now() + make_interval(secs => $8::int)) RETURNING ${COLUMNS}`,
        [ctx.organizationId, endpointId, fs?.id ?? null, body.mode, ctx.userId, ctx.userEmail, body.reason, body.timeout_s],
      )
    ).rows[0]!;
    const cmd = (
      await db.query<{ id: string }>(
        `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
         VALUES ($1,$2,'fleet_restart',$3,$4,$5) RETURNING id`,
        [ctx.organizationId, endpointId, JSON.stringify({ restart_id: row.id, mode: body.mode, reason: body.reason, operator: ctx.userEmail, session_id: s.id }), ctx.userId, ctx.userEmail],
      )
    ).rows[0]!;
    await db.query(`UPDATE fleet_restarts SET command_id = $2 WHERE id = $1`, [row.id, cmd.id]);
    await db.query(`UPDATE endpoints SET rd_session = rd_session || jsonb_build_object('restart_id', $2::text) WHERE id = $1`, [endpointId, row.id]);
    await audit(db, req, 'fleet.restart_requested', { type: 'endpoint', id: endpointId }, { restart_id: row.id, mode: body.mode, reason: body.reason, session_id: s.id });
    return row;
  });
}

/** The agent answered the fleet_restart / fleet_safe_boot_clear command (repo.ts applyCommandResults). */
export async function applyRestartResult(
  db: Db,
  orgId: string,
  endpointId: string,
  kind: string,
  payload: Record<string, unknown>,
  ok: boolean,
  data: Record<string, unknown> | null,
  error: string | null,
): Promise<void> {
  const restartId = typeof payload.restart_id === 'string' ? payload.restart_id : null;
  if (!restartId) return;
  if (kind === 'fleet_safe_boot_clear') {
    if (ok && data?.safe_boot_flag === false) {
      await db.query(`UPDATE fleet_restarts SET safe_boot_cleared_at = coalesce(safe_boot_cleared_at, now()) WHERE id = $1`, [restartId]);
      await auditEndpointEvent(db, orgId, endpointId, 'fleet.safe_boot_cleared', { restart_id: restartId, by: 'command' });
    } else {
      await auditEndpointEvent(db, orgId, endpointId, 'fleet.safe_boot_clear_failed', { restart_id: restartId, error: error ?? 'the agent could not confirm the flag is gone' });
    }
    return;
  }
  const safeBootSet = data?.safe_boot_set === true;
  if (!ok) {
    const r = await db.query<{ mode: string }>(
      `UPDATE fleet_restarts SET state = 'failed', error = left($2, 300), safe_boot_set = $3, decided_at = now() WHERE id = $1 AND state = 'queued' RETURNING mode`,
      [restartId, error ?? 'The agent could not restart the computer', safeBootSet],
    );
    await auditEndpointEvent(db, orgId, endpointId, 'fleet.restart_failed', { restart_id: restartId, error });
    // The agent rolls the flag back itself; make sure anyway.
    if (r.rows[0]?.mode === 'safe_mode') await queueSafeBootClear(db, orgId, endpointId, restartId);
    return;
  }
  const r = await db.query<{ fleet_session_id: string | null }>(
    `UPDATE fleet_restarts SET state = 'restarting', safe_boot_set = $2, decided_at = now() WHERE id = $1 AND state = 'queued' RETURNING fleet_session_id`,
    [restartId, safeBootSet],
  );
  if (!r.rowCount) return;
  await auditEndpointEvent(db, orgId, endpointId, 'fleet.restarting', { restart_id: restartId, safe_boot_set: safeBootSet });
  // The session cannot survive the reboot: it ends now and resumes as a new session afterwards.
  const s = await db.query<{ public_id: string }>(`SELECT public_id FROM fleet_sessions WHERE id = $1 AND state <> 'ended'`, [r.rows[0]!.fleet_session_id]);
  if (s.rows[0]) {
    const ended = await endOpenSession(db, orgId, endpointId, 'restart', { userId: null, email: null }, s.rows[0].public_id);
    if (ended) await auditEndpointEvent(db, orgId, endpointId, 'fleet.session_ended', { fleet_session_id: ended.id, session_id: ended.public_id, end_reason: 'restart', restart_id: restartId });
  }
}

async function queueSafeBootClear(db: Db, orgId: string, endpointId: string, restartId: string): Promise<void> {
  const pending = await db.query(`SELECT 1 FROM endpoint_commands WHERE endpoint_id = $1 AND kind = 'fleet_safe_boot_clear' AND status IN ('pending', 'delivered')`, [endpointId]);
  if (pending.rowCount) return;
  const c = await db.query<{ id: string }>(
    `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by_name) VALUES ($1,$2,'fleet_safe_boot_clear',$3,'Nigafiy') RETURNING id`,
    [orgId, endpointId, JSON.stringify({ restart_id: restartId })],
  );
  await db.query(`UPDATE fleet_restarts SET clear_command_id = $2 WHERE id = $1`, [restartId, c.rows[0]!.id]);
}

/**
 * Every heartbeat (agent/service.ts): the agent is back after a restart once it reports an uptime
 * shorter than the time since it acknowledged the restart. A safe-boot flag still set after the
 * restart is cleared, on every heartbeat until it is gone.
 */
export async function onHeartbeatRestarts(db: Db, orgId: string, endpointId: string, boot: FleetBootState | undefined, uptimeSeconds: number): Promise<void> {
  const open = await db.query<{ id: string; mode: string; decided_at: Date | null; agent_back_at: Date | null; safe_boot_set: boolean; safe_boot_cleared_at: Date | null; state: string }>(
    `SELECT id, mode, decided_at, agent_back_at, safe_boot_set, safe_boot_cleared_at, state FROM fleet_restarts
      WHERE endpoint_id = $1 AND (state IN ('queued', 'restarting') OR (safe_boot_set AND safe_boot_cleared_at IS NULL))
      ORDER BY created_at DESC LIMIT 3`,
    [endpointId],
  );
  for (const r of open.rows) {
    const bootedAfter = r.decided_at && Date.now() - uptimeSeconds * 1000 >= r.decided_at.getTime() - 5_000;
    if (r.state === 'restarting' && !r.agent_back_at && bootedAfter) {
      await db.query(`UPDATE fleet_restarts SET agent_back_at = now() WHERE id = $1`, [r.id]);
      await auditEndpointEvent(db, orgId, endpointId, 'fleet.restart_agent_back', { restart_id: r.id, safe_mode: boot?.safe_mode ?? null });
    }
    if (r.mode !== 'safe_mode' || r.safe_boot_cleared_at || !(r.agent_back_at || bootedAfter || r.state !== 'restarting')) continue;
    if (boot?.safe_boot_flag === false) {
      await db.query(`UPDATE fleet_restarts SET safe_boot_cleared_at = now() WHERE id = $1`, [r.id]);
      await auditEndpointEvent(db, orgId, endpointId, 'fleet.safe_boot_cleared', { restart_id: r.id, by: 'agent_start' });
    } else if (boot?.safe_boot_flag === true) {
      await queueSafeBootClear(db, orgId, endpointId, r.id);
    }
  }
}

/** Restarts past their timeout (job, and on every status read): timeout, and the flag gets cleared on return. */
export async function runRestartTimeouts(): Promise<number> {
  const due = await withSystem(
    async (db) =>
      (
        await db.query<{ id: string; organization_id: string; endpoint_id: string; mode: string }>(
          `UPDATE fleet_restarts SET state = 'timeout', decided_at = now(), error = 'The computer did not come back before the timeout'
            WHERE state IN ('queued', 'restarting') AND timeout_at <= now() RETURNING id, organization_id, endpoint_id, mode`,
        )
      ).rows,
  );
  for (const r of due) {
    await withTenant(r.organization_id, async (db) => {
      await auditEndpointEvent(db, r.organization_id, r.endpoint_id, 'fleet.restart_timeout', { restart_id: r.id });
      if (r.mode === 'safe_mode') await queueSafeBootClear(db, r.organization_id, r.endpoint_id, r.id);
    });
  }
  return due.length;
}

/**
 * The latest restart of a computer for the console. When the agent is back and the caller is the
 * operator who asked, the session resumes here (a new session, linked to the one before).
 */
export async function restartStatus(req: Request, ctx: AuthContext, endpointId: string): Promise<{ restart: FleetRestart | null; session: RemoteDesktopSession | null }> {
  await runRestartTimeouts();
  const found = await withTenant(ctx.organizationId, async (db) => {
    const r = (await db.query<FleetRestart & { requested_by: string | null }>(`SELECT ${COLUMNS}, requested_by FROM fleet_restarts WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 1`, [endpointId]))
      .rows[0];
    if (!r) return null;
    const prev = r.fleet_session_id
      ? (await db.query<FleetSession & { mfa_verified: boolean }>(`SELECT ${FLEET_SESSION_COLUMNS} FROM fleet_sessions WHERE id = $1`, [r.fleet_session_id])).rows[0]
      : undefined;
    return { r, prev };
  });
  if (!found) return { restart: null, session: null };
  const { r, prev } = found;
  if (r.state !== 'restarting' || !r.agent_back_at || r.requested_by !== ctx.userId || !prev) return { restart: stripRequester(r), session: null };
  try {
    const out = await startSession(
      req,
      ctx,
      endpointId,
      {
        reason: prev.reason ?? r.reason,
        profile_id: prev.profile_id ?? undefined,
        display_index: prev.display_index ?? 0,
        quality: prev.quality ?? 68,
        scale: prev.scale ?? 0.75,
        recording_enabled: Boolean(prev.recording_id),
        user_session: prev.user_session ?? undefined,
      },
      { resume: { fromSessionId: prev.id, restartId: r.id, mfaVerified: prev.mfa_verified } },
    );
    const done = await withTenant(ctx.organizationId, async (db) => {
      const u = await db.query<FleetRestart>(
        `UPDATE fleet_restarts SET state = 'resumed', resumed_session_id = $2 WHERE id = $1 AND state = 'restarting' RETURNING ${COLUMNS}`,
        [r.id, out.session.fleet_session_id ?? null],
      );
      await audit(db, req, 'fleet.session_resumed', { type: 'endpoint', id: endpointId }, { restart_id: r.id, resumed_from: prev.id, session_id: out.session.id });
      return u.rows[0] ?? null;
    });
    return { restart: done, session: out.session };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const failed = await withTenant(ctx.organizationId, async (db) => {
      const u = await db.query<FleetRestart>(
        `UPDATE fleet_restarts SET state = 'failed', error = left($2, 300) WHERE id = $1 AND state = 'restarting' RETURNING ${COLUMNS}`,
        [r.id, `${err.code}: ${err.message}`],
      );
      return u.rows[0] ?? null;
    });
    return { restart: failed, session: null };
  }
}

function stripRequester(r: FleetRestart & { requested_by?: string | null }): FleetRestart {
  const { requested_by: _drop, ...rest } = r;
  return rest;
}
