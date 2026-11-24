import type { Request } from 'express';
import type { FleetSession, RemoteDesktopSession } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { openOnAgent } from '../remote-desktop/service.ts';
import { FLEET_SESSION_COLUMNS, auditEndpointEvent, endOpenSession } from '../remote-desktop/sessions.ts';

// Second-admin approval of unattended sessions (a group's policy may ask for it). The request waits
// as a fleet_sessions row in state waiting_approval; another admin (never the requester) approves
// or denies it in Fleet → Approvals. An approval left undecided expires after the group's
// approval_ttl_minutes (checked whenever approvals or the session are read). Approving sends the
// session to the computer exactly as an unapproved one would have gone (banner, refuse window).

export interface FleetApproval extends FleetSession {
  endpoint_name: string;
  operator_user_id: string | null;
}

const COLS = `${FLEET_SESSION_COLUMNS.replace(/(^|, |\n\s*)(\w+)/g, '$1f.$2')}, f.operator_user_id, e.name AS endpoint_name`;

/** Ends a waiting approval whose time ran out (true when it did). */
export async function expireApprovalIfDue(db: Db, orgId: string, fs: Pick<FleetSession, 'id' | 'public_id' | 'endpoint_id' | 'state' | 'approval_expires_at'>): Promise<boolean> {
  if (fs.state !== 'waiting_approval' || !fs.approval_expires_at || new Date(fs.approval_expires_at).getTime() > Date.now()) return false;
  await db.query(`UPDATE fleet_sessions SET approval_state = 'expired', approval_decided_at = now() WHERE id = $1 AND state = 'waiting_approval'`, [fs.id]);
  await endOpenSession(db, orgId, fs.endpoint_id, 'approval_expired', { userId: null, email: null }, fs.public_id);
  await auditEndpointEvent(db, orgId, fs.endpoint_id, 'fleet.session_approval_expired', { fleet_session_id: fs.id, session_id: fs.public_id });
  return true;
}

async function expireDue(db: Db, orgId: string): Promise<void> {
  const due = await db.query<FleetSession>(
    `SELECT ${FLEET_SESSION_COLUMNS} FROM fleet_sessions WHERE state = 'waiting_approval' AND approval_expires_at <= now() ORDER BY started_at LIMIT 100`,
  );
  for (const fs of due.rows) await expireApprovalIfDue(db, orgId, fs);
}

export async function listApprovals(ctx: AuthContext, state: 'pending' | 'decided', limit: number): Promise<FleetApproval[]> {
  return withTenant(ctx.organizationId, async (db) => {
    await expireDue(db, ctx.organizationId);
    const r = await db.query<FleetApproval>(
      `SELECT ${COLS}
         FROM fleet_sessions f JOIN endpoints e ON e.organization_id = f.organization_id AND e.id = f.endpoint_id
        WHERE ${state === 'pending' ? `f.state = 'waiting_approval'` : `f.approval_state IN ('approved', 'denied', 'expired')`}
        ORDER BY ${state === 'pending' ? 'f.started_at' : 'f.approval_decided_at DESC NULLS LAST'}
        LIMIT $1`,
      [limit],
    );
    return r.rows;
  });
}

async function lockPending(db: Db, orgId: string, ctx: AuthContext, fleetSessionId: string): Promise<FleetApproval> {
  const r = await db.query<FleetApproval>(
    `SELECT ${COLS}
       FROM fleet_sessions f JOIN endpoints e ON e.organization_id = f.organization_id AND e.id = f.endpoint_id
      WHERE f.id = $1 FOR UPDATE OF f`,
    [fleetSessionId],
  );
  const fs = r.rows[0];
  if (!fs) throw notFound('Approval request');
  if (fs.state !== 'waiting_approval') throw new AppError(409, 'approval_not_pending', 'This request is no longer waiting for approval');
  if (await expireApprovalIfDue(db, orgId, fs)) throw new AppError(409, 'approval_expired', 'This request expired before anyone approved it');
  // Two people: the requester can never approve (or deny) their own session.
  if (fs.operator_user_id === ctx.userId) throw new AppError(403, 'approval_self', 'Another admin has to decide on your own request');
  return fs;
}

