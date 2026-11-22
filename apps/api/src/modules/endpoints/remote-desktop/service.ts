import type { Request } from 'express';
import type { EndpointPlatform, EndpointPolicy, FleetSession, FleetSessionStatus, RemoteDesktopFrame, RemoteDesktopSession } from '@lan-detective/shared-types';
import { audit } from '../../../common/audit.ts';
import { randomToken } from '../../../common/crypto.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { buildCapabilities } from '../capabilities.ts';
import type { EndpointContext } from '../schema.ts';
import { ONLINE_WITHIN_MS, queueUserNotice } from '../repo.ts';
import { dropFrames, publishFramesCleared } from './frames.ts';
import type { RdStart, SessionListQuery } from './schema.ts';
import {
  CONSENT_TIMEOUT_SECONDS,
  FLEET_SESSION_COLUMNS,
  auditEndpointEvent,
  currentFleetSession,
  endOpenSession,
  signalSessionState,
} from './sessions.ts';
import { isStreamConnected } from './stream-registry.ts';

// Live Remote Desktop session management. A session is a fleet_sessions row (history) plus the
// endpoints.rd_session cache (the current one). Starting one:
//   unattended policy → live at once; the user is told by a notice and by the session banner;
//   prompt policy     → waiting_consent until the person at the computer accepts the dialog
//                       (frames and input are refused until then; no answer = declined).
// The agent gets rd_session_open (consent, banner, live stream) and rd_session_close. Frames
// travel over the live WebSocket (stream-hub.ts) or, as the fallback, as rd_capture / rd_input
// commands (commands/service.ts). Images are transient (frames.ts). `req` is for the audit trail.

export async function startSession(req: Request, ctx: AuthContext, id: string, body: RdStart): Promise<{ session: RemoteDesktopSession; last_frame: RemoteDesktopFrame | null }> {
  return withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{
        id: string;
        site_id: string;
        device_id: string | null;
        name: string;
        platform: EndpointPlatform;
        status: string;
        last_heartbeat_at: Date | null;
        policy: EndpointPolicy;
        rd_session: RemoteDesktopSession | null;
      }>(
        `SELECT id, site_id, device_id, name, platform, status, last_heartbeat_at, policy, rd_session
           FROM endpoints WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');

    const caps = buildCapabilities(ep.platform);
    const rdCap = caps.find((c) => c.key === 'remote_desktop');
    if (!rdCap?.enabled) {
      throw new AppError(409, 'unsupported_by_platform', rdCap?.reason_en ?? 'Remote desktop is not supported on this platform');
    }
    if (ep.status !== 'active' || !ep.last_heartbeat_at || ep.last_heartbeat_at.getTime() < Date.now() - ONLINE_WITHIN_MS) {
      throw new AppError(409, 'endpoint_offline', 'This endpoint is not currently online');
    }

    // A new session replaces an open one (its banner goes, its stream closes); a history row left
    // open without a current session (endpoint revoked meanwhile) is closed as expired.
    if (ep.rd_session) {
      await endOpenSession(db, ctx.organizationId, id, 'replaced', { userId: ctx.userId, email: ctx.userEmail });
    }
    await db.query(`UPDATE fleet_sessions SET state = 'ended', ended_at = now(), end_reason = 'expired' WHERE endpoint_id = $1 AND state <> 'ended'`, [id]);

    const consentMode = ep.policy?.remote_desktop_consent ?? 'unattended';
    const attended = consentMode === 'prompt';
    const publicId = randomToken(12);
    const reason = body.reason?.trim() ? body.reason.trim() : null;
    const fs = (
      await db.query<{ id: string }>(
        `INSERT INTO fleet_sessions (organization_id, endpoint_id, public_id, operator_user_id, operator_email, reason, state, consent_mode,
                                     consent_result, display_index, quality, scale)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [ctx.organizationId, id, publicId, ctx.userId, ctx.userEmail, reason, attended ? 'waiting_consent' : 'active', consentMode, attended ? 'pending' : 'not_required', body.display_index, body.quality, body.scale],
      )
    ).rows[0]!;

    const session: RemoteDesktopSession = {
      id: publicId,
      started_at: new Date().toISOString(),
      operator_email: ctx.userEmail,
      display_index: body.display_index,
      quality: body.quality,
      scale: body.scale,
      consent_mode: consentMode,
      recording_enabled: body.recording_enabled,
      fleet_session_id: fs.id,
      state: attended ? 'waiting_consent' : 'active',
      reason,
    };

    await db.query(`UPDATE endpoints SET rd_session = $2::jsonb WHERE id = $1`, [id, JSON.stringify(session)]);
    // A new session never shows a frame of an earlier one.
    dropFrames(id);
    await publishFramesCleared(db, id);

    if (!attended) {
      // Never silent: the person at the endpoint is told who is viewing before the first frame is taken.
      await queueUserNotice(db, ctx.organizationId, id, ctx.userId, ctx.userEmail, 'Remote support session started', `${ctx.userEmail} can now see and control this screen. The session is logged.`);
    }
    // Consent (when the policy asks for it), the session banner (always) and the live stream.
    await db.query(
      `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
       VALUES ($1,$2,'rd_session_open',$3,$4,$5)`,
      [
        ctx.organizationId,
        id,
        JSON.stringify({
          session_id: publicId,
          operator: ctx.userEmail,
          reason: reason ?? '',
          consent_required: attended,
          consent_timeout_s: CONSENT_TIMEOUT_SECONDS,
          // Technicians and above control the session; nothing here can hide the banner.
          control: true,
          stream: true,
          display_index: body.display_index,
          quality: body.quality,
          scale: body.scale,
        }),
        ctx.userId,
        ctx.userEmail,
      ],
    );
    if (!attended) {
      // First frame for the HTTP path (viewers without the live stream).
      await db.query(
        `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
         VALUES ($1,$2,'rd_capture',$3,$4,$5)`,
        [ctx.organizationId, id, JSON.stringify({ display_index: body.display_index, quality: body.quality, scale: body.scale }), ctx.userId, ctx.userEmail],
      );
    }
    await signalSessionState(db, id, session.state ?? 'active');

    await audit(db, req, 'endpoint.remote_desktop_started', { type: 'endpoint', id }, session as unknown as Record<string, unknown>);
    await audit(db, req, 'fleet.session_opened', { type: 'endpoint', id }, { fleet_session_id: fs.id, session_id: publicId, consent_mode: consentMode, reason });
    await emitEvent(db, ctx.organizationId, {
      siteId: ep.site_id,
      deviceId: ep.device_id,
      type: 'endpoint_command',
      severity: 'info',
      title: attended
        ? `Remote Desktop session requested on "${ep.name}" by ${ctx.userEmail} (waiting for the user's consent)`
        : `Remote Desktop session started on "${ep.name}" by ${ctx.userEmail}`,
      details: { endpoint_id: ep.id, session_id: session.id, fleet_session_id: fs.id, operator: ctx.userEmail, consent_mode: consentMode, recording: body.recording_enabled },
      source: 'platform',
      occurredAt: new Date(),
    });
    return { session, last_frame: null };
  });
}

