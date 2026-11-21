import type { Request } from 'express';
import type { EndpointPlatform, EndpointPolicy, RemoteDesktopFrame, RemoteDesktopSession } from '@lan-detective/shared-types';
import { audit } from '../../../common/audit.ts';
import { randomToken } from '../../../common/crypto.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { buildCapabilities } from '../capabilities.ts';
import { ONLINE_WITHIN_MS, queueUserNotice } from '../repo.ts';
import type { RdStart } from './schema.ts';

// Live Remote Desktop session management. Frames and input travel as rd_capture / rd_input
// commands (commands/service.ts), which are only accepted while a session is started here.
// `req` is passed only for the audit trail.

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
        last_rd_frame: RemoteDesktopFrame | null;
      }>(
        `SELECT id, site_id, device_id, name, platform, status, last_heartbeat_at, policy, last_rd_frame
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

    const consentMode = ep.policy?.remote_desktop_consent ?? 'unattended';
    if (consentMode === 'prompt') {
      // The agent has no way to ask the person at the screen yet. Refusing is the only honest
      // answer for a policy that demands their consent.
      throw new AppError(
        409,
        'consent_unavailable',
        'This endpoint requires the user to accept each session, and the agent cannot ask for consent yet. Change the remote desktop policy or use another support tool.',
      );
    }

    const session: RemoteDesktopSession = {
      id: randomToken(12),
      started_at: new Date().toISOString(),
      operator_email: ctx.userEmail,
      display_index: body.display_index,
      quality: body.quality,
      scale: body.scale,
      consent_mode: consentMode,
      recording_enabled: body.recording_enabled,
    };

    await db.query(`UPDATE endpoints SET rd_session = $2::jsonb WHERE id = $1`, [id, JSON.stringify(session)]);

    // Never silent: the person at the endpoint is told who is viewing before the first frame is taken.
    await queueUserNotice(db, ctx.organizationId, id, ctx.userId, ctx.userEmail, 'Remote support session started', `${ctx.userEmail} can now see and control this screen. The session is logged.`);

    // Queue an initial frame capture command
    await db.query(
      `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
       VALUES ($1,$2,'rd_capture',$3,$4,$5)`,
      [
        ctx.organizationId,
        id,
        JSON.stringify({ display_index: body.display_index, quality: body.quality, scale: body.scale }),
        ctx.userId,
        ctx.userEmail,
      ],
    );

    await audit(db, req, 'endpoint.remote_desktop_started', { type: 'endpoint', id }, session as unknown as Record<string, unknown>);
    await emitEvent(db, ctx.organizationId, {
      siteId: ep.site_id,
      deviceId: ep.device_id,
      type: 'endpoint_command',
      severity: 'info',
      title: `Remote Desktop session started on "${ep.name}" by ${ctx.userEmail}`,
      details: { endpoint_id: ep.id, session_id: session.id, operator: ctx.userEmail, recording: body.recording_enabled },
      source: 'platform',
      occurredAt: new Date(),
    });
    return { session, last_frame: ep.last_rd_frame };
  });
}

export async function stopSession(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const ep = (await db.query<{ id: string; active: boolean }>(`SELECT id, rd_session IS NOT NULL AS active FROM endpoints WHERE id = $1`, [id])).rows[0];
    if (!ep) throw notFound('Endpoint');
    // Pending frame requests must not outlive the session. Command rows are locked before the
    // endpoint row, the same order an agent's result upload uses (the reverse order deadlocks).
    await db.query(
      `UPDATE endpoint_commands SET status = 'expired', error = 'Remote desktop session ended', completed_at = now()
        WHERE endpoint_id = $1 AND kind IN ('rd_capture', 'rd_input') AND status IN ('pending', 'delivered')`,
      [id],
    );
    await db.query(`UPDATE endpoints SET rd_session = NULL, last_rd_frame = NULL WHERE id = $1`, [id]);
    if (ep.active) {
      await queueUserNotice(db, ctx.organizationId, id, ctx.userId, ctx.userEmail, 'Remote support session ended', `${ctx.userEmail} is no longer viewing this screen.`);
    }
    await audit(db, req, 'endpoint.remote_desktop_stopped', { type: 'endpoint', id }, { operator: ctx.userEmail });
  });
}
