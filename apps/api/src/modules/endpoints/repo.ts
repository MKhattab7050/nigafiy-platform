import { EventEmitter } from 'node:events';
import type { RemoteDesktopFrame } from '@nigafiy/shared-types';
import type { z } from 'zod';
import { randomToken, sha256 } from '../../common/crypto.ts';
import { normalizeMac } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import { holdFrame, publishFrame } from './remote-desktop/frames.ts';
import { applySessionOpenResult } from './remote-desktop/sessions.ts';
import { applyRestartResult } from './fleet-reach/restarts.ts';
import type { commandResultSchema } from './schema.ts';

// Queries shared by several concerns of the endpoints module (fleet, enrollment, agent gateway,
// commands, remote desktop). Concern-specific SQL stays in that concern's service.

export const HEARTBEAT_INTERVAL_SECONDS = 20;
export const ENROLLMENT_TTL_HOURS = 24;
/** An endpoint whose last heartbeat is older than this is treated as offline for interactive actions. */
export const ONLINE_WITHIN_MS = 120_000;

/** Wakes up in-flight `waitForCommandResult` callers on this API instance as soon as a result arrives. */
export const commandEvents = new EventEmitter();
commandEvents.setMaxListeners(0);

/**
 * Cross-instance wake-up: `applyCommandResults` notifies this channel with each finished command id
 * (delivered on COMMIT to every API instance); the endpoints module's lifecycle turns it into a
 * `done:<id>` event on that instance's `commandEvents`. Without it, a waiter on another instance
 * would only notice through its fallback poll.
 */
export const COMMAND_DONE_CHANNEL = 'ld_command_done';

export function signalCommandDone(commandId: string): void {
  commandEvents.emit(`done:${commandId}`);
}

export const ENDPOINT_SUMMARY_SELECT = `
  SELECT e.id, e.site_id, s.name AS site_name, e.device_id, e.name,
         e.platform, e.status, e.connection_state,
         e.compliance_status, e.compliance_reasons,
         e.manufacturer, e.model, e.serial_number,
         e.agent_version, e.hostname, e.os, e.os_version, e.arch, e.cpu_model, e.cpu_cores, e.ram_total_mb,
         e.uptime_seconds::float8 AS uptime_seconds, e.logged_in_users,
         host(e.primary_ip) AS primary_ip, e.primary_mac::text AS primary_mac,
         e.cpu_pct, e.ram_used_mb, e.ram_pct, e.disk_used_pct,
         e.last_heartbeat_at, e.inventory_updated_at,
         CASE WHEN e.status = 'pending' THEN e.enrollment_expires_at END AS enrollment_expires_at,
         e.created_at, e.fleet_group_id, fg.name AS fleet_group_name,
         e.nigafiy_id, e.tags, e.user_sessions, e.boot_state
    FROM endpoints e
    JOIN sites s ON s.organization_id = e.organization_id AND s.id = e.site_id
    LEFT JOIN fleet_groups fg ON fg.organization_id = e.organization_id AND fg.id = e.fleet_group_id`;

export function newEnrollmentToken(): { token: string; hash: string; expires: Date } {
  const token = `ldea_${randomToken(32)}`;
  return { token, hash: sha256(token), expires: new Date(Date.now() + ENROLLMENT_TTL_HOURS * 3600_000) };
}

export async function resolveDeviceLink(db: Db, siteId: string, mac?: string, ip?: string): Promise<string | null> {
  const normMac = mac ? normalizeMac(mac) : null;
  const normIp = ip ?? null;
  if (!normMac && !normIp) return null;
  const found = await db.query<{ id: string }>(
    `SELECT id FROM devices
      WHERE site_id = $1
        AND (($2::macaddr IS NOT NULL AND primary_mac = $2::macaddr)
             OR ($3::inet IS NOT NULL AND current_ip = $3::inet))
      ORDER BY (primary_mac IS NOT NULL AND primary_mac = $2::macaddr) DESC, last_seen_at DESC
      LIMIT 1`,
    [siteId, normMac, normIp],
  );
  return found.rows[0]?.id ?? null;
}

