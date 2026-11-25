import type { Request } from 'express';
import type { EndpointAndroidState, EndpointPlatform, FleetPolicyTrailItem, FleetSession, FleetSessionStatus, RemoteDesktopFrame, RemoteDesktopSession } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { randomToken } from '../../../common/crypto.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { buildCapabilities } from '../capabilities.ts';
import type { EndpointContext } from '../schema.ts';
import { ONLINE_WITHIN_MS, queueUserNotice } from '../repo.ts';
import { effectivePolicy, evaluatePolicy, loadProfiles, normalizeIp } from '../fleet-policy/policy.ts';
import { builtinProfile, sessionPermissions } from '../fleet-policy/profiles.ts';
import { checkStepUpToken, operatorHasMfa } from '../fleet-policy/step-up.ts';
import { expireApprovalIfDue } from '../fleet-policy/approvals.ts';
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
import { createRecording } from './recording.ts';
import { markWakeConnected, recordingRule } from './session-tools.ts';
import { isStreamConnected } from './stream-registry.ts';

// Live Remote Desktop session management. A session is a fleet_sessions row (history) plus the
// endpoints.rd_session cache (the current one). Starting one (Fleet Pro, migration 035):
//   request (reason required) → access policy of the endpoint's group, or the organization default
//   (fleet-policy/policy.ts: role, IP allow-list, hours, MFA step-up, profile clamped to the maximum;
//   each refusal has a code and is audited as fleet.policy_refused)
//   → waiting_approval when an unattended policy asks a second admin (fleet-policy/approvals.ts)
//   → waiting_consent while the user answers (attended) or the refuse window runs (unattended)
//   → active. Frames and input wait until then; the granted permissions travel with the session
//   (rd_session.permissions) and are enforced here, in the stream hub and by the agent.
// The agent gets rd_session_open (consent / refuse window, banner with the permissions, live stream)
// and rd_session_close. Frames travel over the live WebSocket (stream-hub.ts) or, as the fallback,
// as rd_capture / rd_input commands (commands/service.ts). Images are transient (frames.ts).

interface StartEndpointRow {
  id: string;
  site_id: string;
  device_id: string | null;
  name: string;
  platform: EndpointPlatform;
  status: string;
  last_heartbeat_at: Date | null;
  rd_session: RemoteDesktopSession | null;
}

/**
 * How a session was asked for, when not from the plain connect dialog (migration 037):
 *   forceAttended   from a "Request help" request: the person accepts it whatever the policy says
 *   quickSupportId  a Quick Support code + PIN: attended, at most the Support profile
 *   resume          restart and reconnect: the session that was open before the restart comes back
 *                   (same operator, reason, profile, Windows session); the policy is checked again
 *                   for role, address and hours; the MFA step-up of the original session carries over.
 */
export interface StartOptions {
  forceAttended?: boolean;
  helpRequestId?: string;
  quickSupportId?: string;
  resume?: { fromSessionId: string; restartId: string; mfaVerified: boolean };
}

type Refusal = { refused: true; code: string; status: number; message: string; trail: FleetPolicyTrailItem[]; policySource: string; group: string | null };

