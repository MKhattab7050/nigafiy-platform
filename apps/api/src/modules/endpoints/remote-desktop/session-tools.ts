import type { Request } from 'express';
import {
  FLEET_PERMISSION_KEYS,
  type FleetPermissions,
  type FleetRecording,
  type FleetRecordingMode,
  type FleetRecordingTimelineItem,
  type FleetSessionParticipant,
  type FleetWakeRequest,
  type RemoteDesktopSession,
  type Role,
} from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { queueWakeOnLan } from '../../devices/index.ts';
import { ONLINE_WITHIN_MS } from '../repo.ts';
import { effectivePolicy, evaluatePolicy, loadProfiles, normalizeIp } from '../fleet-policy/policy.ts';
import { sessionPermissions } from '../fleet-policy/profiles.ts';
import { checkStepUpToken, operatorHasMfa } from '../fleet-policy/step-up.ts';
import { createRecording, listSegments, readSegmentForPlayback, removeRecordingFiles } from './recording.ts';
import { RD_STREAM_CHANNEL } from './sessions.ts';
import type { ParticipantInvite, PrintAudit, RecordingListQuery, TransferAudit, WakeCreate } from './schema.ts';

/*
 * Fleet Pro in-session tools on the REST side (migration 036): recording on/off, several operators
 * (invite, join through the access policy, hand over, remove), Wake-on-LAN then connect, and the
 * audit of printing and drag-and-drop transfers (names, sizes and SHA-256 only, never contents).
 * Whatever changes who is in the session or whether it is recorded is pushed to the agent
 * (rd_session_update: the banner lists every operator and shows the recording mark) and to the
 * stream hubs (pg_notify on ld_rd_stream: "rec|E", "part|E|user").
 */

type SessionRow = RemoteDesktopSession & { operator_user_id?: string };
const RANK: Record<Role, number> = { viewer: 0, technician: 1, admin: 2, owner: 3 };
const INVITE_TTL_MINUTES = 15;

export async function recordingRule(db: Db, endpointId: string): Promise<{ mode: FleetRecordingMode; retentionDays: number; userMayView: boolean }> {
  const r = await db.query<{ mode: FleetRecordingMode | null; days: number | null; may: boolean | null }>(
    `SELECT g.recording_mode AS mode, g.recording_retention_days AS days, g.user_may_view_recordings AS may
       FROM endpoints e LEFT JOIN fleet_groups g ON g.organization_id = e.organization_id AND g.id = e.fleet_group_id WHERE e.id = $1`,
    [endpointId],
  );
  const row = r.rows[0];
  // Endpoints in no group: recording is the operator's choice (profile "record"), kept 30 days.
  return { mode: row?.mode ?? 'optional', retentionDays: row?.days ?? 30, userMayView: row?.may ?? false };
}

async function openSession(db: Db, endpointId: string): Promise<SessionRow> {
  const r = await db.query<{ rd_session: SessionRow | null }>(`SELECT rd_session FROM endpoints WHERE id = $1 FOR UPDATE`, [endpointId]);
  if (!r.rows[0]) throw notFound('Endpoint');
  const s = r.rows[0].rd_session;
  if (!s?.fleet_session_id) throw new AppError(409, 'no_remote_session', 'No remote desktop session is open on this computer');
  return s;
}

function mayManage(ctx: AuthContext, s: SessionRow): boolean {
  return s.operator_user_id === ctx.userId || RANK[ctx.role] >= RANK.admin;
}

async function joinedEmails(db: Db, fleetSessionId: string): Promise<string[]> {
  const r = await db.query<{ email: string }>(
    `SELECT email FROM fleet_session_participants WHERE fleet_session_id = $1 AND state = 'joined' ORDER BY (role = 'holder') DESC, joined_at`,
    [fleetSessionId],
  );
  return r.rows.map((x) => x.email);
}

