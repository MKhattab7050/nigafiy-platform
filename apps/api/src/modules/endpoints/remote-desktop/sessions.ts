import type { FleetSession, FleetSessionEndReason, RemoteDesktopSession } from '@nigafiy/shared-types';
import type { Db } from '../../../infrastructure/db.ts';
import { dropFrames, publishFramesCleared } from './frames.ts';

// Fleet session history (fleet_sessions, migration 034) and the signals the live stream hub
// listens to. endpoints.rd_session stays the current-session cache; this table is the record.

/** pg_notify channel of the live stream hub (stream-hub.ts): session state and socket routing only, never frames. */
export const RD_STREAM_CHANNEL = 'ld_rd_stream';

/** How long the person at the computer has to answer the consent dialog. */
export const CONSENT_TIMEOUT_SECONDS = 60;

export const FLEET_SESSION_COLUMNS = `id, endpoint_id, public_id, operator_email, reason, state, consent_mode, consent_result, consent_error,
  consent_decided_at, banner_state, banner_mode, banner_error, transport, stream_connected_at, rtc_encoder, rtc_started_at, rtc_fallback_reason, desktop_mode, display_index, quality, scale,
  frames_relayed::float8 AS frames_relayed, bytes_relayed::float8 AS bytes_relayed, clipboard_to_remote, clipboard_from_remote,
  started_at, accepted_at, ended_at, end_reason, ended_by_email, source, fleet_group_id, group_name, profile_id, profile_name, permissions,
  consent_timeout_s, refuse_window_s, policy_trail, mfa_verified, request_ip, approval_state, approval_expires_at, approver_email,
  approval_decided_at, approval_note, recording_mode, recording_id, chat_messages, files_transferred, wake_request_id,
  user_session, help_request_id, restart_id, quick_support_id, resumed_from_id`;