export async function applyCommandResults(
  db: Db,
  endpointId: string,
  results: Array<z.infer<typeof commandResultSchema>>,
  now: Date,
): Promise<string[]> {
  const completedIds: string[] = [];
  for (const resItem of results) {
    const updated = await db.query<{ kind: string; payload: Record<string, unknown>; organization_id: string }>(
      `UPDATE endpoint_commands
          SET status = $3,
              output = $4,
              error = $5,
              -- Remote desktop images are never stored: only the frame's metadata (remote-desktop/frames.ts).
              result_data = coalesce(CASE WHEN kind = 'rd_capture' THEN $6::jsonb - 'jpeg_base64' ELSE $6::jsonb END, result_data),
              payload = CASE WHEN kind = 'fs_op' AND payload->>'op' = 'upload' THEN payload - 'data_base64' ELSE payload END,
              completed_at = $7
        WHERE id = $1 AND endpoint_id = $2 AND status IN ('pending', 'delivered')
        RETURNING kind, payload, organization_id`,
      [
        resItem.id,
        endpointId,
        resItem.ok ? 'completed' : 'failed',
        resItem.output ?? null,
        resItem.error ?? null,
        resItem.data ? JSON.stringify(resItem.data) : null,
        now,
      ],
    );
    const image = resItem.data?.jpeg_base64;
    if (resItem.ok && updated.rows[0]?.kind === 'rd_capture' && typeof image === 'string' && image.length > 0) {
      // Relayed only while the session is open: a frame arriving after "stop" is discarded.
      const open = await db.query(`SELECT 1 FROM endpoints WHERE id = $1 AND rd_session IS NOT NULL AND coalesce(rd_session->>'state', 'active') = 'active'`, [endpointId]);
      if (open.rowCount) {
        const frame = resItem.data as unknown as RemoteDesktopFrame;
        holdFrame(endpointId, resItem.id, frame);
        await publishFrame(db, endpointId, resItem.id, frame);
      }
    }
    const row = updated.rows[0];
    if (row?.kind === 'rd_session_open') {
      // Consent answered (or impossible), banner shown or not: the session goes live or ends.
      await applySessionOpenResult(db, row.organization_id, endpointId, row.payload, resItem.ok, (resItem.data ?? null) as Parameters<typeof applySessionOpenResult>[5], resItem.error ?? null);
    }
    if (row?.kind === 'fleet_restart' || row?.kind === 'fleet_safe_boot_clear') {
      // Restart and reconnect: the agent restarted (or refused), or cleared the safe-boot flag.
      await applyRestartResult(db, row.organization_id, endpointId, row.kind, row.payload, resItem.ok, (resItem.data ?? null) as Record<string, unknown> | null, resItem.error ?? null);
    }
    if (updated.rowCount) {
      completedIds.push(resItem.id);
    }
  }
  if (completedIds.length) {
    await db.query(`SELECT pg_notify($1, id) FROM unnest($2::text[]) AS id`, [COMMAND_DONE_CHANNEL, completedIds]);
  }
  return completedIds;
}

/** Hands each pending command to the agent exactly once, oldest first (a session notice before its first frame). */
export async function deliverPendingCommands(db: Db, endpointId: string, now: Date): Promise<Array<{ id: string; kind: string; payload: Record<string, unknown> }>> {
  const { rows } = await db.query<{ id: string; kind: string; payload: Record<string, unknown>; created_at: Date }>(
    `UPDATE endpoint_commands
        SET status = 'delivered', delivered_at = $2
      WHERE endpoint_id = $1 AND status = 'pending'
      RETURNING id, kind, payload, created_at`,
    [endpointId, now],
  );
  // Commands queued in one transaction share created_at; a notice then goes first.
  const rank = (c: { kind: string; created_at: Date }) => c.created_at.getTime() * 2 + (c.kind === 'notify_user' ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b)).map(({ id, kind, payload }) => ({ id, kind, payload }));
}

/** Shows a message on the endpoint's screen (agent `notify_user`). */
export async function queueUserNotice(db: Db, orgId: string, endpointId: string, userId: string, userEmail: string, title: string, message: string): Promise<void> {
  await db.query(
    `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
     VALUES ($1,$2,'notify_user',$3,$4,$5)`,
    [orgId, endpointId, JSON.stringify({ title, message }), userId, userEmail],
  );
}

/**
 * What of a command payload may be copied into the audit log and network events (which are
 * forwarded to webhooks and email). File contents and typed remote-desktop text are never copied:
 * the operator may be typing a password into the remote session.
 */
export function payloadForAudit(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  if (typeof out.data_base64 === 'string') {
    out.data_bytes = Buffer.byteLength(out.data_base64, 'base64');
    delete out.data_base64;
  }
  if (kind === 'rd_input') {
    if (typeof out.text === 'string') out.text = `[${out.text.length} characters redacted]`;
    if (typeof out.key === 'string') out.key = '[redacted]';
    // Keys sent by position and shortcuts: which keys is as private as the text they type.
    if (typeof out.code === 'string') out.code = '[redacted]';
    if (Array.isArray(out.keys)) out.keys = `[${out.keys.length} keys redacted]`;
  }
  return out;
}