export async function startSession(
  req: Request,
  ctx: AuthContext,
  id: string,
  body: RdStart,
  opts: StartOptions = {},
): Promise<{ session: RemoteDesktopSession; last_frame: RemoteDesktopFrame | null }> {
  const requestIp = normalizeIp(req.ip);
  const stepUpState = opts.resume?.mfaVerified ? 'valid' : checkStepUpToken(body.step_up_token, ctx);
  const hasMfa = await operatorHasMfa(ctx.userId);
  const outcome = await withTenant(ctx.organizationId, async (db): Promise<Refusal | { refused: false; session: RemoteDesktopSession }> => {
    const ep = (
      await db.query<StartEndpointRow & { kind: string; android: EndpointAndroidState | null }>(
        `SELECT id, site_id, device_id, name, platform, status, last_heartbeat_at, rd_session, kind, android FROM endpoints WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    // A Quick Support computer is reached only with its code and PIN (fleet-reach/quick-support.ts).
    if (ep.kind === 'quick_support' && !opts.quickSupportId) throw new AppError(409, 'quick_support_needs_code', 'Connect to a Quick Support computer with its code and PIN');
    if (body.user_session) await assertUserSession(db, id, ep.platform, body.user_session);

    const caps = buildCapabilities(ep.platform, ep.android);
    const rdCap = caps.find((c) => c.key === 'remote_desktop');
    if (!rdCap?.enabled) {
      throw new AppError(409, 'unsupported_by_platform', rdCap?.reason_en ?? 'Remote desktop is not supported on this platform');
    }
    if (ep.status !== 'active' || !ep.last_heartbeat_at || ep.last_heartbeat_at.getTime() < Date.now() - ONLINE_WITHIN_MS) {
      throw new AppError(409, 'endpoint_offline', 'This endpoint is not currently online');
    }

    // The access policy decides before anything reaches the endpoint.
    const eff = (await effectivePolicy(db, ctx.organizationId, id))!;
    // A phone always asks the person (and Android asks again): never unattended, never silent.
    if (opts.forceAttended || opts.quickSupportId || ep.platform === 'android') {
      // The person asked for this session (or runs Quick Support): they accept it on their screen.
      eff.policy = { ...eff.policy, access_mode: 'attended', approval_required: false };
    }
    if (opts.quickSupportId) {
      // Quick Support is capped at the Support profile, whatever the operator picks.
      const support = await builtinProfile(db, 'support');
      eff.policy = { ...eff.policy, default_profile_id: support.id, max_profile_id: support.id };
    }
    const { requested, max } = await loadProfiles(db, eff.policy, body.profile_id);
    if (!requested) throw new AppError(422, 'profile_not_found', 'The permission profile does not exist');
    const decision = evaluatePolicy({
      policy: eff.policy,
      timezone: eff.timezone,
      role: ctx.role,
      requestIp,
      now: new Date(),
      operatorHasMfa: hasMfa,
      stepUp: stepUpState,
      requested,
      max,
    });
    // Recording: the group's rule, then the profile ("record"). A group that requires recording
    // refuses a session that cannot be recorded rather than running it unrecorded.
    const rule = await recordingRule(db, id);
    let recordingRefusal: { code: string; message: string } | null = null;
    if (decision.ok) {
      if (rule.mode === 'off' && body.recording_enabled) recordingRefusal = { code: 'recording_disabled_by_policy', message: 'The access policy of this computer does not allow recording sessions' };
      else if (rule.mode === 'required' && !decision.permissions.record)
        recordingRefusal = { code: 'recording_required_profile_cannot_record', message: 'The access policy of this computer requires recording, and the permission profile does not allow it' };
      else if (body.recording_enabled && !decision.permissions.record) recordingRefusal = { code: 'profile_forbids_record', message: 'The permission profile of this session does not allow recording' };
    }
    if (decision.ok && recordingRefusal) {
      return {
        refused: true,
        code: recordingRefusal.code,
        status: 403,
        message: recordingRefusal.message,
        trail: [...decision.trail, { check: 'recording', result: 'fail', detail: `policy ${rule.mode}, profile record ${decision.permissions.record}` }],
        policySource: eff.source,
        group: eff.group?.name ?? null,
      };
    }
    const record = decision.ok && (rule.mode === 'required' || (rule.mode === 'optional' && body.recording_enabled));
    if (!decision.ok) {
      return {
        refused: true,
        code: decision.code,
        status: decision.code === 'profile_no_view' ? 422 : 403,
        message: decision.message,
        trail: decision.trail,
        policySource: eff.source,
        group: eff.group?.name ?? null,
      };
    }

    // A new session replaces an open one (its banner goes, its stream closes); a history row left
    // open without a current session (endpoint revoked meanwhile) is closed as expired.
    if (ep.rd_session) {
      await endOpenSession(db, ctx.organizationId, id, 'replaced', { userId: ctx.userId, email: ctx.userEmail });
    }
    await db.query(`UPDATE fleet_sessions SET state = 'ended', ended_at = now(), end_reason = 'expired' WHERE endpoint_id = $1 AND state <> 'ended'`, [id]);

    const attended = decision.attended;
    const consentMode = attended ? 'prompt' : 'unattended';
    const state: NonNullable<RemoteDesktopSession['state']> = decision.approvalNeeded ? 'waiting_approval' : attended || decision.refuseWindowS > 0 ? 'waiting_consent' : 'active';
    const publicId = randomToken(12);
    const reason = body.reason;
    const fs = (
      await db.query<{ id: string; approval_expires_at: Date | null }>(
        `INSERT INTO fleet_sessions (organization_id, endpoint_id, public_id, operator_user_id, operator_email, reason, state, consent_mode,
                                     consent_result, display_index, quality, scale, fleet_group_id, group_name, profile_id, profile_name,
                                     permissions, consent_timeout_s, refuse_window_s, policy_trail, mfa_verified, request_ip,
                                     approval_state, approval_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::inet,$23::text,
                 CASE WHEN $23::text = 'pending' THEN now() + make_interval(mins => $24::int) END)
         RETURNING id, approval_expires_at`,
        [
          ctx.organizationId,
          id,
          publicId,
          ctx.userId,
          ctx.userEmail,
          reason,
          state,
          consentMode,
          attended || decision.refuseWindowS > 0 ? 'pending' : 'not_required',
          body.display_index,
          body.quality,
          body.scale,
          eff.group?.id ?? null,
          eff.group?.name ?? null,
          requested.id,
          requested.name,
          JSON.stringify(decision.permissions),
          attended ? eff.policy.consent_timeout_s : null,
          decision.refuseWindowS,
          JSON.stringify(decision.trail),
          decision.mfaVerified,
          requestIp,
          decision.approvalNeeded ? 'pending' : 'not_required',
          eff.policy.approval_ttl_minutes,
        ],
      )
    ).rows[0]!;
    let recordingId: string | null = null;
    if (record) {
      recordingId = await createRecording(db, { orgId: ctx.organizationId, endpointId: id, fleetSessionId: fs.id, publicId, email: ctx.userEmail, retentionDays: rule.retentionDays });
    }
    await db.query(
      `UPDATE fleet_sessions SET recording_mode = $2, recording_id = $3, wake_request_id = $4, user_session = $5, help_request_id = $6, quick_support_id = $7,
              resumed_from_id = $8, restart_id = $9 WHERE id = $1`,
      [fs.id, rule.mode, recordingId, body.wake_request_id ?? null, body.user_session ?? null, opts.helpRequestId ?? null, opts.quickSupportId ?? null, opts.resume?.fromSessionId ?? null, opts.resume?.restartId ?? null],
    );
    // The operator who starts the session holds it (several operators: session-tools.ts).
    await db.query(
      `INSERT INTO fleet_session_participants (organization_id, fleet_session_id, endpoint_id, user_id, email, role, state, permissions, joined_at, policy_trail, mfa_verified, request_ip)
       VALUES ($1,$2,$3,$4,$5,'holder','joined',$6, now(), $7, $8, $9::inet)`,
      [ctx.organizationId, fs.id, id, ctx.userId, ctx.userEmail, JSON.stringify(decision.permissions), JSON.stringify(decision.trail), decision.mfaVerified, requestIp],
    );
    if (body.wake_request_id) await markWakeConnected(db, id, body.wake_request_id, publicId);

    const session: RemoteDesktopSession = {
      id: publicId,
      started_at: new Date().toISOString(),
      operator_email: ctx.userEmail,
      display_index: body.display_index,
      quality: body.quality,
      scale: body.scale,
      consent_mode: consentMode,
      recording_enabled: recordingId !== null,
      recording_id: recordingId,
      operators: [ctx.userEmail],
      fleet_session_id: fs.id,
      state,
      reason,
      permissions: decision.permissions,
      profile_name: requested.name,
      group_name: eff.group?.name ?? null,
      user_session: body.user_session ?? null,
      quick_support: Boolean(opts.quickSupportId),
    };
    await db.query(`UPDATE endpoints SET rd_session = $2::jsonb WHERE id = $1`, [id, JSON.stringify({ ...session, operator_user_id: ctx.userId })]);
    // A new session never shows a frame of an earlier one.
    dropFrames(id);
    await publishFramesCleared(db, id);

    await audit(db, req, 'fleet.session_requested', { type: 'endpoint', id }, {
      fleet_session_id: fs.id,
      session_id: publicId,
      reason,
      policy_source: eff.source,
      group: eff.group?.name ?? null,
      profile: requested.name,
      permissions: decision.permissions,
      clamped: decision.clamped,
      trail: decision.trail,
      recording: recordingId ? { recording_id: recordingId, mode: rule.mode, retention_days: rule.retentionDays } : null,
      wake_request_id: body.wake_request_id ?? null,
      user_session: body.user_session ?? null,
      help_request_id: opts.helpRequestId ?? null,
      quick_support_id: opts.quickSupportId ?? null,
      resumed_from: opts.resume?.fromSessionId ?? null,
    });
    if (decision.approvalNeeded) {
      await signalSessionState(db, id, publicId, 'waiting_approval');
      await audit(db, req, 'fleet.session_approval_requested', { type: 'endpoint', id }, { fleet_session_id: fs.id, session_id: publicId, expires_at: fs.approval_expires_at });
      await emitEvent(db, ctx.organizationId, {
        siteId: ep.site_id,
        deviceId: ep.device_id,
        type: 'endpoint_command',
        severity: 'info',
        title: `Remote support session on "${ep.name}" requested by ${ctx.userEmail} is waiting for a second admin's approval`,
        details: { endpoint_id: ep.id, session_id: publicId, fleet_session_id: fs.id, operator: ctx.userEmail, reason },
        source: 'platform',
        occurredAt: new Date(),
      });
      return { refused: false, session };
    }
    await openOnAgent(db, req, {
      orgId: ctx.organizationId,
      endpoint: ep,
      session,
      fleetSessionId: fs.id,
      operator: { userId: ctx.userId, email: ctx.userEmail },
      consentTimeoutS: eff.policy.consent_timeout_s,
      refuseWindowS: decision.refuseWindowS,
    });
    return { refused: false, session };
  });
  if (outcome.refused) {
    // The refusal is recorded even though nothing else happened.
    await withTenant(ctx.organizationId, (db) =>
      audit(db, req, 'fleet.policy_refused', { type: 'endpoint', id }, { code: outcome.code, policy_source: outcome.policySource, group: outcome.group, trail: outcome.trail, reason: body.reason }),
    );
    throw new AppError(outcome.status, outcome.code, outcome.message);
  }
  return { session: outcome.session, last_frame: null };
}

