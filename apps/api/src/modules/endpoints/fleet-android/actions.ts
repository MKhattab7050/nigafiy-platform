import type { Request } from 'express';
import type { AndroidActionRequest, AndroidActionResult, AndroidCommandKind, EndpointAndroidState, EndpointCommand, FleetPermissionProfile, FleetPolicyTrailItem } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { effectivePolicy, evaluatePolicy, loadProfiles, normalizeIp } from '../fleet-policy/policy.ts';
import { checkStepUpToken, operatorHasMfa } from '../fleet-policy/step-up.ts';
import { ONLINE_WITHIN_MS } from '../repo.ts';
import { apkFileError, auditApkFileProblem, checkApkFileForInstall } from './apks.ts';
import type { AndroidAction } from './schema.ts';

// Android actions (docs/features/android.md §5). Every one needs the Nigafiy agent to be the phone's
// Device Owner (the agent reports its mode in each heartbeat and checks again before acting). The
// endpoint's Fleet access policy applies as it does to a remote session: allowed roles, address
// list, hours and, when the group asks for it, a verification code (MFA step-up). On top of it:
//
//   lock, password_policy, camera     technician and above
//   install_apk, uninstall            admin
//   wipe, release (stop management)   admin, a verification code ALWAYS, and a second admin's
//                                     approval when the group's policy asks for approvals
//   ring, ring_stop                   technician and above; regular app mode is enough, the phone
//                                     must report the "ring" feature (agent 1.0.2+)
//
// Every action, refusal, request and decision is audited; the agent's result comes back on the
// command (endpoint_commands).

export const AGENT_PACKAGE = 'com.nigafiy.agent';

interface Rule {
  kind: AndroidCommandKind;
  adminOnly: boolean;
  /** A verification code even when the group does not ask for one. */
  alwaysMfa: boolean;
  /** Waits for a second admin when the group's policy asks for approvals. */
  approval: boolean;
  /** Needs Device Owner (false: works in regular app mode when the phone reports [feature]). */
  owner: boolean;
  feature?: 'ring';
}

export const ANDROID_RULES: Record<AndroidAction['action'], Rule> = {
  lock: { kind: 'android_lock', adminOnly: false, alwaysMfa: false, approval: false, owner: true },
  password_policy: { kind: 'android_password_policy', adminOnly: false, alwaysMfa: false, approval: false, owner: true },
  camera: { kind: 'android_camera', adminOnly: false, alwaysMfa: false, approval: false, owner: true },
  install_apk: { kind: 'android_install_apk', adminOnly: true, alwaysMfa: false, approval: false, owner: true },
  uninstall: { kind: 'android_uninstall', adminOnly: true, alwaysMfa: false, approval: false, owner: true },
  wipe: { kind: 'android_wipe', adminOnly: true, alwaysMfa: true, approval: true, owner: true },
  release: { kind: 'android_release', adminOnly: true, alwaysMfa: true, approval: true, owner: true },
  ring: { kind: 'android_ring', adminOnly: false, alwaysMfa: false, approval: false, owner: false, feature: 'ring' },
  ring_stop: { kind: 'android_ring_stop', adminOnly: false, alwaysMfa: false, approval: false, owner: false, feature: 'ring' },
};

export const ANDROID_REFUSAL_MESSAGES = {
  not_android: 'This endpoint is not an Android phone',
  android_admin_only: 'Only an admin can do this on an Android phone',
  android_requires_device_owner: 'Nigafiy is not the Device Owner of this phone: only inventory and checks are available',
  android_self_uninstall: 'The Nigafiy agent cannot uninstall itself; use Stop management',
  android_feature_missing: 'The Nigafiy app on this phone does not offer this yet: update the app on the phone',
} as const;

const isAdmin = (role: string) => role === 'owner' || role === 'admin';
const COMMAND_COLUMNS = 'id, endpoint_id, kind, payload, status, output, error, result_data, created_by_name, created_at, delivered_at, completed_at';
const REQUEST_COLUMNS = `r.id, r.endpoint_id, e.name AS endpoint_name, r.action, r.reason, r.requested_email, r.requested_by, r.state,
  r.approver_email, r.decision_note, r.decided_at, r.expires_at, r.mfa_verified, r.command_id, r.created_at`;