/** Records an action the endpoint (its agent or the person at it) took, in the caller's transaction. */
export async function auditEndpointEvent(db: Db, orgId: string, endpointId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
     VALUES ($1, NULL, NULL, $2, 'endpoint', $3, $4, 'system')`,
    [orgId, action, endpointId, JSON.stringify({ ...metadata, source: 'endpoint_agent' })],
  );
}

/**
 * Tells every API instance's hub that an endpoint's session changed (delivered on COMMIT, and
 * received asynchronously). The payload names the session ("end|E|S", "state|E|state|S"): a
 * notification about an earlier session can arrive after a newer session of the same endpoint is
 * already streaming (a start that replaced one, then a fast reconnect), and must not touch it.
 */
export async function signalSessionState(
  db: Db,
  endpointId: string,
  sessionId: string | null,
  state: 'waiting_approval' | 'waiting_consent' | 'active' | 'ended',
): Promise<void> {
  const s = sessionId ?? '';
  await db.query('SELECT pg_notify($1, $2)', [RD_STREAM_CHANNEL, state === 'ended' ? `end|${endpointId}|${s}` : `state|${endpointId}|${state}|${s}`]);
}

export async function currentFleetSession(db: Db, endpointId: string): Promise<FleetSession | null> {
  const r = await db.query<FleetSession>(
    `SELECT ${FLEET_SESSION_COLUMNS} FROM fleet_sessions WHERE endpoint_id = $1 AND state <> 'ended' ORDER BY started_at DESC LIMIT 1`,
    [endpointId],
  );
  return r.rows[0] ?? null;
}

export async function fleetSessionByPublicId(db: Db, endpointId: string, publicId: string): Promise<FleetSession | null> {
  const r = await db.query<FleetSession>(`SELECT ${FLEET_SESSION_COLUMNS} FROM fleet_sessions WHERE endpoint_id = $1 AND public_id = $2`, [endpointId, publicId]);
  return r.rows[0] ?? null;
}

/**
 * Ends the endpoint's open session (if `publicId` is given, only that one): the history row, the
 * rd_session cache, pending frame/input commands, the frames held in memory on every instance, the
 * live sockets on every instance, and a close command for the agent (banner off). Returns the
 * session that was ended, or null.
 */
export async function endOpenSession(
  db: Db,
  orgId: string,
  endpointId: string,
  reason: FleetSessionEndReason,
  endedBy: { userId: string | null; email: string | null },
  publicId?: string,
): Promise<FleetSession | null> {
  // Command rows are locked before the endpoint row (the order an agent's result upload uses).
  await db.query(
    `UPDATE endpoint_commands SET status = 'expired', error = 'Remote desktop session ended', completed_at = now()
      WHERE endpoint_id = $1 AND kind IN ('rd_capture', 'rd_input', 'rd_session_open') AND status = 'pending'`,
    [endpointId],
  );
  await db.query(
    `UPDATE endpoint_commands SET status = 'expired', error = 'Remote desktop session ended', completed_at = now()
      WHERE endpoint_id = $1 AND kind IN ('rd_capture', 'rd_input') AND status = 'delivered'`,
    [endpointId],
  );
  const ep = (await db.query<{ rd_session: RemoteDesktopSession | null }>(`SELECT rd_session FROM endpoints WHERE id = $1 FOR UPDATE`, [endpointId])).rows[0];
  const cur = ep?.rd_session ?? null;
  if (publicId && cur?.id !== publicId) {
    // Not the current session: only close its history row if still open.
    const old = await db.query<FleetSession>(
      `UPDATE fleet_sessions SET state = 'ended', ended_at = now(), end_reason = $3, ended_by_email = $4
        WHERE endpoint_id = $1 AND public_id = $2 AND state <> 'ended' RETURNING ${FLEET_SESSION_COLUMNS}`,
      [endpointId, publicId, reason, endedBy.email],
    );
    return old.rows[0] ?? null;
  }
  const ended = await db.query<FleetSession>(
    `UPDATE fleet_sessions SET state = 'ended', ended_at = now(), end_reason = $2, ended_by_email = $3
      WHERE endpoint_id = $1 AND state <> 'ended' RETURNING ${FLEET_SESSION_COLUMNS}`,
    [endpointId, reason, endedBy.email],
  );
  await db.query(`UPDATE endpoints SET rd_session = NULL WHERE id = $1`, [endpointId]);
  // The session's recording stops with it (the hub writing it closes its file); invitations lapse
  // and every operator leaves.
  await db.query(`UPDATE fleet_recordings SET state = 'complete', ended_at = coalesce(ended_at, now()) WHERE endpoint_id = $1 AND state = 'recording'`, [endpointId]);
  await db.query(
    `UPDATE fleet_session_participants SET state = CASE WHEN state = 'invited' THEN 'expired' ELSE 'left' END, left_at = now()
      WHERE endpoint_id = $1 AND state IN ('invited', 'joined')`,
    [endpointId],
  );
  dropFrames(endpointId);
  await publishFramesCleared(db, endpointId);
  // Nothing open means nothing to close: an unnamed "end" arriving late could hit a newer session.
  const endedId = cur?.id ?? ended.rows[0]?.public_id;
  if (endedId) await signalSessionState(db, endpointId, endedId, 'ended');
  if (cur?.id) {
    // The agent removes the banner and closes the stream (a no-op for agents that never opened one).
    await db.query(
      `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
       VALUES ($1,$2,'rd_session_close',$3,$4,$5)`,
      [orgId, endpointId, JSON.stringify({ session_id: cur.id, reason }), endedBy.userId, endedBy.email],
    );
  }
  return ended.rows[0] ?? null;
}

interface OpenResultData {
  consent?: string;
  consent_error?: string;
  banner?: string;
  banner_error?: string;
  stream?: string;
  desktop?: { mode?: string };
}

/**
 * The agent's answer to rd_session_open (called from applyCommandResults, in the upload's
 * transaction): consent accepted → the session goes live; denied / timed out / impossible → it
 * ends. A failed command is an agent that does not know Fleet Pro sessions: an attended session
 * cannot be honoured (no way to ask), an unattended one goes on with the start notice only.
 */
export async function applySessionOpenResult(
  db: Db,
  orgId: string,
  endpointId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  data: OpenResultData | null,
  error: string | null,
): Promise<void> {
  const publicId = typeof payload.session_id === 'string' ? payload.session_id : '';
  if (!publicId) return;
  const fs = await fleetSessionByPublicId(db, endpointId, publicId);
  if (!fs || fs.state === 'ended') return;
  const banner =
    !ok ? 'not_supported' : data?.banner === 'shown' || data?.banner === 'minimized' || data?.banner === 'off' || data?.banner === 'unavailable' ? data.banner : 'pending';
  await db.query(`UPDATE fleet_sessions SET banner_state = $2, banner_error = $3, desktop_mode = coalesce($4, desktop_mode) WHERE id = $1`, [
    fs.id,
    banner,
    data?.banner_error?.slice(0, 300) ?? null,
    data?.desktop?.mode?.slice(0, 40) ?? null,
  ]);
  const consent = !ok ? (fs.consent_mode === 'prompt' ? 'unavailable' : 'not_required') : (data?.consent ?? 'unavailable');
  if (fs.consent_mode !== 'prompt' && fs.refuse_window_s > 0) {
    // Unattended with a refuse window: only an explicit refusal stops the session. No answer goes
    // on; so does a computer where nobody can be asked (no desktop), or an agent that did not
    // know the window (recorded, the banner still shows).
    if (consent === 'denied') {
      await db.query(`UPDATE fleet_sessions SET consent_result = 'denied', consent_decided_at = now() WHERE id = $1`, [fs.id]);
      await endOpenSession(db, orgId, endpointId, 'consent_denied', { userId: null, email: null }, publicId);
      await auditEndpointEvent(db, orgId, endpointId, 'fleet.session_consent', { fleet_session_id: fs.id, session_id: publicId, result: 'denied', refuse_window_s: fs.refuse_window_s });
      return;
    }
    const result = consent === 'accepted' ? 'accepted' : consent === 'timeout' || consent === 'not_refused' ? 'not_refused' : consent === 'unavailable' ? 'unavailable' : 'not_required';
    const note =
      result === 'unavailable'
        ? (data?.consent_error ?? error ?? 'nobody could be asked').slice(0, 300)
        : result === 'not_required'
          ? 'the agent did not show the refuse window'
          : null;
    await db.query(
      `UPDATE fleet_sessions SET state = 'active', consent_result = $2, consent_error = $3, consent_decided_at = now(), accepted_at = now() WHERE id = $1`,
      [fs.id, result, note],
    );
    await db.query(`UPDATE endpoints SET rd_session = rd_session || '{"state":"active"}'::jsonb WHERE id = $1 AND rd_session->>'id' = $2`, [endpointId, publicId]);
    await signalSessionState(db, endpointId, publicId, 'active');
    await auditEndpointEvent(db, orgId, endpointId, 'fleet.session_consent', { fleet_session_id: fs.id, session_id: publicId, result, refuse_window_s: fs.refuse_window_s, note, banner });
    return;
  }
  if (fs.consent_mode !== 'prompt') {
    await auditEndpointEvent(db, orgId, endpointId, 'fleet.session_banner', { fleet_session_id: fs.id, session_id: publicId, banner, banner_error: data?.banner_error ?? (ok ? null : error) });
    return;
  }
  if (consent === 'accepted') {
    await db.query(`UPDATE fleet_sessions SET state = 'active', consent_result = 'accepted', consent_decided_at = now(), accepted_at = now() WHERE id = $1`, [fs.id]);
    await db.query(`UPDATE endpoints SET rd_session = rd_session || '{"state":"active"}'::jsonb WHERE id = $1 AND rd_session->>'id' = $2`, [endpointId, publicId]);
    await signalSessionState(db, endpointId, publicId, 'active');
    await auditEndpointEvent(db, orgId, endpointId, 'fleet.session_consent', { fleet_session_id: fs.id, session_id: publicId, result: 'accepted', banner });
    return;
  }
  const result = consent === 'denied' || consent === 'timeout' ? consent : 'unavailable';
  const consentError = result === 'unavailable' ? (data?.consent_error ?? error ?? 'the agent cannot ask the user for consent').slice(0, 300) : null;
  await db.query(`UPDATE fleet_sessions SET consent_result = $2, consent_error = $3, consent_decided_at = now() WHERE id = $1`, [fs.id, result, consentError]);
  await endOpenSession(db, orgId, endpointId, result === 'denied' ? 'consent_denied' : result === 'timeout' ? 'consent_timeout' : 'consent_unavailable', { userId: null, email: null }, publicId);
  await auditEndpointEvent(db, orgId, endpointId, 'fleet.session_consent', { fleet_session_id: fs.id, session_id: publicId, result, error: consentError });
}