/**
 * A Windows session other than the console's (or the sign-in screen) needs the agent's LocalSystem
 * service: only it can start a helper in another session or on the Winlogon desktop. The session
 * must be one the agent listed in its last heartbeat.
 */
async function assertUserSession(db: Db, id: string, platform: EndpointPlatform, wanted: string): Promise<void> {
  if (platform !== 'windows') throw new AppError(409, 'user_session_windows_only', 'Choosing the user session is available on Windows only');
  const r = await db.query<{ user_sessions: Array<{ id: number; user: string | null }>; service: boolean | null }>(
    `SELECT user_sessions, (boot_state->>'service')::boolean AS service FROM endpoints WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row?.service) {
    throw new AppError(409, 'user_session_needs_service', 'Another Windows session or the sign-in screen needs the Nigafiy agent installed as a service on that computer');
  }
  if (wanted !== 'winlogon' && !row.user_sessions.some((s) => String(s.id) === wanted)) {
    throw new AppError(409, 'user_session_unknown', 'That Windows session is not on the computer any more: refresh the list');
  }
}

/**
 * Sends the open command to the agent (consent or refuse window, the banner with the permissions,
 * the live stream), the start notice for unattended sessions and, when already live, the first
 * frame for the HTTP path. Called at start, or when a second admin approves (`by` is then the
 * approver; the operator stays the requester).
 */
export async function openOnAgent(
  db: Db,
  req: Request,
  o: {
    orgId: string;
    endpoint: { id: string; site_id: string; device_id: string | null; name: string };
    session: RemoteDesktopSession;
    fleetSessionId: string;
    operator: { userId: string | null; email: string };
    consentTimeoutS: number;
    refuseWindowS: number;
  },
): Promise<void> {
  const { session, endpoint: ep } = o;
  const attended = session.consent_mode === 'prompt';
  const perms = sessionPermissions(session);
  if (!attended && o.refuseWindowS === 0 && o.operator.userId) {
    // Never silent: the person at the endpoint is told who is viewing before the first frame is taken.
    await queueUserNotice(
      db,
      o.orgId,
      ep.id,
      o.operator.userId,
      o.operator.email,
      'Remote support session started',
      `${o.operator.email} can now ${perms.control ? 'see and control' : 'see'} this screen. The session is logged.`,
    );
  }
  await db.query(
    `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
     VALUES ($1,$2,'rd_session_open',$3,$4,$5)`,
    [
      o.orgId,
      ep.id,
      JSON.stringify({
        session_id: session.id,
        operator: o.operator.email,
        reason: session.reason ?? '',
        consent_required: attended,
        consent_timeout_s: attended ? o.consentTimeoutS : CONSENT_TIMEOUT_SECONDS,
        // Unattended: the user may refuse within this many seconds (0 = no dialog).
        refuse_window_s: o.refuseWindowS,
        // The agent enforces these too and shows them on the banner; nothing here can hide the banner.
        control: perms.control,
        permissions: perms,
        profile: session.profile_name ?? null,
        // Everyone in the session and the recording mark: both on the banner, always.
        operators: session.operators ?? [o.operator.email],
        recording: Boolean(session.recording_id),
        stream: true,
        // The Windows session the helper attaches to (absent: the console's; "winlogon": sign-in screen).
        user_session: session.user_session ?? null,
        display_index: session.display_index,
        quality: session.quality,
        scale: session.scale,
      }),
      o.operator.userId,
      o.operator.email,
    ],
  );
  if (session.state === 'active') {
    // First frame for the HTTP path (viewers without the live stream).
    await db.query(
      `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
       VALUES ($1,$2,'rd_capture',$3,$4,$5)`,
      [o.orgId, ep.id, JSON.stringify({ display_index: session.display_index, quality: session.quality, scale: session.scale }), o.operator.userId, o.operator.email],
    );
  }
  await signalSessionState(db, ep.id, session.id, session.state ?? 'active');

  await audit(db, req, 'endpoint.remote_desktop_started', { type: 'endpoint', id: ep.id }, { ...session } as unknown as Record<string, unknown>);
  await audit(db, req, 'fleet.session_opened', { type: 'endpoint', id: ep.id }, {
    fleet_session_id: o.fleetSessionId,
    session_id: session.id,
    operator: o.operator.email,
    consent_mode: session.consent_mode,
    refuse_window_s: o.refuseWindowS,
    reason: session.reason,
    permissions: perms,
  });
  const waiting = session.state === 'waiting_consent';
  await emitEvent(db, o.orgId, {
    siteId: ep.site_id,
    deviceId: ep.device_id,
    type: 'endpoint_command',
    severity: 'info',
    title: waiting
      ? attended
        ? `Remote Desktop session requested on "${ep.name}" by ${o.operator.email} (waiting for the user's consent)`
        : `Remote Desktop session on "${ep.name}" by ${o.operator.email} starts unless the user refuses within ${o.refuseWindowS} s`
      : `Remote Desktop session started on "${ep.name}" by ${o.operator.email}`,
    details: {
      endpoint_id: ep.id,
      session_id: session.id,
      fleet_session_id: o.fleetSessionId,
      operator: o.operator.email,
      consent_mode: session.consent_mode,
      recording: session.recording_enabled,
      permissions: perms,
    },
    source: 'platform',
    occurredAt: new Date(),
  });
}