/** The banner and every viewer learn who is in the session and whether it is recorded. */
export async function pushSessionUpdate(db: Db, orgId: string, endpointId: string, s: SessionRow, by: { userId: string | null; email: string }): Promise<SessionRow> {
  const operators = await joinedEmails(db, s.fleet_session_id!);
  const next: SessionRow = { ...s, operators: operators.length ? operators : [s.operator_email] };
  await db.query(`UPDATE endpoints SET rd_session = $2::jsonb WHERE id = $1`, [endpointId, JSON.stringify(next)]);
  await db.query(
    `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name) VALUES ($1,$2,'rd_session_update',$3,$4,$5)`,
    [orgId, endpointId, JSON.stringify({ session_id: s.id, operators: next.operators, recording: Boolean(next.recording_id) }), by.userId, by.email],
  );
  await db.query('SELECT pg_notify($1, $2)', [RD_STREAM_CHANNEL, `rec|${endpointId}|${next.recording_id ?? ''}`]);
  return next;
}

// ── Recording ───────────────────────────────────────────────────────────────────────────────────

export async function setRecording(req: Request, ctx: AuthContext, endpointId: string, on: boolean): Promise<{ recording_id: string | null }> {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await openSession(db, endpointId);
    if (!mayManage(ctx, s)) throw new AppError(403, 'not_session_holder', 'Only the operator holding the session or an admin can change recording');
    const rule = await recordingRule(db, endpointId);
    if (on) {
      if (s.recording_id) return { recording_id: s.recording_id };
      if (rule.mode === 'off') throw new AppError(403, 'recording_disabled_by_policy', 'The access policy of this computer does not allow recording sessions');
      if (!sessionPermissions(s).record) throw new AppError(403, 'profile_forbids_record', 'The permission profile of this session does not allow recording');
      const id = await createRecording(db, { orgId: ctx.organizationId, endpointId, fleetSessionId: s.fleet_session_id!, publicId: s.id, email: ctx.userEmail, retentionDays: rule.retentionDays });
      await db.query(`UPDATE fleet_sessions SET recording_id = $2, recording_mode = $3 WHERE id = $1`, [s.fleet_session_id, id, rule.mode]);
      await pushSessionUpdate(db, ctx.organizationId, endpointId, { ...s, recording_id: id, recording_enabled: true }, { userId: ctx.userId, email: ctx.userEmail });
      await audit(db, req, 'fleet.recording_started', { type: 'endpoint', id: endpointId }, { recording_id: id, session_id: s.id, retention_days: rule.retentionDays });
      return { recording_id: id };
    }
    if (!s.recording_id) return { recording_id: null };
    if (rule.mode === 'required') throw new AppError(403, 'recording_required_by_policy', 'The access policy of this computer requires every session to be recorded');
    await db.query(`UPDATE fleet_recordings SET state = 'complete', ended_at = now() WHERE id = $1 AND state = 'recording'`, [s.recording_id]);
    await pushSessionUpdate(db, ctx.organizationId, endpointId, { ...s, recording_id: null, recording_enabled: false }, { userId: ctx.userId, email: ctx.userEmail });
    await audit(db, req, 'fleet.recording_stopped', { type: 'endpoint', id: endpointId }, { recording_id: s.recording_id, session_id: s.id });
    return { recording_id: null };
  });
}

const RECORDING_COLUMNS = `r.id, r.endpoint_id, r.fleet_session_id, r.session_public_id, r.state, r.started_by_email, r.started_at, r.ended_at,
  r.frames::float8 AS frames, r.input_events::float8 AS input_events, r.bytes::float8 AS bytes, r.segments, r.retention_days, r.retention_until,
  r.error, r.deleted_at, r.delete_reason, r.deleted_by_email, e.name AS endpoint_name`;

/** Technicians see the recordings of sessions they started or joined; admins and owners see all. */
function visibleClause(ctx: AuthContext, param: number): string {
  if (RANK[ctx.role] >= RANK.admin) return `($${param}::uuid IS NOT NULL)`;
  return `EXISTS (SELECT 1 FROM fleet_session_participants p WHERE p.fleet_session_id = r.fleet_session_id AND p.user_id = $${param})`;
}

export async function listRecordings(ctx: AuthContext, q: RecordingListQuery): Promise<FleetRecording[]> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<FleetRecording>(
      `SELECT ${RECORDING_COLUMNS} FROM fleet_recordings r JOIN endpoints e ON e.organization_id = r.organization_id AND e.id = r.endpoint_id
        WHERE ($1::uuid IS NULL OR r.endpoint_id = $1) AND ($2::uuid IS NULL OR r.fleet_session_id = $2) AND ${visibleClause(ctx, 4)}
        ORDER BY r.started_at DESC LIMIT $3`,
      [q.endpoint_id ?? null, q.fleet_session_id ?? null, q.limit, ctx.userId],
    );
    return r.rows;
  });
}