export async function approveSession(req: Request, ctx: AuthContext, fleetSessionId: string, note: string | undefined): Promise<{ state: 'waiting_consent' | 'active' }> {
  // Errors that end the request (expired) must commit; they are returned and thrown afterwards.
  const result = await withTenant(ctx.organizationId, async (db): Promise<{ state: 'waiting_consent' | 'active' } | AppError> => {
    let fs: FleetApproval;
    try {
      fs = await lockPending(db, ctx.organizationId, ctx, fleetSessionId);
    } catch (err) {
      if (err instanceof AppError && err.code === 'approval_expired') return err;
      throw err;
    }
    const ep = (
      await db.query<{ id: string; site_id: string; device_id: string | null; name: string; rd_session: RemoteDesktopSession | null }>(
        `SELECT id, site_id, device_id, name, rd_session FROM endpoints WHERE id = $1 FOR UPDATE`,
        [fs.endpoint_id],
      )
    ).rows[0]!;
    if (ep.rd_session?.id !== fs.public_id) throw new AppError(409, 'approval_not_pending', 'This request is no longer waiting for approval');
    const state = fs.refuse_window_s > 0 ? 'waiting_consent' : 'active';
    await db.query(
      `UPDATE fleet_sessions SET state = $2, approval_state = 'approved', approver_user_id = $3, approver_email = $4, approval_decided_at = now(),
              approval_note = $5, accepted_at = CASE WHEN $2 = 'active' THEN now() END,
              policy_trail = policy_trail || jsonb_build_array(jsonb_build_object('check', 'approval', 'result', 'pass', 'detail', 'approved by ' || $4::text))
        WHERE id = $1`,
      [fs.id, state, ctx.userId, ctx.userEmail, note ?? null],
    );
    const session: RemoteDesktopSession = { ...ep.rd_session, state };
    await db.query(`UPDATE endpoints SET rd_session = rd_session || jsonb_build_object('state', $2::text) WHERE id = $1`, [ep.id, state]);
    await audit(db, req, 'fleet.session_approved', { type: 'endpoint', id: ep.id }, { fleet_session_id: fs.id, session_id: fs.public_id, operator: fs.operator_email, note: note ?? null });
    await openOnAgent(db, req, {
      orgId: ctx.organizationId,
      endpoint: ep,
      session,
      fleetSessionId: fs.id,
      operator: { userId: fs.operator_user_id, email: fs.operator_email ?? 'operator' },
      consentTimeoutS: fs.consent_timeout_s ?? 60,
      refuseWindowS: fs.refuse_window_s,
    });
    return { state };
  });
  if (result instanceof AppError) throw result;
  return result;
}

export async function denySession(req: Request, ctx: AuthContext, fleetSessionId: string, note: string | undefined): Promise<void> {
  const err = await withTenant(ctx.organizationId, async (db): Promise<AppError | null> => {
    let fs: FleetApproval;
    try {
      fs = await lockPending(db, ctx.organizationId, ctx, fleetSessionId);
    } catch (e) {
      if (e instanceof AppError && e.code === 'approval_expired') return e;
      throw e;
    }
    await db.query(
      `UPDATE fleet_sessions SET approval_state = 'denied', approver_user_id = $2, approver_email = $3, approval_decided_at = now(), approval_note = $4,
              policy_trail = policy_trail || jsonb_build_array(jsonb_build_object('check', 'approval', 'result', 'fail', 'detail', 'denied by ' || $3::text))
        WHERE id = $1`,
      [fs.id, ctx.userId, ctx.userEmail, note ?? null],
    );
    await endOpenSession(db, ctx.organizationId, fs.endpoint_id, 'approval_denied', { userId: ctx.userId, email: ctx.userEmail }, fs.public_id);
    await audit(db, req, 'fleet.session_approval_denied', { type: 'endpoint', id: fs.endpoint_id }, { fleet_session_id: fs.id, session_id: fs.public_id, operator: fs.operator_email, note: note ?? null });
    const site = (await db.query<{ site_id: string; device_id: string | null }>(`SELECT site_id, device_id FROM endpoints WHERE id = $1`, [fs.endpoint_id])).rows[0];
    await emitEvent(db, ctx.organizationId, {
      siteId: site?.site_id ?? null,
      deviceId: site?.device_id ?? null,
      type: 'endpoint_command',
      severity: 'info',
      title: `${ctx.userEmail} denied the remote support session on "${fs.endpoint_name}" requested by ${fs.operator_email ?? 'an operator'}`,
      details: { endpoint_id: fs.endpoint_id, session_id: fs.public_id, fleet_session_id: fs.id },
      source: 'platform',
      occurredAt: new Date(),
    });
    return null;
  });
  if (err) throw err;
}
