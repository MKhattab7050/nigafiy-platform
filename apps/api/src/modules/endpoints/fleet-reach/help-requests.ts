import type { Request } from 'express';
import type { FleetHelpRequest, RemoteDesktopFrame, RemoteDesktopSession } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import type { EndpointContext } from '../schema.ts';
import type { RdStart } from '../remote-desktop/schema.ts';
import { auditEndpointEvent } from '../remote-desktop/sessions.ts';
import { startSession } from '../remote-desktop/service.ts';

// "Request help" from the agent's tray (migration 037). The person types a note; the request is
// listed in Fleet → Requests and raised as a Watch event; an operator starts an ATTENDED session
// from it (the person accepts in the consent dialog whatever the computer's policy says), or
// closes it with a note. Every step is audited.

const COLUMNS = `h.id, h.endpoint_id, e.name AS endpoint_name, e.nigafiy_id, h.note, h.requested_by, h.state, h.created_at,
  h.handled_by_email, h.handled_at, h.close_note, h.fleet_session_id, e.connection_state`;

/** At most this many open requests per computer (a stuck key on the tray menu cannot flood Fleet). */
const MAX_OPEN_PER_ENDPOINT = 5;

export async function createHelpRequest(ep: EndpointContext, note: string, user: string | undefined): Promise<{ id: string }> {
  return withTenant(ep.organizationId, async (db) => {
    const open = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM fleet_help_requests WHERE endpoint_id = $1 AND state = 'open'`, [ep.id]);
    if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_PER_ENDPOINT) throw new AppError(429, 'too_many_help_requests', 'This computer already has several open help requests');
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO fleet_help_requests (organization_id, endpoint_id, note, requested_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [ep.organizationId, ep.id, note, user ?? null],
      )
    ).rows[0]!;
    await auditEndpointEvent(db, ep.organizationId, ep.id, 'fleet.help_requested', { help_request_id: row.id, requested_by: user ?? null, note_length: note.length });
    // The Watch item.
    await emitEvent(db, ep.organizationId, {
      siteId: ep.siteId,
      deviceId: ep.deviceId,
      type: 'endpoint_command',
      severity: 'warning',
      title: `${user ? `${user} at` : 'The user at'} "${ep.name}" asked for IT help`,
      details: { endpoint_id: ep.id, help_request_id: row.id, note, requested_by: user ?? null },
      source: 'platform',
      occurredAt: new Date(),
    });
    await notifyRealtime(db, ep.organizationId, 'devices');
    return row;
  });
}

export async function listHelpRequests(ctx: AuthContext, state: 'open' | 'in_session' | 'closed' | 'all', limit: number): Promise<FleetHelpRequest[]> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<FleetHelpRequest>(
      `SELECT ${COLUMNS} FROM fleet_help_requests h JOIN endpoints e ON e.organization_id = h.organization_id AND e.id = h.endpoint_id
        WHERE ($1::text = 'all' OR h.state = $1) ORDER BY h.created_at DESC LIMIT $2`,
      [state, limit],
    );
    return r.rows;
  });
}

export async function closeHelpRequest(req: Request, ctx: AuthContext, id: string, note: string | undefined): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<{ endpoint_id: string }>(
      `UPDATE fleet_help_requests SET state = 'closed', handled_by = $2, handled_by_email = $3, handled_at = now(), close_note = $4
        WHERE id = $1 AND state <> 'closed' RETURNING endpoint_id`,
      [id, ctx.userId, ctx.userEmail, note ?? null],
    );
    if (!r.rows[0]) throw notFound('Open help request');
    await audit(db, req, 'fleet.help_closed', { type: 'endpoint', id: r.rows[0].endpoint_id }, { help_request_id: id, note_length: note?.length ?? 0 });
  });
}

/** Starts an attended session from a request; the request then points at that session. */
export async function startFromHelpRequest(
  req: Request,
  ctx: AuthContext,
  id: string,
  body: RdStart,
): Promise<{ session: RemoteDesktopSession; last_frame: RemoteDesktopFrame | null }> {
  const hr = await withTenant(ctx.organizationId, (db) => db.query<{ endpoint_id: string; state: string }>(`SELECT endpoint_id, state FROM fleet_help_requests WHERE id = $1`, [id]));
  const row = hr.rows[0];
  if (!row) throw notFound('Help request');
  if (row.state === 'closed') throw new AppError(409, 'help_request_closed', 'This help request is closed');
  const out = await startSession(req, ctx, row.endpoint_id, body, { forceAttended: true, helpRequestId: id });
  await withTenant(ctx.organizationId, async (db) => {
    await db.query(
      `UPDATE fleet_help_requests SET state = 'in_session', handled_by = $2, handled_by_email = $3, handled_at = now(), fleet_session_id = $4 WHERE id = $1`,
      [id, ctx.userId, ctx.userEmail, out.session.fleet_session_id ?? null],
    );
    await audit(db, req, 'fleet.help_session_started', { type: 'endpoint', id: row.endpoint_id }, { help_request_id: id, session_id: out.session.id });
  });
  return out;
}