async function recordingFor(db: Db, ctx: AuthContext, id: string): Promise<FleetRecording> {
  const r = await db.query<FleetRecording>(
    `SELECT ${RECORDING_COLUMNS} FROM fleet_recordings r JOIN endpoints e ON e.organization_id = r.organization_id AND e.id = r.endpoint_id
      WHERE r.id = $1 AND ${visibleClause(ctx, 2)}`,
    [id, ctx.userId],
  );
  if (!r.rows[0]) throw notFound('Recording');
  return r.rows[0];
}

export async function getRecording(req: Request, ctx: AuthContext, id: string): Promise<{ recording: FleetRecording; segments: ReturnType<typeof listSegments>; timeline: FleetRecordingTimelineItem[] }> {
  return withTenant(ctx.organizationId, async (db) => {
    const rec = await recordingFor(db, ctx, id);
    // The session's audit trail, for the timeline beside the picture.
    const t = await db.query<FleetRecordingTimelineItem>(
      `SELECT created_at AS at, action, user_email, metadata FROM audit_logs
        WHERE target_type = 'endpoint' AND target_id = $1 AND metadata->>'session_id' = $2 ORDER BY created_at LIMIT 2000`,
      [rec.endpoint_id, rec.session_public_id],
    );
    await audit(db, req, 'fleet.recording_viewed', { type: 'endpoint', id: rec.endpoint_id }, { recording_id: id, session_id: rec.session_public_id });
    return { recording: rec, segments: rec.state === 'deleted' ? [] : listSegments(ctx.organizationId, id), timeline: t.rows };
  });
}

export async function playbackSegment(ctx: AuthContext, id: string, name: string): Promise<{ body: Buffer; records: number; error: string | null }> {
  const rec = await withTenant(ctx.organizationId, (db) => recordingFor(db, ctx, id));
  if (rec.state === 'deleted') throw new AppError(410, 'recording_deleted', 'This recording was deleted');
  const out = await readSegmentForPlayback(ctx.organizationId, id, name);
  if (!out) throw notFound('Recording segment');
  return out;
}

export async function deleteRecording(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const rec = await recordingFor(db, ctx, id);
    if (rec.state === 'recording') throw new AppError(409, 'recording_in_progress', 'Stop the recording (or end the session) before deleting it');
    if (rec.state === 'deleted') return;
    removeRecordingFiles(ctx.organizationId, id);
    await db.query(`UPDATE fleet_recordings SET state = 'deleted', deleted_at = now(), delete_reason = 'admin', deleted_by_email = $2 WHERE id = $1`, [id, ctx.userEmail]);
    await audit(db, req, 'fleet.recording_deleted', { type: 'endpoint', id: rec.endpoint_id }, { recording_id: id, session_id: rec.session_public_id, reason: 'admin' });
  });
}

// ── Several operators ───────────────────────────────────────────────────────────────────────────

const PARTICIPANT_COLUMNS = `user_id, email, role, state, permissions, invited_by_email, invited_at, invite_expires_at, joined_at, left_at, mfa_verified`;

export async function listParticipants(ctx: AuthContext, endpointId: string): Promise<FleetSessionParticipant[]> {
  return withTenant(ctx.organizationId, async (db) => {
    const s = (await db.query<{ rd_session: SessionRow | null }>(`SELECT rd_session FROM endpoints WHERE id = $1`, [endpointId])).rows[0];
    if (!s) throw notFound('Endpoint');
    if (!s.rd_session?.fleet_session_id) return [];
    await db.query(`UPDATE fleet_session_participants SET state = 'expired' WHERE fleet_session_id = $1 AND state = 'invited' AND invite_expires_at < now()`, [s.rd_session.fleet_session_id]);
    return (
      await db.query<FleetSessionParticipant>(
        `SELECT ${PARTICIPANT_COLUMNS} FROM fleet_session_participants WHERE fleet_session_id = $1 ORDER BY (role = 'holder') DESC, invited_at`,
        [s.rd_session.fleet_session_id],
      )
    ).rows;
  });
}