interface AndroidEndpoint {
  id: string;
  name: string;
  site_id: string;
  device_id: string | null;
  platform: string;
  status: string;
  kind: string;
  last_heartbeat_at: Date | null;
  android: EndpointAndroidState | null;
}

async function loadEndpoint(db: Db, id: string, lock = false): Promise<AndroidEndpoint | null> {
  return (
    (
      await db.query<AndroidEndpoint>(
        `SELECT id, name, site_id, device_id, platform, status, kind, last_heartbeat_at, android FROM endpoints WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0] ?? null
  );
}

const online = (ep: AndroidEndpoint) => ep.status === 'active' && ep.last_heartbeat_at !== null && ep.last_heartbeat_at.getTime() >= Date.now() - ONLINE_WITHIN_MS;

/** The command payload the agent parses (agents/android-agent core/Commands.kt). */
async function commandPayload(db: Db, orgId: string, endpointId: string, body: AndroidAction, operatorEmail: string): Promise<Record<string, unknown>> {
  switch (body.action) {
    case 'lock':
      return {};
    case 'password_policy':
      return { complexity: body.complexity };
    case 'camera':
      return { disabled: body.disabled };
    case 'install_apk': {
      const apk = (
        await db.query<{ id: string; name: string; file_name: string; size_bytes: string; sha256: string; storage_key: string }>(
          `SELECT id, name, file_name, size_bytes::text, sha256, storage_key FROM fleet_android_apks WHERE id = $1`,
          [body.apk_id],
        )
      ).rows[0];
      if (!apk) throw notFound('APK');
      // The phone would only fail later: refuse now when the stored file is gone or has the wrong size.
      const problem = await checkApkFileForInstall({ storage_key: apk.storage_key, size_bytes: Number(apk.size_bytes) });
      if (problem) {
        await auditApkFileProblem(orgId, apk, problem, 'install', { endpoint_id: endpointId });
        throw apkFileError(problem);
      }
      return { apk_id: apk.id, name: apk.name, file_name: apk.file_name, size_bytes: Number(apk.size_bytes), sha256: apk.sha256 };
    }
    case 'uninstall':
      return { package: body.package };
    case 'wipe':
    case 'release':
      return { reason: body.reason };
    case 'ring':
      return { seconds: body.seconds, operator: operatorEmail };
    case 'ring_stop':
      return {};
  }
}

async function queueAndroidCommand(
  db: Db,
  req: Request,
  ctx: AuthContext,
  ep: AndroidEndpoint,
  kind: AndroidCommandKind,
  payload: Record<string, unknown>,
  meta: Record<string, unknown>,
): Promise<EndpointCommand> {
  const cmd = (
    await db.query<EndpointCommand>(
      `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COMMAND_COLUMNS}`,
      [ctx.organizationId, ep.id, kind, JSON.stringify(payload), ctx.userId, ctx.userEmail],
    )
  ).rows[0]!;
  await audit(db, req, `endpoint.${kind}`, { type: 'endpoint', id: ep.id }, { command_id: cmd.id, ...payload, ...meta });
  await emitEvent(db, ctx.organizationId, {
    siteId: ep.site_id,
    deviceId: ep.device_id,
    type: 'endpoint_command',
    severity: kind === 'android_wipe' || kind === 'android_release' ? 'warning' : 'info',
    title: `Android action "${kind}" sent to "${ep.name}" by ${ctx.userEmail}`,
    details: { endpoint_id: ep.id, endpoint_name: ep.name, command_id: cmd.id, kind, ...payload, requested_by: ctx.userEmail, ...meta },
    source: 'platform',
    occurredAt: new Date(),
  });
  await notifyRealtime(db, ctx.organizationId, 'devices');
  return cmd;
}

type Refused = { refused: true; status: number; code: string; message: string; trail: FleetPolicyTrailItem[]; group: string | null };

/** POST /endpoints/:id/android/actions */
export async function performAndroidAction(req: Request, ctx: AuthContext, endpointId: string, body: AndroidAction): Promise<AndroidActionResult> {
  const rule = ANDROID_RULES[body.action];
  const requestIp = normalizeIp(req.ip);
  const stepUp = checkStepUpToken(body.step_up_token, ctx);
  const hasMfa = await operatorHasMfa(ctx.userId);

  const out = await withTenant(ctx.organizationId, async (db): Promise<Refused | { refused: false; result: AndroidActionResult }> => {
    const ep = await loadEndpoint(db, endpointId);
    if (!ep) throw notFound('Endpoint');
    const refuse = (status: number, code: string, message: string, trail: FleetPolicyTrailItem[] = [], group: string | null = null): Refused => ({
      refused: true,
      status,
      code,
      message,
      trail,
      group,
    });
    if (ep.platform !== 'android') return refuse(409, 'not_android', ANDROID_REFUSAL_MESSAGES.not_android);
    if (rule.adminOnly && !isAdmin(ctx.role)) return refuse(403, 'android_admin_only', ANDROID_REFUSAL_MESSAGES.android_admin_only);

    // The group's access policy, with the verification code forced on for wipe / stop management.
    const eff = (await effectivePolicy(db, ctx.organizationId, endpointId))!;
    const groupName = eff.group?.name ?? null;
    const { requested, max } = await loadProfiles(db, eff.policy, undefined);
    // Android actions do not see a screen: evaluate role, address, hours and MFA with "view" set.
    const asAction = (p: FleetPermissionProfile): FleetPermissionProfile => ({ ...p, view: true });
    const decision = evaluatePolicy({
      policy: { ...eff.policy, mfa_required: eff.policy.mfa_required || rule.alwaysMfa },
      timezone: eff.timezone,
      role: ctx.role,
      requestIp,
      now: new Date(),
      operatorHasMfa: hasMfa,
      stepUp,
      requested: asAction(requested ?? max),
      max: asAction(max),
    });
    if (!decision.ok) return refuse(403, decision.code, decision.message, decision.trail, groupName);
    // Keep the role, address, hours and MFA checks; the profile and session-mode lines do not apply.
    const trail: FleetPolicyTrailItem[] = decision.trail.filter((t) => t.check !== 'profile' && t.check !== 'mode' && t.check !== 'approval');
    if (rule.alwaysMfa && !eff.policy.mfa_required) trail.push({ check: 'mfa', result: 'info', detail: 'always required for this action' });

    if (!online(ep)) throw new AppError(409, 'endpoint_offline', 'This endpoint is not currently online');
    if (!rule.owner) {
      if (!rule.feature || !ep.android?.features?.includes(rule.feature)) {
        return refuse(409, 'android_feature_missing', ANDROID_REFUSAL_MESSAGES.android_feature_missing, [
          ...trail,
          { check: 'feature', result: 'fail', detail: `the app on the phone does not report "${rule.feature}"` },
        ], groupName);
      }
      trail.push({ check: 'feature', result: 'pass', detail: `the app reports "${rule.feature}" (regular app mode is enough)` });
    } else if (ep.android?.mode !== 'device_owner') {
      return refuse(409, 'android_requires_device_owner', ANDROID_REFUSAL_MESSAGES.android_requires_device_owner, [
        ...trail,
        { check: 'device_owner', result: 'fail', detail: ep.android ? `agent reports mode ${ep.android.mode}` : 'the agent has not reported its mode yet' },
      ], groupName);
    }
    if (rule.owner) trail.push({ check: 'device_owner', result: 'pass', detail: 'agent reports Device Owner' });
    if (body.action === 'uninstall' && body.package === AGENT_PACKAGE) {
      return refuse(409, 'android_self_uninstall', ANDROID_REFUSAL_MESSAGES.android_self_uninstall, trail, groupName);
    }
    const payload = await commandPayload(db, ctx.organizationId, ep.id, body, ctx.userEmail);

    if (rule.approval && eff.policy.approval_required) {
      trail.push({ check: 'approval', result: 'info', detail: `a second admin approves (expires after ${eff.policy.approval_ttl_minutes} min)` });
      const reason = (body as { reason: string }).reason;
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO fleet_android_requests (organization_id, endpoint_id, action, payload, reason, requested_by, requested_email, fleet_group_id, policy_trail, mfa_verified, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(mins => $11)) RETURNING id`,
          [ctx.organizationId, ep.id, body.action, JSON.stringify(payload), reason, ctx.userId, ctx.userEmail, eff.group?.id ?? null, JSON.stringify(trail), decision.mfaVerified, eff.policy.approval_ttl_minutes],
        )
      ).rows[0]!.id;
      await audit(db, req, 'fleet.android_request_created', { type: 'endpoint', id: ep.id }, { request_id: id, action: body.action, reason, group: groupName, mfa_verified: decision.mfaVerified, trail });
      await emitEvent(db, ctx.organizationId, {
        siteId: ep.site_id,
        deviceId: ep.device_id,
        type: 'endpoint_command',
        severity: 'warning',
        title: `${ctx.userEmail} asked to ${body.action === 'wipe' ? 'erase' : 'stop managing'} the Android phone "${ep.name}" (waiting for a second admin)`,
        details: { endpoint_id: ep.id, endpoint_name: ep.name, request_id: id, action: body.action, reason },
        source: 'platform',
        occurredAt: new Date(),
      });
      await notifyRealtime(db, ctx.organizationId, 'devices');
      const request = (await db.query<AndroidActionRequest>(`SELECT ${REQUEST_COLUMNS} FROM fleet_android_requests r JOIN endpoints e ON e.id = r.endpoint_id WHERE r.id = $1`, [id])).rows[0]!;
      return { refused: false, result: { state: 'waiting_approval', request } };
    }

    const command = await queueAndroidCommand(db, req, ctx, ep, rule.kind, payload, { group: groupName, mfa_verified: decision.mfaVerified, trail });
    return { refused: false, result: { state: 'queued', command } };
  });

  if (out.refused) {
    await withTenant(ctx.organizationId, (db) =>
      audit(db, req, 'fleet.policy_refused', { type: 'endpoint', id: endpointId }, { code: out.code, what: rule.kind, group: out.group, trail: out.trail }),
    );
    throw new AppError(out.status, out.code, out.message);
  }
  return out.result;
}