export async function stopSession(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{ id: string; active: boolean; state: string | null }>(`SELECT id, rd_session IS NOT NULL AS active, rd_session->>'state' AS state FROM endpoints WHERE id = $1`, [id])
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    const ended = await endOpenSession(db, ctx.organizationId, id, 'operator', { userId: ctx.userId, email: ctx.userEmail });
    // A request still waiting for approval never reached the computer: nothing to tell its user.
    if (ep.active && ep.state !== 'waiting_approval') {
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

/** A consent request (or refuse window) nobody answered (agent offline, command never delivered) ends this long after its timeout. */
const CONSENT_STALE_GRACE_MS = 120_000;
const consentStaleMs = (fs: FleetSession) => (fs.consent_timeout_s ?? (fs.refuse_window_s || CONSENT_TIMEOUT_SECONDS)) * 1000 + CONSENT_STALE_GRACE_MS;

export async function getSessionStatus(ctx: AuthContext, id: string): Promise<FleetSessionStatus> {
  return withTenant(ctx.organizationId, async (db) => {
    const ep = (await db.query<{ rd_session: RemoteDesktopSession | null }>(`SELECT rd_session FROM endpoints WHERE id = $1`, [id])).rows[0];
    if (!ep) throw notFound('Endpoint');
    let fs = await currentFleetSession(db, id);
    if (fs && (await expireApprovalIfDue(db, ctx.organizationId, fs))) return { session: null, fleet_session: null, stream_connected: false };
    // The wait for the user starts when the request reached the computer (after an approval, if any).
    const askedAt = fs ? new Date(fs.approval_decided_at ?? fs.started_at).getTime() : 0;
    if (fs && fs.state === 'waiting_consent' && Date.now() - askedAt > consentStaleMs(fs)) {
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