function intersect(a: FleetPermissions, b: Partial<FleetPermissions>): FleetPermissions {
  return Object.fromEntries(FLEET_PERMISSION_KEYS.map((k) => [k, a[k] && b[k] === true])) as FleetPermissions;
}

export async function inviteParticipant(req: Request, ctx: AuthContext, endpointId: string, body: ParticipantInvite): Promise<FleetSessionParticipant> {
  // Identity lookup (users are not a tenant table): an active member of this organization only.
  const who = (
    await withSystem((db) =>
      db.query<{ email: string; role: Role }>(
        `SELECT u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active'`,
        [body.user_id, ctx.organizationId],
      ),
    )
  ).rows[0];
  return withTenant(ctx.organizationId, async (db) => {
    const s = await openSession(db, endpointId);
    if (!mayManage(ctx, s)) throw new AppError(403, 'not_session_holder', 'Only the operator holding the session or an admin can invite a colleague');
    if (body.user_id === ctx.userId) throw new AppError(422, 'invite_self', 'You are already in this session');
    if (!who) throw notFound('User');
    if (RANK[who.role] < RANK.technician) throw new AppError(422, 'invitee_role', 'Only technicians, admins and owners can join a remote support session');
    // Never more than the session allows; the policy check at join time may narrow it further.
    const perms = intersect(sessionPermissions(s), body.permissions ?? sessionPermissions(s));
    const r = await db.query<FleetSessionParticipant>(
      `INSERT INTO fleet_session_participants (organization_id, fleet_session_id, endpoint_id, user_id, email, role, state, permissions, invited_by_email, invite_expires_at)
       VALUES ($1,$2,$3,$4,$5,'colleague','invited',$6,$7, now() + make_interval(mins => $8))
       ON CONFLICT (fleet_session_id, user_id) WHERE user_id IS NOT NULL
       DO UPDATE SET state = 'invited', permissions = EXCLUDED.permissions, invited_by_email = EXCLUDED.invited_by_email, invited_at = now(),
                     invite_expires_at = EXCLUDED.invite_expires_at, left_at = NULL
         WHERE fleet_session_participants.role <> 'holder'
       RETURNING ${PARTICIPANT_COLUMNS}`,
      [ctx.organizationId, s.fleet_session_id, endpointId, body.user_id, who.email, JSON.stringify(perms), ctx.userEmail, INVITE_TTL_MINUTES],
    );
    if (!r.rows[0]) throw new AppError(409, 'already_holder', 'This operator holds the session');
    await audit(db, req, 'fleet.participant_invited', { type: 'endpoint', id: endpointId }, { session_id: s.id, invitee: who.email, permissions: perms });
    return r.rows[0];
  });
}

