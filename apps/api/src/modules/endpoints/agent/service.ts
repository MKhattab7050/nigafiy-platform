import { onHeartbeatRestarts } from '../fleet-reach/restarts.ts';
import type { EndpointPlatform, EndpointSecurityPosture } from '@nigafiy/shared-types';
import { randomToken, sha256 } from '../../../common/crypto.ts';
import { normalizeMac } from '../../../common/net.ts';
import { withSystem, withTenant } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { evaluateCompliance, inferPlatformFromOs } from '../capabilities.ts';
import { HEARTBEAT_INTERVAL_SECONDS, applyCommandResults, deliverPendingCommands, signalCommandDone, resolveDeviceLink } from '../repo.ts';
import type { AgentEnroll, AgentHeartbeat, AgentInventory, CommandResult, EndpointContext } from '../schema.ts';
import { normalizeConnections } from './connections.ts';
import { POLL_RECHECK_MS, armWake } from './wake.ts';
import { evaluateMonitoring, monitorSpec } from '../fleet-monitoring/evaluate.ts';
import { onHeartbeatPatches } from '../fleet-patches/service.ts';
import { trayFlags } from '../fleet-user/recordings.ts';

// The agent side of the endpoints module: enrollment, heartbeat, command delivery and results,
// inventory. Called only by the agent gateway router (credential-authenticated).

export interface EnrolledAgent {
  endpoint: { id: string; organization_id: string; site_id: string; name: string; device_id: string | null };
  secret: string;
}

/** Exchanges a single-use enrollment token for a credential. Returns null when the token is invalid, used or expired. */
export async function enrollAgent(body: AgentEnroll): Promise<EnrolledAgent | null> {
  const secret = randomToken(32);
  const mac = body.primary_mac ? normalizeMac(body.primary_mac) : null;
  const agentVersion = body.agent_version ?? body.version ?? '0.1.0';

  const enrolled = await withSystem(async (db) => {
    const existing = (
      await db.query<{
        id: string;
        organization_id: string;
        site_id: string;
        name: string;
        device_id: string | null;
        platform: EndpointPlatform;
      }>(
        `SELECT id, organization_id, site_id, name, device_id, platform
           FROM endpoints
          WHERE enrollment_token_hash = $1 AND status = 'pending' AND enrollment_expires_at > now()`,
        [sha256(body.enrollment_token)],
      )
    ).rows[0];
    if (!existing) return null;

    const platform = body.platform ?? inferPlatformFromOs(body.os, existing.platform);
    const compliance = evaluateCompliance({ platform, security: body.security });

    const updated = await db.query<{ id: string; organization_id: string; site_id: string; name: string; device_id: string | null }>(
      `UPDATE endpoints
          SET status = 'active', credential_hash = $2, enrollment_token_hash = NULL, enrollment_expires_at = NULL,
              platform = $3,
              hostname = $4, agent_version = $5, os = $6, os_version = $7, arch = $8,
              cpu_model = $9, cpu_cores = $10, ram_total_mb = $11, primary_ip = $12, primary_mac = $13,
              manufacturer = coalesce($14, manufacturer), model = coalesce($15, model),
              serial_number = coalesce($16, serial_number),
              security = CASE WHEN $17::jsonb IS NOT NULL THEN $17::jsonb ELSE security END,
              compliance_status = $18, compliance_reasons = $19
        WHERE id = $1 AND status = 'pending'
        RETURNING id, organization_id, site_id, name, device_id`,
      [
        existing.id,
        sha256(secret),
        platform,
        body.hostname,
        agentVersion,
        body.os,
        body.os_version ?? null,
        body.arch,
        body.cpu_model ?? null,
        body.cpu_cores ?? null,
        body.ram_total_mb ?? null,
        body.primary_ip ?? null,
        mac,
        body.manufacturer ?? null,
        body.model ?? null,
        body.serial_number ?? null,
        body.security ? JSON.stringify(body.security) : null,
        compliance.status,
        compliance.reasons,
      ],
    );
    const row = updated.rows[0];
    if (!row) return null;

    if (!row.device_id) {
      // Site ids are unique across organizations, so the site filter keeps this inside the tenant.
      const linked = await resolveDeviceLink(db, row.site_id, mac ?? undefined, body.primary_ip);
      if (linked) {
        await db.query(`UPDATE endpoints SET device_id = $2 WHERE id = $1`, [row.id, linked]);
        row.device_id = linked;
      }
    }

    await emitEvent(db, row.organization_id, {
      siteId: row.site_id,
      deviceId: row.device_id,
      type: 'endpoint_enrolled',
      severity: 'info',
      title: `Endpoint "${row.name}" (${body.hostname} · ${platform}) enrolled`,
      details: {
        endpoint_id: row.id,
        hostname: body.hostname,
        platform,
        os: body.os,
        os_version: body.os_version ?? null,
        arch: body.arch,
        agent_version: agentVersion,
        primary_ip: body.primary_ip ?? null,
        primary_mac: mac,
      },
      source: 'platform',
      occurredAt: new Date(),
    });
    await notifyRealtime(db, row.organization_id, 'devices');
    return row;
  });

  return enrolled ? { endpoint: enrolled, secret } : null;
}