export async function stopSession(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const ep = (await db.query<{ id: string; active: boolean }>(`SELECT id, rd_session IS NOT NULL AS active FROM endpoints WHERE id = $1`, [id])).rows[0];
    if (!ep) throw notFound('Endpoint');
    const ended = await endOpenSession(db, ctx.organizationId, id, 'operator', { userId: ctx.userId, email: ctx.userEmail });
    if (ep.active) {
      await queueUserNotice(db, ctx.organizationId, id, ctx.userId, ctx.userEmail, 'Remote support session ended', `${ctx.userEmail} is no longer viewing this screen.`);
    }
    await audit(db, req, 'endpoint.remote_desktop_stopped', { type: 'endpoint', id }, { operator: ctx.userEmail });
    if (ended) {
      await audit(db, req, 'fleet.session_ended', { type: 'endpoint', id }, { fleet_session_id: ended.id, session_id: ended.public_id, end_reason: 'operator' });
    }
  });
}

/** The person at the computer pressed "End session" on the banner (agent: POST /agent/rd-session/end). */
export async function endSessionByUser(ep: EndpointContext, publicId: string): Promise<boolean> {
  return withTenant(ep.organizationId, async (db) => {
    const ended = await endOpenSession(db, ep.organizationId, ep.id, 'user', { userId: null, email: null }, publicId);
    if (!ended) return false;
    await auditEndpointEvent(db, ep.organizationId, ep.id, 'fleet.session_ended', { fleet_session_id: ended.id, session_id: publicId, end_reason: 'user', ended_by: 'endpoint_user' });
    await emitEvent(db, ep.organizationId, {
      siteId: ep.siteId,
      deviceId: ep.deviceId,
      type: 'endpoint_command',
      severity: 'info',
      title: `The user at "${ep.name}" ended the remote support session of ${ended.operator_email ?? 'an operator'}`,
      details: { endpoint_id: ep.id, session_id: publicId, fleet_session_id: ended.id, end_reason: 'user' },
      source: 'platform',
      occurredAt: new Date(),
    });
    return true;
  });
}

/** A consent request nobody answered (agent offline, command never delivered) ends after this. */
const CONSENT_STALE_MS = (CONSENT_TIMEOUT_SECONDS + 120) * 1000;

export async function getSessionStatus(ctx: AuthContext, id: string): Promise<FleetSessionStatus> {
  return withTenant(ctx.organizationId, async (db) => {
    const ep = (await db.query<{ rd_session: RemoteDesktopSession | null }>(`SELECT rd_session FROM endpoints WHERE id = $1`, [id])).rows[0];
    if (!ep) throw notFound('Endpoint');
    let fs = await currentFleetSession(db, id);
    if (fs && fs.state === 'waiting_consent' && Date.now() - new Date(fs.started_at).getTime() > CONSENT_STALE_MS) {
      await db.query(`UPDATE fleet_sessions SET consent_result = 'timeout', consent_decided_at = now() WHERE id = $1`, [fs.id]);
      await endOpenSession(db, ctx.organizationId, id, 'consent_timeout', { userId: null, email: null }, fs.public_id);
      await auditEndpointEvent(db, ctx.organizationId, id, 'fleet.session_consent', { fleet_session_id: fs.id, session_id: fs.public_id, result: 'timeout', note: 'the agent never answered' });
      return { session: null, fleet_session: null, stream_connected: false };
    }
    if (fs && ep.rd_session?.id !== fs.public_id) fs = null;
    return { session: ep.rd_session, fleet_session: fs, stream_connected: Boolean(ep.rd_session && isStreamConnected(id, ep.rd_session.id)) };
  });
}

export async function listSessions(ctx: AuthContext, q: SessionListQuery): Promise<FleetSession[]> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<FleetSession>(
      `SELECT ${FLEET_SESSION_COLUMNS.replace(/(^|, |\n\s*)(\w+)/g, '$1f.$2')}, e.name AS endpoint_name
         FROM fleet_sessions f JOIN endpoints e ON e.organization_id = f.organization_id AND e.id = f.endpoint_id
        WHERE ($1::uuid IS NULL OR f.endpoint_id = $1)
          AND ($2::text IS NULL OR f.state = $2)
        ORDER BY f.started_at DESC
        LIMIT $3`,
      [q.endpoint_id ?? null, q.state ?? null, q.limit],
    );
    return r.rows;
  });
}