/** The invited colleague joins: the access policy decides for their own role, address and MFA. */
export async function joinSession(req: Request, ctx: AuthContext, endpointId: string, stepUpToken: string | undefined): Promise<FleetSessionParticipant> {
  const requestIp = normalizeIp(req.ip);
  const stepUp = checkStepUpToken(stepUpToken, ctx);
  const hasMfa = await operatorHasMfa(ctx.userId);
  const out = await withTenant(ctx.organizationId, async (db) => {
    const s = await openSession(db, endpointId);
    const inv = (
      await db.query<FleetSessionParticipant>(
        `SELECT ${PARTICIPANT_COLUMNS} FROM fleet_session_participants WHERE fleet_session_id = $1 AND user_id = $2 FOR UPDATE`,
        [s.fleet_session_id, ctx.userId],
      )
    ).rows[0];
    if (!inv || (inv.state !== 'invited' && inv.state !== 'joined')) throw new AppError(403, 'not_invited', 'You were not invited to this session');
    if (inv.state === 'joined') return { ok: true as const, p: inv };
    if (inv.invite_expires_at && new Date(inv.invite_expires_at).getTime() < Date.now()) {
      await db.query(`UPDATE fleet_session_participants SET state = 'expired' WHERE fleet_session_id = $1 AND user_id = $2`, [s.fleet_session_id, ctx.userId]);
      throw new AppError(410, 'invite_expired', 'The invitation expired');
    }
    const eff = (await effectivePolicy(db, ctx.organizationId, endpointId))!;
    const fsRow = (await db.query<{ profile_id: string | null }>(`SELECT profile_id FROM fleet_sessions WHERE id = $1`, [s.fleet_session_id])).rows[0];
    const { requested, max } = await loadProfiles(db, eff.policy, fsRow?.profile_id ?? undefined);
    if (!requested) throw new AppError(422, 'profile_not_found', 'The permission profile does not exist');
    const decision = evaluatePolicy({ policy: eff.policy, timezone: eff.timezone, role: ctx.role, requestIp, now: new Date(), operatorHasMfa: hasMfa, stepUp, requested, max });
    if (!decision.ok) return { ok: false as const, code: decision.code, message: decision.message, trail: decision.trail, sessionId: s.id };
    const perms = intersect(inv.permissions, decision.permissions);
    const p = (
      await db.query<FleetSessionParticipant>(
        `UPDATE fleet_session_participants SET state = 'joined', joined_at = now(), permissions = $3, policy_trail = $4, mfa_verified = $5, request_ip = $6::inet
          WHERE fleet_session_id = $1 AND user_id = $2 RETURNING ${PARTICIPANT_COLUMNS}`,
        [s.fleet_session_id, ctx.userId, JSON.stringify(perms), JSON.stringify(decision.trail), decision.mfaVerified, requestIp],
      )
    ).rows[0]!;
    await pushSessionUpdate(db, ctx.organizationId, endpointId, s, { userId: ctx.userId, email: ctx.userEmail });
    await audit(db, req, 'fleet.participant_joined', { type: 'endpoint', id: endpointId }, { session_id: s.id, permissions: perms, trail: decision.trail });
    return { ok: true as const, p };
  });
  if (!out.ok) {
    await withTenant(ctx.organizationId, (db) =>
      audit(db, req, 'fleet.policy_refused', { type: 'endpoint', id: endpointId }, { code: out.code, trail: out.trail, session_id: out.sessionId, as: 'participant' }),
    );
    throw new AppError(out.code === 'profile_no_view' ? 422 : 403, out.code, out.message);
  }
  return out.p;
}

async function endParticipation(req: Request, ctx: AuthContext, endpointId: string, userId: string, state: 'left' | 'removed' | 'declined'): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const s = await openSession(db, endpointId);
    if (userId !== ctx.userId && !mayManage(ctx, s)) throw new AppError(403, 'not_session_holder', 'Only the operator holding the session or an admin can remove an operator');
    if (userId === s.operator_user_id) throw new AppError(409, 'holder_cannot_leave', 'The operator holding the session ends it, or hands it over first');
    const r = await db.query<{ email: string }>(
      `UPDATE fleet_session_participants SET state = $3, left_at = now() WHERE fleet_session_id = $1 AND user_id = $2 AND state IN ('invited', 'joined') RETURNING email`,
      [s.fleet_session_id, userId, state],
    );
    if (!r.rows[0]) throw notFound('Participant');
    await pushSessionUpdate(db, ctx.organizationId, endpointId, s, { userId: ctx.userId, email: ctx.userEmail });
    await db.query('SELECT pg_notify($1, $2)', [RD_STREAM_CHANNEL, `part|${endpointId}|${userId}`]);
    await audit(db, req, `fleet.participant_${state}`, { type: 'endpoint', id: endpointId }, { session_id: s.id, participant: r.rows[0].email });
  });
}

export const leaveSession = (req: Request, ctx: AuthContext, endpointId: string) => endParticipation(req, ctx, endpointId, ctx.userId, 'left');
export const declineInvite = (req: Request, ctx: AuthContext, endpointId: string) => endParticipation(req, ctx, endpointId, ctx.userId, 'declined');
export const removeParticipant = (req: Request, ctx: AuthContext, endpointId: string, userId: string) => endParticipation(req, ctx, endpointId, userId, 'removed');