export async function recordHeartbeat(ep: EndpointContext, body: AgentHeartbeat) {
  const now = new Date();
  const mac = body.primary_mac ? normalizeMac(body.primary_mac) : null;
  const agentVersion = body.agent_version ?? body.version ?? '0.1.0';
  const cmdResults = body.command_results ?? body.completed_commands ?? [];
  const normConns = normalizeConnections(body.connections);

  const { completedIds, response } = await withTenant(ep.organizationId, async (db) => {
    const currentRow = (
      await db.query<{ security: EndpointSecurityPosture; disk_used_pct: number | null; allowed_local_admins: string[] | null }>(
        `SELECT security, disk_used_pct, ARRAY(SELECT jsonb_array_elements_text(coalesce(policy -> 'allowed_local_admins', '[]'::jsonb))) AS allowed_local_admins
           FROM endpoints WHERE id = $1`,
        [ep.id],
      )
    ).rows[0];
    const platform = body.platform ?? inferPlatformFromOs(body.os, ep.platform);
    // The agent reports its whole posture each time; a check it can no longer run must disappear,
    // not keep an old answer.
    const mergedSecurity = body.security ?? currentRow?.security ?? {};
    const topDiskPct =
      body.disk_used_pct ??
      (body.disks && body.disks.length > 0 ? Math.max(...body.disks.map((d) => d.used_pct)) : currentRow?.disk_used_pct ?? null);
    const compliance = evaluateCompliance({
      platform,
      diskUsedPct: topDiskPct,
      security: mergedSecurity,
      allowedLocalAdmins: currentRow?.allowed_local_admins ?? undefined,
    });

    const deviceId = ep.deviceId ?? (await resolveDeviceLink(db, ep.siteId, mac ?? undefined, body.primary_ip));

    await db.query(
      `UPDATE endpoints
          SET last_heartbeat_at = $2, connection_state = 'online', device_id = coalesce($3, device_id),
              platform = $4,
              agent_version = $5, hostname = $6, os = $7, os_version = coalesce($8, os_version), arch = $9,
              cpu_model = coalesce($10, cpu_model), cpu_cores = coalesce($11, cpu_cores), ram_total_mb = coalesce($12, ram_total_mb),
              uptime_seconds = $13, logged_in_users = $14, primary_ip = coalesce($15, primary_ip), primary_mac = coalesce($16, primary_mac),
              cpu_pct = $17, ram_used_mb = $18, ram_pct = $19, disk_used_pct = coalesce($20, disk_used_pct),
              disks = CASE WHEN $21::jsonb IS NOT NULL THEN $21::jsonb ELSE disks END,
              interfaces = CASE WHEN $22::jsonb IS NOT NULL THEN $22::jsonb ELSE interfaces END,
              processes = CASE WHEN $23::jsonb IS NOT NULL THEN $23::jsonb ELSE processes END,
              services = CASE WHEN $24::jsonb IS NOT NULL THEN $24::jsonb ELSE services END,
              software = CASE WHEN $25::jsonb IS NOT NULL THEN $25::jsonb ELSE software END,
              connections = CASE WHEN $26::jsonb IS NOT NULL THEN $26::jsonb ELSE connections END,
              inventory_updated_at = CASE WHEN $23::jsonb IS NOT NULL OR $25::jsonb IS NOT NULL THEN $2 ELSE inventory_updated_at END,
              manufacturer = coalesce($27, manufacturer), model = coalesce($28, model),
              serial_number = coalesce($29, serial_number),
              security = $30::jsonb, compliance_status = $31, compliance_reasons = $32
        WHERE id = $1`,
      [
        ep.id,
        now,
        deviceId,
        platform,
        agentVersion,
        body.hostname,
        body.os,
        body.os_version ?? null,
        body.arch,
        body.cpu_model ?? null,
        body.cpu_cores ?? null,
        body.ram_total_mb ?? null,
        body.uptime_seconds,
        body.logged_in_users,
        body.primary_ip ?? null,
        mac,
        body.cpu_pct,
        body.ram_used_mb,
        body.ram_pct,
        topDiskPct,
        body.disks ? JSON.stringify(body.disks) : null,
        body.interfaces ? JSON.stringify(body.interfaces) : null,
        body.processes ? JSON.stringify(body.processes) : null,
        body.services ? JSON.stringify(body.services) : null,
        body.software ? JSON.stringify(body.software) : null,
        normConns ? JSON.stringify(normConns) : null,
        body.manufacturer ?? null,
        body.model ?? null,
        body.serial_number ?? null,
        JSON.stringify(mergedSecurity),
        compliance.status,
        compliance.reasons,
      ],
    );

    await db.query(
      `INSERT INTO endpoint_samples (endpoint_id, ts, organization_id, cpu_pct, ram_pct, ram_used_mb, disk_used_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [ep.id, now, ep.organizationId, body.cpu_pct, body.ram_pct, body.ram_used_mb, topDiskPct],
    );

    if (body.user_sessions || body.boot_state) {
      await db.query(
        `UPDATE endpoints SET user_sessions = coalesce($2::jsonb, user_sessions), boot_state = coalesce($3::jsonb, boot_state) WHERE id = $1`,
        [ep.id, body.user_sessions ? JSON.stringify(body.user_sessions) : null, body.boot_state ? JSON.stringify({ ...body.boot_state, reported_at: now.toISOString() }) : null],
      );
    }
    // Restart and reconnect: the agent is back; a safe-boot flag still set gets cleared.
    await onHeartbeatRestarts(db, ep.organizationId, ep.id, body.boot_state, body.uptime_seconds);

    // Monitoring rules (fleet-monitoring): breaches that last their duration raise Watch events.
    const storedDisks = body.disks
      ? null
      : ((await db.query<{ disks: { mount: string; free_gb?: number; total_gb?: number; used_pct: number }[] | null }>(`SELECT disks FROM endpoints WHERE id = $1`, [ep.id])).rows[0]?.disks ?? null);
    await evaluateMonitoring(db, ep.id, { cpuPct: body.cpu_pct, ramPct: body.ram_pct, disks: body.disks ?? storedDisks, monitor: body.monitor }, now);
    const monitor = await monitorSpec(db, ep.id);
    // Patches: a computer that came back after its patch restart.
    await onHeartbeatPatches(db, ep.organizationId, ep.id, body.uptime_seconds);
    // The tray: "Past recordings…" only when the group allows it (Request help, IT activity and
    // End current session are always there; no policy hides the tray).
    const tray = await trayFlags(db, ep.id);

    const completedIds = await applyCommandResults(db, ep.id, cmdResults, now);

    // Expire stale pending commands older than 10 minutes. Scripts, update installs and restart
    // questions the agent took run longer: their own jobs time them out (fleet-jobs, fleet-patches).
    await db.query(
      `UPDATE endpoint_commands
          SET status = 'expired', error = 'Command expired before the agent executed it', completed_at = $2
        WHERE endpoint_id = $1 AND status IN ('pending', 'delivered') AND created_at < $2::timestamptz - interval '10 minutes'
          AND NOT (status = 'delivered' AND kind IN ('script_run', 'patch_install', 'patch_reboot_prompt'))`,
      [ep.id, now],
    );

    // Prune ephemeral remote desktop frame/input commands older than 5 minutes
    await db.query(
      `DELETE FROM endpoint_commands
        WHERE endpoint_id = $1 AND kind IN ('rd_capture', 'rd_input') AND created_at < $2::timestamptz - interval '5 minutes'`,
      [ep.id, now],
    );

    // At most once: a command already handed out is never handed out again. Redelivery after an
    // agent restart would repeat it, and for "restart this computer" that is a reboot loop.
    // Undelivered results simply expire above.
    const commands = await deliverPendingCommands(db, ep.id, now);
    const nigafiyId = (await db.query<{ nigafiy_id: string }>(`SELECT nigafiy_id FROM endpoints WHERE id = $1`, [ep.id])).rows[0]?.nigafiy_id ?? null;

    if (ep.connectionState !== 'online' || cmdResults.length > 0) {
      await notifyRealtime(db, ep.organizationId, 'devices');
    }

    return {
      completedIds,
      response: {
        server_time: now.toISOString(),
        heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
        // Shown in the agent's tray ("About") so the person can read it to IT.
        nigafiy_id: nigafiyId,
        // What the agent measures for the monitoring rules (services, event-log queries).
        monitor,
        tray,
        commands,
      },
    };
  });

  for (const id of completedIds) {
    signalCommandDone(id); // this instance at once; others through COMMAND_DONE_CHANNEL
  }
  return response;
}

/** Fast sub-second command poll for interactive File Manager & Remote Desktop sessions. */
export function pollCommands(ep: EndpointContext) {
  const now = new Date();
  return withTenant(ep.organizationId, (db) => deliverPendingCommands(db, ep.id, now));
}

/**
 * Long poll: hands out pending commands at once, or waits up to `waitMs` for one to be queued. The
 * wake-up subscription is armed before the queue is read, so a command inserted in between is not
 * missed; a re-check every POLL_RECHECK_MS covers a lost notification. Stops when `signal` aborts
 * (the agent closed the connection).
 */
export async function longPollCommands(ep: EndpointContext, waitMs: number, signal: AbortSignal) {
  if (waitMs <= 0) return pollCommands(ep);
  const deadline = Date.now() + waitMs;
  const wake = armWake(ep.id, signal);
  try {
    for (;;) {
      const commands = await pollCommands(ep);
      const remaining = deadline - Date.now();
      if (commands.length > 0 || remaining <= 0 || signal.aborted) return commands;
      await wake.next(Math.min(POLL_RECHECK_MS, remaining));
      if (signal.aborted) return [];
    }
  } finally {
    wake.close();
  }
}

/** Immediate delivery of command results (without waiting for the next heartbeat). */
export async function recordCommandResults(ep: EndpointContext, results: CommandResult[]): Promise<void> {
  const now = new Date();
  const completedIds = await withTenant(ep.organizationId, async (db) => {
    const ids = await applyCommandResults(db, ep.id, results, now);
    await notifyRealtime(db, ep.organizationId, 'devices');
    return ids;
  });
  for (const id of completedIds) {
    signalCommandDone(id); // this instance at once; others through COMMAND_DONE_CHANNEL
  }
}

export async function recordInventory(ep: EndpointContext, body: AgentInventory): Promise<void> {
  const now = new Date();
  const topDiskPct = body.disks.length ? Math.max(...body.disks.map((d) => d.used_pct)) : null;
  const normConns = normalizeConnections(body.connections) ?? [];

  await withTenant(ep.organizationId, async (db) => {
    await db.query(
      `UPDATE endpoints
          SET disks = $2, interfaces = $3, processes = $4, services = $5, software = $6, connections = $7,
              disk_used_pct = coalesce($8, disk_used_pct), inventory_updated_at = $9
        WHERE id = $1`,
      [
        ep.id,
        JSON.stringify(body.disks),
        JSON.stringify(body.interfaces),
        JSON.stringify(body.processes),
        JSON.stringify(body.services),
        JSON.stringify(body.software),
        JSON.stringify(normConns),
        topDiskPct,
        now,
      ],
    );
    await notifyRealtime(db, ep.organizationId, 'devices');
  });
}