// ── Second-admin approvals (wipe, stop management) ──────────────────────────────────────────────

async function expireDue(db: Db): Promise<void> {
  const due = await db.query<{ id: string; endpoint_id: string; action: string }>(
    `UPDATE fleet_android_requests SET state = 'expired', decided_at = now() WHERE state = 'pending' AND expires_at <= now() RETURNING id, endpoint_id, action`,
  );
  for (const r of due.rows) {
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
       VALUES (app_current_org(), NULL, NULL, 'fleet.android_request_expired', 'endpoint', $1, $2, 'system')`,
      [r.endpoint_id, JSON.stringify({ request_id: r.id, action: r.action })],
    );
  }
}

export async function listAndroidRequests(ctx: AuthContext, state: 'pending' | 'decided', limit: number): Promise<AndroidActionRequest[]> {
  return withTenant(ctx.organizationId, async (db) => {
    await expireDue(db);
    const r = await db.query<AndroidActionRequest>(
      `SELECT ${REQUEST_COLUMNS}
         FROM fleet_android_requests r JOIN endpoints e ON e.organization_id = r.organization_id AND e.id = r.endpoint_id
        WHERE ${state === 'pending' ? `r.state = 'pending'` : `r.state <> 'pending'`}
        ORDER BY ${state === 'pending' ? 'r.created_at' : 'r.decided_at DESC NULLS LAST'}
        LIMIT $1`,
      [limit],
    );
    return r.rows;
  });
}

interface LockedRequest extends AndroidActionRequest {
  payload: Record<string, unknown>;
  policy_trail: FleetPolicyTrailItem[];
}

async function lockPending(db: Db, ctx: AuthContext, id: string): Promise<LockedRequest | AppError> {
  const fr = (
    await db.query<LockedRequest>(
      `SELECT ${REQUEST_COLUMNS}, r.payload, r.policy_trail FROM fleet_android_requests r JOIN endpoints e ON e.id = r.endpoint_id WHERE r.id = $1 FOR UPDATE OF r`,
      [id],
    )
  ).rows[0];
  if (!fr) throw notFound('Approval request');
  if (fr.state !== 'pending') throw new AppError(409, 'approval_not_pending', 'This request is no longer waiting for approval');
  if (new Date(fr.expires_at).getTime() <= Date.now()) {
    await expireDue(db);
    // Committed by the caller before the error is thrown.
    return new AppError(409, 'approval_expired', 'This request expired before anyone approved it');
  }
  // Two people: the requester can never approve (or deny) their own request.
  if (fr.requested_by === ctx.userId) throw new AppError(403, 'approval_self', 'Another admin has to decide on your own request');
  return fr;
}

/** POST /fleet/android/requests/:id/approve: queues the command (the phone must still be online and managed). */
export async function approveAndroidRequest(req: Request, ctx: AuthContext, id: string, note: string | undefined): Promise<{ command: EndpointCommand }> {
  const out = await withTenant(ctx.organizationId, async (db): Promise<{ command: EndpointCommand } | AppError> => {
    const fr = await lockPending(db, ctx, id);
    if (fr instanceof AppError) return fr;
    const ep = (await loadEndpoint(db, fr.endpoint_id, true))!;
    if (!online(ep)) throw new AppError(409, 'endpoint_offline', 'The phone is not online: approve when it is back (the request waits until it expires)');
    if (ep.android?.mode !== 'device_owner') throw new AppError(409, 'android_requires_device_owner', ANDROID_REFUSAL_MESSAGES.android_requires_device_owner);
    const rule = ANDROID_RULES[fr.action];
    const trail = [...fr.policy_trail, { check: 'approval', result: 'pass' as const, detail: `approved by ${ctx.userEmail}` }];
    // The command is the requester's; the approver is recorded with it.
    const requester: AuthContext = { ...ctx, userId: fr.requested_by ?? ctx.userId, userEmail: fr.requested_email };
    const cmd = (
      await db.query<EndpointCommand>(
        `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COMMAND_COLUMNS}`,
        [ctx.organizationId, ep.id, rule.kind, JSON.stringify(fr.payload), requester.userId, requester.userEmail],
      )
    ).rows[0]!;
    await db.query(
      `UPDATE fleet_android_requests SET state = 'approved', approver_id = $2, approver_email = $3, decision_note = $4, decided_at = now(), command_id = $5, policy_trail = $6 WHERE id = $1`,
      [fr.id, ctx.userId, ctx.userEmail, note ?? null, cmd.id, JSON.stringify(trail)],
    );
    await audit(db, req, 'fleet.android_request_approved', { type: 'endpoint', id: ep.id }, { request_id: fr.id, action: fr.action, requester: fr.requested_email, note: note ?? null, command_id: cmd.id });
    await audit(db, req, `endpoint.${rule.kind}`, { type: 'endpoint', id: ep.id }, { command_id: cmd.id, ...fr.payload, requested_by: fr.requested_email, approved_by: ctx.userEmail, mfa_verified: fr.mfa_verified, trail });
    await emitEvent(db, ctx.organizationId, {
      siteId: ep.site_id,
      deviceId: ep.device_id,
      type: 'endpoint_command',
      severity: 'warning',
      title: `Android action "${rule.kind}" sent to "${ep.name}": requested by ${fr.requested_email}, approved by ${ctx.userEmail}`,
      details: { endpoint_id: ep.id, endpoint_name: ep.name, command_id: cmd.id, kind: rule.kind, request_id: fr.id, requested_by: fr.requested_email, approved_by: ctx.userEmail },
      source: 'platform',
      occurredAt: new Date(),
    });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return { command: cmd };
  });
  if (out instanceof AppError) throw out;
  return out;
}

export async function denyAndroidRequest(req: Request, ctx: AuthContext, id: string, note: string | undefined): Promise<void> {
  const out = await withTenant(ctx.organizationId, async (db): Promise<AppError | null> => {
    const fr = await lockPending(db, ctx, id);
    if (fr instanceof AppError) return fr;
    await db.query(`UPDATE fleet_android_requests SET state = 'denied', approver_id = $2, approver_email = $3, decision_note = $4, decided_at = now() WHERE id = $1`, [
      fr.id,
      ctx.userId,
      ctx.userEmail,
      note ?? null,
    ]);
    await audit(db, req, 'fleet.android_request_denied', { type: 'endpoint', id: fr.endpoint_id }, { request_id: fr.id, action: fr.action, requester: fr.requested_email, note: note ?? null });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return null;
  });
  if (out) throw out;
}

/** The Android requests of one endpoint (the endpoint page shows them). */
export async function endpointAndroidRequests(ctx: AuthContext, endpointId: string): Promise<AndroidActionRequest[]> {
  return withTenant(ctx.organizationId, async (db) => {
    await expireDue(db);
    return (
      await db.query<AndroidActionRequest>(
        `SELECT ${REQUEST_COLUMNS} FROM fleet_android_requests r JOIN endpoints e ON e.id = r.endpoint_id WHERE r.endpoint_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
        [endpointId],
      )
    ).rows;
  });
}