/** The holder hands the session to a colleague who joined; both stay in it. */
export async function handOver(req: Request, ctx: AuthContext, endpointId: string, userId: string): Promise<RemoteDesktopSession> {
  return withTenant(ctx.organizationId, async (db) => {
    const s = await openSession(db, endpointId);
    if (!mayManage(ctx, s)) throw new AppError(403, 'not_session_holder', 'Only the operator holding the session or an admin can hand it over');
    const to = (
      await db.query<{ email: string }>(`SELECT email FROM fleet_session_participants WHERE fleet_session_id = $1 AND user_id = $2 AND state = 'joined'`, [s.fleet_session_id, userId])
    ).rows[0];
    if (!to) throw new AppError(409, 'not_joined', 'Hand over only to an operator who joined the session');
    await db.query(`UPDATE fleet_session_participants SET role = 'colleague' WHERE fleet_session_id = $1 AND role = 'holder'`, [s.fleet_session_id]);
    await db.query(`UPDATE fleet_session_participants SET role = 'holder' WHERE fleet_session_id = $1 AND user_id = $2`, [s.fleet_session_id, userId]);
    await db.query(`UPDATE fleet_sessions SET operator_user_id = $2, operator_email = $3 WHERE id = $1`, [s.fleet_session_id, userId, to.email]);
    const next = await pushSessionUpdate(db, ctx.organizationId, endpointId, { ...s, operator_user_id: userId, operator_email: to.email }, { userId: ctx.userId, email: ctx.userEmail });
    await audit(db, req, 'fleet.session_handed_over', { type: 'endpoint', id: endpointId }, { session_id: s.id, from: s.operator_email, to: to.email });
    const { operator_user_id: _u, ...pub } = next;
    return pub;
  });
}

/** Viewer sockets: may this user watch the session, and with what permissions? */
export async function participantAccess(db: Db, s: SessionRow, userId: string): Promise<FleetPermissions | null> {
  if (s.operator_user_id === userId) return sessionPermissions(s);
  if (!s.fleet_session_id) return null;
  const p = (
    await db.query<{ permissions: FleetPermissions }>(`SELECT permissions FROM fleet_session_participants WHERE fleet_session_id = $1 AND user_id = $2 AND state = 'joined'`, [
      s.fleet_session_id,
      userId,
    ])
  ).rows[0];
  return p ? intersect(sessionPermissions(s), p.permissions) : null;
}

// ── Wake-on-LAN then connect ────────────────────────────────────────────────────────────────────

const WAKE_COLUMNS = `id, endpoint_id, device_id, requested_by_email, reason, profile_id, state, collector_name, wol_command_id,
  host(broadcast) AS broadcast, mac::text AS mac, timeout_s, timeout_at, online_at, decided_at, session_public_id, error, created_at`;

export async function requestWake(req: Request, ctx: AuthContext, endpointId: string, body: WakeCreate): Promise<FleetWakeRequest> {
  return withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{ device_id: string | null; status: string; last_heartbeat_at: Date | null; name: string }>(
        `SELECT device_id, status, last_heartbeat_at, name FROM endpoints WHERE id = $1`,
        [endpointId],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    if (ep.status !== 'active') throw new AppError(409, 'endpoint_not_active', 'This endpoint is not enrolled');
    if (ep.last_heartbeat_at && ep.last_heartbeat_at.getTime() > Date.now() - ONLINE_WITHIN_MS) throw new AppError(409, 'endpoint_online', 'The computer is online: connect directly');
    if (!ep.device_id) throw new AppError(409, 'no_device', 'The computer is not linked to a device the Sensor has seen, so it cannot be woken');
    await db.query(`UPDATE fleet_wake_requests SET state = 'cancelled', decided_at = now() WHERE endpoint_id = $1 AND state IN ('waking', 'online')`, [endpointId]);
    // The same scope-checked Sensor path as the device page (an authorized range, an online collector).
    const w = await queueWakeOnLan(db, ctx.organizationId, ep.device_id, ctx.userId);
    const row = (
      await db.query<FleetWakeRequest>(
        `INSERT INTO fleet_wake_requests (organization_id, endpoint_id, device_id, requested_by, requested_by_email, reason, profile_id, collector_id, collector_name,
                                         wol_command_id, broadcast, mac, timeout_s, timeout_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::inet,$12::macaddr,$13::int, now() + make_interval(secs => $13::int)) RETURNING ${WAKE_COLUMNS}`,
        [ctx.organizationId, endpointId, ep.device_id, ctx.userId, ctx.userEmail, body.reason, body.profile_id ?? null, w.collector_id, w.collector, w.command_id, w.broadcast, w.mac, body.timeout_s],
      )
    ).rows[0]!;
    await audit(db, req, 'fleet.wake_requested', { type: 'endpoint', id: endpointId }, { wake_request_id: row.id, collector: w.collector, broadcast: w.broadcast, mac: w.mac, timeout_s: body.timeout_s, reason: body.reason });
    return row;
  });
}

