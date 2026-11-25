import type { Request } from 'express';
import type { EndpointAndroidState, EndpointCommand, EndpointPlatform, EndpointPolicy } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { ONLINE_WITHIN_MS, commandEvents, payloadForAudit } from '../repo.ts';
import { frameForCommand } from '../remote-desktop/frames.ts';
import { validateCommandForPlatform } from './guards.ts';
import { PROFILE_REFUSAL_MESSAGES, commandRefusal, openSessionFor, refusalFlag } from '../fleet-policy/enforce.ts';
import type { CommandInput } from './schema.ts';

// Remote commands: process/service/power/software actions, logs, diagnostics, user notices, and
// the transport for File Manager (fs_op) and Remote Desktop frames/input (rd_capture / rd_input).
// `req` is passed only for the audit trail.

export async function queueCommand(req: Request, ctx: AuthContext, id: string, body: CommandInput): Promise<EndpointCommand> {
  // The permission profile of an open session (Fleet Pro): refused actions are audited and refused.
  if (body.kind === 'rd_capture' || body.kind === 'rd_input' || body.kind === 'fs_op' || body.kind === 'power_action') {
    const refusal = await withTenant(ctx.organizationId, async (db) => {
      const open = await openSessionFor(db, id, ctx.userId);
      if (!open) return null;
      // The screen and the input of a session belong to the operators in it (holder or joined colleague).
      if ((body.kind === 'rd_capture' || body.kind === 'rd_input') && !open.participant) {
        await audit(db, req, 'fleet.session_refused_action', { type: 'endpoint', id }, { session_id: open.sessionId, code: 'not_a_participant', kind: body.kind, via: 'http' });
        return 'not_a_participant' as const;
      }
      const code = commandRefusal(body, open.perms, open.holder);
      if (code && !(body.kind === 'rd_input' && body.event_kind === 'mouse_move')) {
        await audit(db, req, 'fleet.session_refused_action', { type: 'endpoint', id }, { session_id: open.sessionId, code, kind: body.kind, via: 'http', needs: refusalFlag(code) });
      }
      return code;
    });
    if (refusal === 'not_a_participant') throw new AppError(403, refusal, 'You are not in this session: ask the operator holding it to invite you');
    if (refusal) throw new AppError(403, refusal, PROFILE_REFUSAL_MESSAGES[refusal]);
  }
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
        rd_active: boolean;
        rd_state: string | null;
        kind: string;
        android: EndpointAndroidState | null;
      }>(
        `SELECT id, site_id, device_id, name, platform, status, last_heartbeat_at, policy, kind, android,
                rd_session IS NOT NULL AS rd_active, rd_session->>'state' AS rd_state
           FROM endpoints WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');

    validateCommandForPlatform(ep.platform, body, ctx.role, ep.android);
    // Quick Support (attended, at most Support): the session's screen and files, nothing else.
    if (ep.kind === 'quick_support' && !['rd_capture', 'rd_input', 'fs_op', 'notify_user'].includes(body.kind)) {
      throw new AppError(409, 'quick_support_limited', 'A Quick Support computer allows the session and its files only');
    }
    // Quick Support is attended only: its files open to the operators of the session the person
    // accepted, never before (the code list shows waiting computers to every technician). SEC-02.
    if (ep.kind === 'quick_support' && body.kind === 'fs_op') {
      if (!ep.rd_active) throw new AppError(409, 'no_remote_session', 'Connect with the Quick Support code and PIN first; the person has to accept the session');
      if ((ep.rd_state ?? 'active') !== 'active') throw new AppError(409, 'consent_pending', 'The user has not accepted the remote support session yet');
      const open = await openSessionFor(db, id, ctx.userId);
      if (!open?.participant) {
        await audit(db, req, 'fleet.session_refused_action', { type: 'endpoint', id }, { session_id: open?.sessionId ?? null, code: 'not_a_participant', kind: body.kind, via: 'http' });
        throw new AppError(403, 'not_a_participant', 'You are not in this session: ask the operator holding it to invite you');
      }
    }

    // Screen capture and input only inside a started session: that is where the user is told.
    if ((body.kind === 'rd_capture' || body.kind === 'rd_input') && !ep.rd_active) {
      throw new AppError(409, 'no_remote_session', 'Start a remote desktop session first; the user is notified when it starts');
    }
    // Under the "prompt" policy nothing is seen or touched before the user accepts.
    if ((body.kind === 'rd_capture' || body.kind === 'rd_input') && ep.rd_state && ep.rd_state !== 'active') {
      throw new AppError(409, 'consent_pending', 'The user has not accepted the remote support session yet');
    }

    if (ep.status !== 'active' || !ep.last_heartbeat_at || ep.last_heartbeat_at.getTime() < Date.now() - ONLINE_WITHIN_MS) {
      throw new AppError(409, 'endpoint_offline', 'This endpoint is not currently online');
    }

    const { kind, ...rawPayload } = body;
    const payload: Record<string, unknown> = { ...rawPayload };

    if (body.kind === 'rd_input') {
      payload.kind = body.event_kind;
      delete payload.event_kind;
    }
    if (body.kind === 'fs_op' && ep.policy?.allowed_fs_roots && ep.policy.allowed_fs_roots.length > 0) {
      payload.allowed_roots = ep.policy.allowed_fs_roots;
    }

    const inserted = await db.query<EndpointCommand>(
      `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, endpoint_id, kind, payload, status, output, error, result_data, created_by_name, created_at, delivered_at, completed_at`,
      [ctx.organizationId, id, kind, JSON.stringify(payload), ctx.userId, ctx.userEmail],
    );
    const created = inserted.rows[0]!;

    // Avoid spamming audit logs on high-frequency remote desktop frame captures or mouse moves,
    // while auditing every mutating file op, process/service/power/software action, and session start/stop.
    const isHighFreqStream =
      kind === 'rd_capture' ||
      (kind === 'rd_input' && body.event_kind === 'mouse_move') ||
      (kind === 'fs_op' && (body.op === 'roots' || body.op === 'list'));

    const recorded = payloadForAudit(kind, payload);
    if (!isHighFreqStream) {
      await audit(db, req, `endpoint.${kind}`, { type: 'endpoint', id }, { command_id: created.id, ...recorded });
    }

    if (kind !== 'refresh_inventory' && !isHighFreqStream) {
      await emitEvent(db, ctx.organizationId, {
        siteId: ep.site_id,
        deviceId: ep.device_id,
        type: 'endpoint_command',
        severity: kind === 'power_action' && (body.action === 'restart' || body.action === 'shutdown') ? 'warning' : 'info',
        title: `Remote action "${kind}" sent to "${ep.name}" by ${ctx.userEmail}`,
        details: { endpoint_id: ep.id, endpoint_name: ep.name, command_id: created.id, kind, ...recorded, requested_by: ctx.userEmail },
        source: 'platform',
        occurredAt: new Date(),
      });
    }

    await notifyRealtime(db, ctx.organizationId, 'devices');
    return created;
  });
}

export function waitForCommandSignal(commandId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const event = `done:${commandId}`;
    const onDone = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      commandEvents.removeListener(event, onDone);
      resolve();
    }, timeoutMs);
    commandEvents.once(event, onDone);
  });
}

/**
 * Waits on `commandEvents` (woken on every API instance through COMMAND_DONE_CHANNEL; a 400 ms
 * re-check covers a lost notification, up to `waitMs`)
 * for the command to complete or fail. A file download chunk's base64 payload is stripped from
 * `endpoint_commands` once it has been read and returned. A remote desktop frame was never stored:
 * its image is taken from the transient frame relay (remote-desktop/frames.ts).
 */
export async function waitForCommandResult(organizationId: string, endpointId: string, commandId: string, waitMs: number): Promise<EndpointCommand | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    await waitForCommandSignal(commandId, Math.min(400, remaining));
    const latest = await withTenant(organizationId, async (db) => {
      const row = (
        await db.query<EndpointCommand>(
          `SELECT id, endpoint_id, kind, payload, status, output, error, result_data, created_by_name, created_at, delivered_at, completed_at
             FROM endpoint_commands WHERE id = $1 AND endpoint_id = $2`,
          [commandId, endpointId],
        )
      ).rows[0];
      if (row && (row.status === 'completed' || row.status === 'failed') && row.result_data && row.kind === 'fs_op' && (row.payload?.op === 'download' || row.payload?.op === 'download_chunk')) {
        await db.query(`UPDATE endpoint_commands SET result_data = result_data - 'data_base64' WHERE id = $1`, [commandId]);
      }
      return row;
    });
    if (latest && (latest.status === 'completed' || latest.status === 'failed')) {
      return latest.kind === 'rd_capture' && latest.status === 'completed' ? withRelayedFrame(latest, endpointId, deadline) : latest;
    }
  }
  return null;
}

/**
 * Puts the frame's image back into an rd_capture result. On another API instance than the one the
 * agent uploaded to, the image may arrive (pg_notify) a moment after the completion is visible: wait
 * for it briefly. An unchanged screen carries no image (the viewer keeps the previous one).
 */
async function withRelayedFrame(cmd: EndpointCommand, endpointId: string, deadline: number): Promise<EndpointCommand> {
  const meta = (cmd.result_data ?? {}) as Record<string, unknown>;
  if (meta.unchanged === true || !(Number(meta.byte_length) > 0)) return cmd;
  const until = Math.min(deadline, Date.now() + 1_500);
  for (;;) {
    const frame = frameForCommand(endpointId, cmd.id);
    if (frame?.jpeg_base64) return { ...cmd, result_data: { ...meta, jpeg_base64: frame.jpeg_base64 } };
    if (Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The image is gone (session ended, or a newer frame replaced it): the metadata alone, flagged.
  return { ...cmd, result_data: { ...meta, image_unavailable: true } };
}