/** The latest request, its state brought up to date (agent online, or the timeout passed). */
export async function wakeStatus(ctx: AuthContext, endpointId: string): Promise<FleetWakeRequest | null> {
  return withTenant(ctx.organizationId, async (db) => {
    await db.query(
      `UPDATE fleet_wake_requests w SET state = 'online', online_at = now()
         FROM endpoints e WHERE e.id = w.endpoint_id AND w.endpoint_id = $1 AND w.state = 'waking' AND e.last_heartbeat_at > w.created_at
          AND e.last_heartbeat_at > now() - make_interval(secs => $2)`,
      [endpointId, Math.round(ONLINE_WITHIN_MS / 1000)],
    );
    await db.query(`UPDATE fleet_wake_requests SET state = 'timed_out', decided_at = now() WHERE endpoint_id = $1 AND state IN ('waking', 'online') AND timeout_at < now()`, [endpointId]);
    const r = await db.query<FleetWakeRequest>(`SELECT ${WAKE_COLUMNS} FROM fleet_wake_requests WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 1`, [endpointId]);
    return r.rows[0] ?? null;
  });
}

export async function cancelWake(req: Request, ctx: AuthContext, endpointId: string, wakeId: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`UPDATE fleet_wake_requests SET state = 'cancelled', decided_at = now() WHERE id = $1 AND endpoint_id = $2 AND state IN ('waking', 'online')`, [wakeId, endpointId]);
    if (!r.rowCount) throw notFound('Wake request');
    await audit(db, req, 'fleet.wake_cancelled', { type: 'endpoint', id: endpointId }, { wake_request_id: wakeId });
  });
}

/** Called by startSession when the session was started from a wake request. */
export async function markWakeConnected(db: Db, endpointId: string, wakeId: string, publicId: string): Promise<void> {
  await db.query(
    `UPDATE fleet_wake_requests SET state = 'connected', decided_at = now(), session_public_id = $3 WHERE id = $1 AND endpoint_id = $2 AND state IN ('waking', 'online')`,
    [wakeId, endpointId, publicId],
  );
}

// ── Printing and drag-and-drop transfers (audit only: the bytes travel through fs_op commands) ──

async function holderWithFiles(db: Db, ctx: AuthContext, endpointId: string): Promise<SessionRow> {
  const s = await openSession(db, endpointId);
  const perms = await participantAccess(db, s, ctx.userId);
  if (!perms) throw new AppError(403, 'not_a_participant', 'You are not in this session');
  if (!perms.files) throw new AppError(403, 'profile_forbids_files', 'The permission profile of your session on this computer does not allow file transfer');
  return s;
}

export async function auditPrint(req: Request, ctx: AuthContext, endpointId: string, body: PrintAudit): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const s = await holderWithFiles(db, ctx, endpointId);
    await audit(db, req, 'fleet.session_print', { type: 'endpoint', id: endpointId }, { session_id: s.id, name: body.name, bytes: body.bytes, sha256: body.sha256, mime: body.mime });
  });
}

export async function auditTransfer(req: Request, ctx: AuthContext, endpointId: string, body: TransferAudit): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const s = await holderWithFiles(db, ctx, endpointId);
    await db.query(`UPDATE fleet_sessions SET files_transferred = files_transferred + 1 WHERE id = $1`, [s.fleet_session_id]);
    await audit(db, req, 'fleet.session_file_transfer', { type: 'endpoint', id: endpointId }, { session_id: s.id, direction: body.direction, via: body.via, name: body.name, bytes: body.bytes, sha256: body.sha256 });
  });
}
