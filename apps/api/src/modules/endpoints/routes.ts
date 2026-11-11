import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type {
  EndpointCommand,
  EndpointCreated,
  EndpointDetail,
  EndpointManagementMode,
  EndpointPlatform,
  EndpointPolicy,
  EndpointSecurityPosture,
  EndpointSeriesPoint,
  EndpointSummary,
  RemoteDesktopFrame,
  RemoteDesktopSession,
} from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { randomToken, safeEqual, sha256 } from '../../common/crypto.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { normalizeMac } from '../../common/net.ts';
import { env } from '../../config/env.ts';
import { type Db, systemPool, withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { emitEvent, notifyRealtime } from '../events/emit.ts';
import {
  buildAndroidProvisioningBundle,
  buildAppleMdmMobileconfig,
  buildCapabilities,
  evaluateCompliance,
  inferPlatformFromOs,
} from './capabilities.ts';
import {
  agentEnrollSchema,
  agentHeartbeatSchema,
  agentInventorySchema,
  commandResultSchema,
  endpointPolicySchema,
  managementModeEnum,
  platformEnum,
  type EndpointContext,
} from './schema.ts';

export const endpointAgentGatewayRouter: Router = Router();
export const endpointsRouter: Router = Router();

const HEARTBEAT_INTERVAL_SECONDS = 20;
const ENROLLMENT_TTL_HOURS = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ENDPOINT_SUMMARY_SELECT = `
  SELECT e.id, e.site_id, s.name AS site_name, e.device_id, e.name,
         e.platform, e.management_mode, e.status, e.connection_state,
         e.compliance_status, e.compliance_reasons,
         e.manufacturer, e.model, e.serial_number, e.security_patch_level,
         e.battery_pct, e.battery_charging,
         e.agent_version, e.hostname, e.os, e.os_version, e.arch, e.cpu_model, e.cpu_cores, e.ram_total_mb,
         e.uptime_seconds::float8 AS uptime_seconds, e.logged_in_users,
         host(e.primary_ip) AS primary_ip, e.primary_mac::text AS primary_mac,
         e.cpu_pct, e.ram_used_mb, e.ram_pct, e.disk_used_pct,
         e.last_heartbeat_at, e.inventory_updated_at,
         CASE WHEN e.status = 'pending' THEN e.enrollment_expires_at END AS enrollment_expires_at,
         e.created_at
    FROM endpoints e
    JOIN sites s ON s.organization_id = e.organization_id AND s.id = e.site_id`;

function newEnrollmentToken(): { token: string; hash: string; expires: Date } {
  const token = `ldea_${randomToken(32)}`;
  return { token, hash: sha256(token), expires: new Date(Date.now() + ENROLLMENT_TTL_HOURS * 3600_000) };
}

async function resolveDeviceLink(db: Db, siteId: string, mac?: string, ip?: string): Promise<string | null> {
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

function normalizeConnections(
  conns?: Array<{
    proto: string;
    local_address?: string;
    local_addr?: string;
    local_port?: number;
    remote_address?: string;
    remote_addr?: string;
    remote_port?: number;
    state: string;
    pid?: number;
    process_name?: string;
  }>,
) {
  if (!conns) return null;
  return conns.map((c) => {
    let localAddr = c.local_address ?? '';
    let localPort = c.local_port ?? 0;
    if (!localAddr && c.local_addr) {
      const idx = c.local_addr.lastIndexOf(':');
      if (idx > 0) {
        localAddr = c.local_addr.slice(0, idx);
        localPort = Number.parseInt(c.local_addr.slice(idx + 1), 10) || 0;
      } else {
        localAddr = c.local_addr;
      }
    }
    let remoteAddr = c.remote_address;
    let remotePort = c.remote_port;
    if (!remoteAddr && c.remote_addr) {
      const idx = c.remote_addr.lastIndexOf(':');
      if (idx > 0) {
        remoteAddr = c.remote_addr.slice(0, idx);
        remotePort = Number.parseInt(c.remote_addr.slice(idx + 1), 10) || 0;
      } else {
        remoteAddr = c.remote_addr;
      }
    }
    return {
      proto: c.proto.toLowerCase() === 'udp' ? 'udp' : 'tcp',
      local_address: localAddr || '0.0.0.0',
      local_port: localPort,
      ...(remoteAddr ? { remote_address: remoteAddr } : {}),
      ...(typeof remotePort === 'number' ? { remote_port: remotePort } : {}),
      state: c.state,
      ...(typeof c.pid === 'number' ? { pid: c.pid } : {}),
      ...(c.process_name ? { process_name: c.process_name } : {}),
    };
  });
}

async function applyCommandResults(
  db: Db,
  endpointId: string,
  results: Array<z.infer<typeof commandResultSchema>>,
  now: Date,
): Promise<void> {
  for (const resItem of results) {
    const updated = await db.query<{ kind: string }>(
      `UPDATE endpoint_commands
          SET status = $3, output = $4, error = $5, result_data = coalesce($6::jsonb, result_data), completed_at = $7
        WHERE id = $1 AND endpoint_id = $2 AND status IN ('pending', 'delivered')
        RETURNING kind`,
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
    if (resItem.ok && resItem.data && updated.rows[0]?.kind === 'rd_capture') {
      await db.query(`UPDATE endpoints SET last_rd_frame = $2::jsonb WHERE id = $1`, [
        endpointId,
        JSON.stringify(resItem.data),
      ]);
    }
  }
}

/** Hands each pending command to the agent exactly once, oldest first (a session notice before its first frame). */
async function deliverPendingCommands(db: Db, endpointId: string, now: Date): Promise<Array<{ id: string; kind: string; payload: Record<string, unknown> }>> {
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
async function queueUserNotice(db: Db, orgId: string, endpointId: string, userId: string, userEmail: string, title: string, message: string): Promise<void> {
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
  }
  return out;
}

// ── Agent-facing gateway (/api/v1/agent/*) ──────────────────────────────────

const enrollLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many enrollment attempts' } },
});

endpointAgentGatewayRouter.use(express.json({ limit: '6mb' }));

endpointAgentGatewayRouter.post('/enroll', enrollLimiter, async (req, res) => {
  const body = parse(agentEnrollSchema, req.body);
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
        management_mode: EndpointManagementMode;
        policy: EndpointPolicy;
      }>(
        `SELECT id, organization_id, site_id, name, device_id, platform, management_mode, policy
           FROM endpoints
          WHERE enrollment_token_hash = $1 AND status = 'pending' AND enrollment_expires_at > now()`,
        [sha256(body.enrollment_token)],
      )
    ).rows[0];
    if (!existing) return null;

    const platform = body.platform ?? inferPlatformFromOs(body.os, existing.platform);
    const mode = body.management_mode ?? existing.management_mode;
    const compliance = evaluateCompliance({
      platform,
      security: body.security,
      policy: existing.policy,
    });

    const updated = await db.query<{ id: string; organization_id: string; site_id: string; name: string; device_id: string | null }>(
      `UPDATE endpoints
          SET status = 'active', credential_hash = $2, enrollment_token_hash = NULL, enrollment_expires_at = NULL,
              platform = $3, management_mode = $4,
              hostname = $5, agent_version = $6, os = $7, os_version = $8, arch = $9,
              cpu_model = $10, cpu_cores = $11, ram_total_mb = $12, primary_ip = $13, primary_mac = $14,
              manufacturer = coalesce($15, manufacturer), model = coalesce($16, model),
              serial_number = coalesce($17, serial_number), security_patch_level = coalesce($18, security_patch_level),
              security = CASE WHEN $19::jsonb IS NOT NULL THEN $19::jsonb ELSE security END,
              compliance_status = $20, compliance_reasons = $21
        WHERE id = $1 AND status = 'pending'
        RETURNING id, organization_id, site_id, name, device_id`,
      [
        existing.id,
        sha256(secret),
        platform,
        mode,
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
        body.security_patch_level ?? null,
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
        management_mode: mode,
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

  if (!enrolled) {
    logger.warn({ ip: req.ip }, 'rejected endpoint enrollment');
    throw new AppError(401, 'invalid_enrollment_token', 'Enrollment token is invalid, already used or expired');
  }
  res.status(201).json({
    endpoint_id: enrolled.id,
    credential: `lda_${enrolled.id}.${secret}`,
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
  });
});

async function requireEndpointAgent(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer lda_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!match || !UUID.test(match[1]!)) {
    throw new AppError(401, 'invalid_endpoint_credential', 'Endpoint credential is missing, invalid or revoked');
  }
  const { rows } = await systemPool.query<{
    id: string;
    organization_id: string;
    site_id: string;
    device_id: string | null;
    name: string;
    platform: EndpointPlatform;
    management_mode: EndpointManagementMode;
    credential_hash: string | null;
    connection_state: EndpointContext['connectionState'];
  }>(
    `SELECT id, organization_id, site_id, device_id, name, platform, management_mode, credential_hash, connection_state
       FROM endpoints WHERE id = $1 AND status = 'active'`,
    [match[1]],
  );
  const row = rows[0];
  if (!row?.credential_hash || !safeEqual(row.credential_hash, sha256(match[2]!))) {
    throw new AppError(401, 'invalid_endpoint_credential', 'Endpoint credential is missing, invalid or revoked');
  }
  req.endpoint = {
    id: row.id,
    organizationId: row.organization_id,
    siteId: row.site_id,
    deviceId: row.device_id,
    name: row.name,
    platform: row.platform,
    managementMode: row.management_mode,
    connectionState: row.connection_state,
  };
  next();
}

endpointAgentGatewayRouter.post('/heartbeat', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(agentHeartbeatSchema, req.body);
  const now = new Date();
  const mac = body.primary_mac ? normalizeMac(body.primary_mac) : null;
  const agentVersion = body.agent_version ?? body.version ?? '0.1.0';
  const cmdResults = body.command_results ?? body.completed_commands ?? [];
  const normConns = normalizeConnections(body.connections);

  const response = await withTenant(ep.organizationId, async (db) => {
    const currentRow = (
      await db.query<{ policy: EndpointPolicy; security: EndpointSecurityPosture; disk_used_pct: number | null }>(
        `SELECT policy, security, disk_used_pct FROM endpoints WHERE id = $1`,
        [ep.id],
      )
    ).rows[0];
    const platform = body.platform ?? inferPlatformFromOs(body.os, ep.platform);
    const mode = body.management_mode ?? ep.managementMode;
    const mergedSecurity = { ...(currentRow?.security ?? {}), ...(body.security ?? {}) };
    const topDiskPct =
      body.disk_used_pct ??
      (body.disks && body.disks.length > 0 ? Math.max(...body.disks.map((d) => d.used_pct)) : currentRow?.disk_used_pct ?? null);
    const compliance = evaluateCompliance({
      platform,
      diskUsedPct: topDiskPct,
      security: mergedSecurity,
      policy: currentRow?.policy ?? {},
    });

    const deviceId = ep.deviceId ?? (await resolveDeviceLink(db, ep.siteId, mac ?? undefined, body.primary_ip));

    await db.query(
      `UPDATE endpoints
          SET last_heartbeat_at = $2, connection_state = 'online', device_id = coalesce($3, device_id),
              platform = $4, management_mode = $5,
              agent_version = $6, hostname = $7, os = $8, os_version = coalesce($9, os_version), arch = $10,
              cpu_model = coalesce($11, cpu_model), cpu_cores = coalesce($12, cpu_cores), ram_total_mb = coalesce($13, ram_total_mb),
              uptime_seconds = $14, logged_in_users = $15, primary_ip = coalesce($16, primary_ip), primary_mac = coalesce($17, primary_mac),
              cpu_pct = $18, ram_used_mb = $19, ram_pct = $20, disk_used_pct = coalesce($21, disk_used_pct),
              disks = CASE WHEN $22::jsonb IS NOT NULL THEN $22::jsonb ELSE disks END,
              interfaces = CASE WHEN $23::jsonb IS NOT NULL THEN $23::jsonb ELSE interfaces END,
              processes = CASE WHEN $24::jsonb IS NOT NULL THEN $24::jsonb ELSE processes END,
              services = CASE WHEN $25::jsonb IS NOT NULL THEN $25::jsonb ELSE services END,
              software = CASE WHEN $26::jsonb IS NOT NULL THEN $26::jsonb ELSE software END,
              connections = CASE WHEN $27::jsonb IS NOT NULL THEN $27::jsonb ELSE connections END,
              inventory_updated_at = CASE WHEN $24::jsonb IS NOT NULL OR $26::jsonb IS NOT NULL THEN $2 ELSE inventory_updated_at END,
              manufacturer = coalesce($28, manufacturer), model = coalesce($29, model),
              serial_number = coalesce($30, serial_number), security_patch_level = coalesce($31, security_patch_level),
              battery_pct = coalesce($32, battery_pct), battery_charging = coalesce($33, battery_charging),
              security = $34::jsonb, compliance_status = $35, compliance_reasons = $36
        WHERE id = $1`,
      [
        ep.id,
        now,
        deviceId,
        platform,
        mode,
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
        body.security_patch_level ?? null,
        body.battery_pct ?? null,
        body.battery_charging ?? null,
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

    await applyCommandResults(db, ep.id, cmdResults, now);

    // Expire stale pending commands older than 10 minutes
    await db.query(
      `UPDATE endpoint_commands
          SET status = 'expired', error = 'Command expired before the agent executed it', completed_at = $2
        WHERE endpoint_id = $1 AND status IN ('pending', 'delivered') AND created_at < $2::timestamptz - interval '10 minutes'`,
      [ep.id, now],
    );

    // At most once: a command already handed out is never handed out again. Redelivery after an
    // agent restart would repeat it, and for "restart this computer" that is a reboot loop.
    // Undelivered results simply expire above.
    const commands = await deliverPendingCommands(db, ep.id, now);

    if (ep.connectionState !== 'online' || cmdResults.length > 0) {
      await notifyRealtime(db, ep.organizationId, 'devices');
    }

    return {
      server_time: now.toISOString(),
      heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
      commands,
    };
  });

  res.json(response);
});

// Fast sub-second command poll endpoint for interactive File Manager & Remote Desktop sessions.
endpointAgentGatewayRouter.post('/poll', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const now = new Date();
  const commands = await withTenant(ep.organizationId, (db) => deliverPendingCommands(db, ep.id, now));
  res.json({ commands });
});

// Immediate command result delivery endpoint.
endpointAgentGatewayRouter.post('/command-result', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(
    z.object({
      command_results: z.array(commandResultSchema).min(1).max(50),
    }).strict(),
    req.body,
  );
  const now = new Date();
  await withTenant(ep.organizationId, async (db) => {
    await applyCommandResults(db, ep.id, body.command_results, now);
    await notifyRealtime(db, ep.organizationId, 'devices');
  });
  res.json({ ok: true });
});

endpointAgentGatewayRouter.post('/inventory', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(agentInventorySchema, req.body);
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

  res.json({ ok: true });
});

// ── Apple MDM / Mobile Check-in & Connect Endpoints ─────────────────────────

const mdmConnectSchema = z
  .object({
    enrollment_token: z.string().min(20).max(200).optional(),
    udid: z.string().min(4).max(120).optional(),
    device_name: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(120).optional(),
    manufacturer: z.string().min(1).max(120).optional(),
    serial_number: z.string().min(1).max(120).optional(),
    os: z.enum(['ios', 'macos', 'android']).default('ios'),
    os_version: z.string().min(1).max(80).optional(),
    security_patch_level: z.string().max(40).optional(),
    battery_pct: z.number().min(0).max(100).optional(),
    battery_charging: z.boolean().optional(),
    storage_total_gb: z.number().min(0).max(100_000).optional(),
    storage_used_gb: z.number().min(0).max(100_000).optional(),
    supervised: z.boolean().optional(),
    device_owner: z.boolean().optional(),
    passcode_compliant: z.boolean().optional(),
    disk_encrypted: z.boolean().optional(),
    rooted_or_jailbroken: z.boolean().optional(),
    primary_ip: z.string().max(40).optional(),
    primary_mac: z.string().max(40).optional(),
    apps: z.array(z.object({ name: z.string(), version: z.string().optional(), publisher: z.string().optional() })).max(500).optional(),
    command_results: z.array(commandResultSchema).max(50).optional(),
  })
  .strict();

endpointAgentGatewayRouter.post('/mdm/connect', enrollLimiter, async (req, res) => {
  const body = parse(mdmConnectSchema, req.body);
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const token = body.enrollment_token ?? queryToken;
  const now = new Date();

  // If enrollment token is provided and endpoint is still pending, enroll it first.
  if (token) {
    const secret = randomToken(32);
    const enrolled = await withSystem(async (db) => {
      const pending = (
        await db.query<{
          id: string;
          organization_id: string;
          site_id: string;
          name: string;
          platform: EndpointPlatform;
          management_mode: EndpointManagementMode;
          policy: EndpointPolicy;
        }>(
          `SELECT id, organization_id, site_id, name, platform, management_mode, policy
             FROM endpoints
            WHERE enrollment_token_hash = $1 AND status = 'pending' AND enrollment_expires_at > now()`,
          [sha256(token)],
        )
      ).rows[0];
      if (!pending) return null;

      // Only what the device reported. A missing answer stays unknown; it is never assumed safe.
      const sec: EndpointSecurityPosture = {
        supervised: body.supervised,
        device_owner: body.device_owner,
        passcode_compliant: body.passcode_compliant,
        disk_encrypted: body.disk_encrypted,
        rooted_or_jailbroken: body.rooted_or_jailbroken,
      };
      const usedPct =
        body.storage_total_gb && body.storage_total_gb > 0 && typeof body.storage_used_gb === 'number'
          ? Math.round((body.storage_used_gb * 1000) / body.storage_total_gb) / 10
          : null;
      const disks =
        body.storage_total_gb && body.storage_total_gb > 0
          ? [
              {
                mount: pending.platform === 'ios' ? 'iOS Flash Storage' : 'Internal Storage',
                total_gb: body.storage_total_gb,
                used_gb: body.storage_used_gb ?? 0,
                free_gb: Math.max(0, body.storage_total_gb - (body.storage_used_gb ?? 0)),
                used_pct: usedPct ?? 0,
              },
            ]
          : [];
      const compliance = evaluateCompliance({
        platform: pending.platform,
        diskUsedPct: usedPct,
        security: sec,
        policy: pending.policy,
      });
      const mac = body.primary_mac ? normalizeMac(body.primary_mac) : null;

      await db.query(
        `UPDATE endpoints
            SET status = 'active', connection_state = 'online', last_heartbeat_at = $2,
                credential_hash = $3, enrollment_token_hash = NULL, enrollment_expires_at = NULL,
                hostname = $4, os = $5, os_version = $6, arch = 'arm64', agent_version = 'mdm-1.0',
                manufacturer = coalesce($7, manufacturer), model = coalesce($8, model),
                serial_number = coalesce($9, serial_number), security_patch_level = coalesce($10, security_patch_level),
                battery_pct = $11, battery_charging = $12, disk_used_pct = $13,
                disks = $14::jsonb, software = $15::jsonb, security = $16::jsonb,
                compliance_status = $17, compliance_reasons = $18,
                primary_ip = $19, primary_mac = $20, inventory_updated_at = $2
          WHERE id = $1`,
        [
          pending.id,
          now,
          sha256(secret),
          body.device_name ?? pending.name,
          body.os,
          body.os_version ?? null,
          body.manufacturer ?? (pending.platform === 'ios' ? 'Apple Inc.' : null),
          body.model ?? null,
          body.serial_number ?? body.udid ?? null,
          body.security_patch_level ?? null,
          body.battery_pct ?? null,
          body.battery_charging ?? null,
          usedPct,
          JSON.stringify(disks),
          JSON.stringify(body.apps ?? []),
          JSON.stringify(sec),
          compliance.status,
          compliance.reasons,
          body.primary_ip ?? null,
          mac,
        ],
      );
      return { id: pending.id, credential: `lda_${pending.id}.${secret}` };
    });

    if (!enrolled) {
      throw new AppError(401, 'invalid_enrollment_token', 'MDM enrollment token is invalid or expired');
    }
    res.status(201).json({
      endpoint_id: enrolled.id,
      credential: enrolled.credential,
      commands: [],
    });
    return;
  }

  // Otherwise authenticate using Bearer lda_<id>.<secret>
  await new Promise<void>((resolve, reject) => {
    requireEndpointAgent(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });
  const ep = req.endpoint!;
  const out = await withTenant(ep.organizationId, async (db) => {
    if (body.command_results && body.command_results.length > 0) {
      await applyCommandResults(db, ep.id, body.command_results, now);
    }
    const commands = await deliverPendingCommands(db, ep.id, now);
    await db.query(`UPDATE endpoints SET last_heartbeat_at = $2, connection_state = 'online' WHERE id = $1`, [ep.id, now]);
    return { commands };
  });
  res.json(out);
});

// ── User-facing API (/api/v1/endpoints/*) ───────────────────────────────────

endpointsRouter.get('/endpoints', async (req, res) => {
  const ctx = auth(req);
  const q = parse(
    z.object({
      site_id: z.uuid().optional(),
      device_id: z.uuid().optional(),
      platform: platformEnum.optional(),
      compliance_status: z.enum(['compliant', 'non_compliant', 'attention', 'unknown']).optional(),
    }),
    req.query,
  );
  const items = await withTenant(ctx.organizationId, (db) =>
    db.query<EndpointSummary>(
      `${ENDPOINT_SUMMARY_SELECT}
        WHERE ($1::uuid IS NULL OR e.site_id = $1)
          AND ($2::uuid IS NULL OR e.device_id = $2)
          AND ($3::text IS NULL OR e.platform = $3)
          AND ($4::text IS NULL OR e.compliance_status = $4)
        ORDER BY CASE e.connection_state WHEN 'online' THEN 0 WHEN 'offline' THEN 1 ELSE 2 END, e.name`,
      [q.site_id ?? null, q.device_id ?? null, q.platform ?? null, q.compliance_status ?? null],
    ),
  );
  res.json({ items: items.rows });
});

endpointsRouter.post('/endpoints', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(
    z.object({
      site_id: z.uuid(),
      name: z.string().trim().min(1).max(80),
      platform: platformEnum.default('windows'),
      management_mode: managementModeEnum.optional(),
      device_id: z.uuid().nullable().optional(),
    }).strict(),
    req.body,
  );
  const defaultMode: Record<EndpointPlatform, EndpointManagementMode> = {
    windows: 'agent',
    linux: 'agent',
    macos: 'agent',
    android: 'android_device_owner',
    ios: 'ios_supervised_mdm',
  };
  const mode = body.management_mode ?? defaultMode[body.platform];
  const enrollment = newEnrollmentToken();
  const serverOrigin = `${req.protocol}://${req.get('host') ?? 'localhost:4100'}`;

  const endpoint = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) throw notFound('Site');
    if (body.device_id) {
      if (!(await db.query(`SELECT 1 FROM devices WHERE id = $1 AND site_id = $2`, [body.device_id, body.site_id])).rowCount) {
        throw notFound('Device');
      }
    }
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO endpoints (organization_id, site_id, device_id, name, platform, management_mode, enrollment_token_hash, enrollment_expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        ctx.organizationId,
        body.site_id,
        body.device_id ?? null,
        body.name,
        body.platform,
        mode,
        enrollment.hash,
        enrollment.expires,
        ctx.userId,
      ],
    );
    const id = inserted.rows[0]!.id;
    await audit(db, req, 'endpoint.created', { type: 'endpoint', id }, {
      name: body.name,
      platform: body.platform,
      management_mode: mode,
      site_id: body.site_id,
      device_id: body.device_id ?? null,
    });
    return (await db.query<EndpointSummary>(`${ENDPOINT_SUMMARY_SELECT} WHERE e.id = $1`, [id])).rows[0]!;
  });

  const response: EndpointCreated = {
    endpoint,
    enrollment_token: enrollment.token,
    ...(body.platform === 'android'
      ? {
          android_provisioning: buildAndroidProvisioningBundle({
            serverUrl: serverOrigin,
            enrollmentToken: enrollment.token,
            endpointName: endpoint.name,
            managementMode: mode,
          }),
        }
      : {}),
    ...(body.platform === 'ios' || body.platform === 'macos'
      ? {
          apple_mdm_profile_url: `/api/v1/endpoints/${endpoint.id}/apple-profile.mobileconfig?token=${encodeURIComponent(enrollment.token)}`,
        }
      : {}),
  };
  res.status(201).json(response);
});

endpointsRouter.get('/endpoints/:id/apple-profile.mobileconfig', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const token = typeof req.query.token === 'string' ? req.query.token : 'ENROLLMENT_TOKEN_REQUIRED';
  const serverOrigin = `${req.protocol}://${req.get('host') ?? 'localhost:4100'}`;

  const xml = await withTenant(ctx.organizationId, async (db) => {
    const row = (
      await db.query<{ id: string; name: string; policy: EndpointPolicy; org_name: string }>(
        `SELECT e.id, e.name, e.policy, o.name AS org_name
           FROM endpoints e
           JOIN organizations o ON o.id = e.organization_id
          WHERE e.id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) throw notFound('Endpoint');
    return buildAppleMdmMobileconfig({
      organizationName: row.org_name,
      endpointId: row.id,
      endpointName: row.name,
      enrollmentToken: token,
      serverUrl: serverOrigin,
      policy: row.policy,
    });
  });

  res.setHeader('Content-Type', 'application/x-apple-aspen-config; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lan-detective-${id.slice(0, 8)}.mobileconfig"`);
  res.send(xml);
});

endpointsRouter.post('/endpoints/:id/enrollment-token', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const enrollment = newEnrollmentToken();
  const serverOrigin = `${req.protocol}://${req.get('host') ?? 'localhost:4100'}`;
  const endpoint = await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE endpoints SET enrollment_token_hash = $2, enrollment_expires_at = $3 WHERE id = $1 AND status = 'pending'`,
      [id, enrollment.hash, enrollment.expires],
    );
    if (!updated.rowCount) throw new AppError(409, 'not_pending', 'Only endpoints that have not enrolled yet can get a new enrollment token');
    await audit(db, req, 'endpoint.enrollment_token_reissued', { type: 'endpoint', id });
    return (await db.query<EndpointSummary>(`${ENDPOINT_SUMMARY_SELECT} WHERE e.id = $1`, [id])).rows[0]!;
  });
  const response: EndpointCreated = {
    endpoint,
    enrollment_token: enrollment.token,
    ...(endpoint.platform === 'android'
      ? {
          android_provisioning: buildAndroidProvisioningBundle({
            serverUrl: serverOrigin,
            enrollmentToken: enrollment.token,
            endpointName: endpoint.name,
            managementMode: endpoint.management_mode,
          }),
        }
      : {}),
    ...(endpoint.platform === 'ios' || endpoint.platform === 'macos'
      ? {
          apple_mdm_profile_url: `/api/v1/endpoints/${endpoint.id}/apple-profile.mobileconfig?token=${encodeURIComponent(enrollment.token)}`,
        }
      : {}),
  };
  res.json(response);
});

endpointsRouter.post('/endpoints/:id/revoke', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE endpoints SET status = 'revoked', connection_state = 'offline', revoked_at = now(), credential_hash = NULL, enrollment_token_hash = NULL, rd_session = NULL
        WHERE id = $1 AND status <> 'revoked'`,
      [id],
    );
    if (!updated.rowCount) throw notFound('Endpoint');
    await audit(db, req, 'endpoint.revoked', { type: 'endpoint', id });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.json({ ok: true });
});

endpointsRouter.get('/endpoints/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const detail = await withTenant(ctx.organizationId, async (db) => {
    await db.query(
      `UPDATE endpoint_commands
          SET status = 'expired', error = 'Command expired before the agent executed it', completed_at = now()
        WHERE endpoint_id = $1 AND status IN ('pending', 'delivered') AND created_at < now() - interval '10 minutes'`,
      [id],
    );
    const ep = (
      await db.query<EndpointDetail>(
        `${ENDPOINT_SUMMARY_SELECT.replace(
          'FROM endpoints e',
          ', e.security, e.policy, e.rd_session, e.last_rd_frame, e.disks, e.interfaces, e.processes, e.services, e.software, e.connections FROM endpoints e',
        )}
          WHERE e.id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    const commands = await db.query<EndpointCommand>(
      `SELECT id, endpoint_id, kind, payload, status, output, error, result_data, created_by_name, created_at, delivered_at, completed_at
         FROM endpoint_commands
        WHERE endpoint_id = $1
        ORDER BY created_at DESC
        LIMIT 60`,
      [id],
    );
    ep.commands = commands.rows.map((c) => ({ ...c, payload: payloadForAudit(c.kind, c.payload) }));
    ep.capabilities = buildCapabilities(ep.platform, ep.management_mode, ep.security);
    return ep;
  });
  res.json(detail);
});

endpointsRouter.patch('/endpoints/:id/policy', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(endpointPolicySchema, req.body);

  const updatedPolicy = await withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{
        id: string;
        platform: EndpointPlatform;
        disk_used_pct: number | null;
        security: EndpointSecurityPosture;
        policy: EndpointPolicy;
      }>(`SELECT id, platform, disk_used_pct, security, policy FROM endpoints WHERE id = $1`, [id])
    ).rows[0];
    if (!ep) throw notFound('Endpoint');

    const mergedPolicy: EndpointPolicy = { ...(ep.policy ?? {}), ...body };
    const compliance = evaluateCompliance({
      platform: ep.platform,
      diskUsedPct: ep.disk_used_pct,
      security: ep.security,
      policy: mergedPolicy,
    });

    await db.query(
      `UPDATE endpoints SET policy = $2::jsonb, compliance_status = $3, compliance_reasons = $4 WHERE id = $1`,
      [id, JSON.stringify(mergedPolicy), compliance.status, compliance.reasons],
    );
    await audit(db, req, 'endpoint.policy_updated', { type: 'endpoint', id }, mergedPolicy as Record<string, unknown>);
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return mergedPolicy;
  });

  res.json({ policy: updatedPolicy });
});

// ── Remote Desktop Session Management ───────────────────────────────────────

endpointsRouter.post('/endpoints/:id/remote-desktop/start', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(
    z.object({
      display_index: z.number().int().min(0).max(8).default(0),
      quality: z.number().int().min(25).max(95).default(68),
      scale: z.number().min(0.25).max(1.0).default(0.75),
      recording_enabled: z.boolean().default(false),
    }).strict(),
    req.body ?? {},
  );

  const out = await withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{
        id: string;
        site_id: string;
        device_id: string | null;
        name: string;
        platform: EndpointPlatform;
        management_mode: EndpointManagementMode;
        status: string;
        last_heartbeat_at: Date | null;
        policy: EndpointPolicy;
        security: EndpointSecurityPosture;
        last_rd_frame: RemoteDesktopFrame | null;
      }>(
        `SELECT id, site_id, device_id, name, platform, management_mode, status, last_heartbeat_at, policy, security, last_rd_frame
           FROM endpoints WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');

    const caps = buildCapabilities(ep.platform, ep.management_mode, ep.security);
    const rdCap = caps.find((c) => c.key === 'remote_desktop');
    if (!rdCap?.enabled) {
      throw new AppError(409, 'unsupported_by_platform', rdCap?.reason_en ?? 'Remote desktop is not supported on this platform');
    }
    if (ep.status !== 'active' || !ep.last_heartbeat_at || ep.last_heartbeat_at.getTime() < Date.now() - 120_000) {
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

  res.json(out);
});

endpointsRouter.post('/endpoints/:id/remote-desktop/stop', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const ep = (await db.query<{ id: string; active: boolean }>(`SELECT id, rd_session IS NOT NULL AS active FROM endpoints WHERE id = $1`, [id])).rows[0];
    if (!ep) throw notFound('Endpoint');
    await db.query(`UPDATE endpoints SET rd_session = NULL WHERE id = $1`, [id]);
    // Pending frame requests must not outlive the session.
    await db.query(
      `UPDATE endpoint_commands SET status = 'expired', error = 'Remote desktop session ended', completed_at = now()
        WHERE endpoint_id = $1 AND kind IN ('rd_capture', 'rd_input') AND status IN ('pending', 'delivered')`,
      [id],
    );
    if (ep.active) {
      await queueUserNotice(db, ctx.organizationId, id, ctx.userId, ctx.userEmail, 'Remote support session ended', `${ctx.userEmail} is no longer viewing this screen.`);
    }
    await audit(db, req, 'endpoint.remote_desktop_stopped', { type: 'endpoint', id }, { operator: ctx.userEmail });
  });
  res.json({ ok: true });
});

const RANGES: Record<string, { seconds: number; bucket: number }> = {
  '15m': { seconds: 900, bucket: 20 },
  '1h': { seconds: 3600, bucket: 60 },
  '24h': { seconds: 86_400, bucket: 300 },
  '7d': { seconds: 604_800, bucket: 3600 },
  '30d': { seconds: 2_592_000, bucket: 14_400 },
};

endpointsRouter.get('/endpoints/:id/series', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const q = parse(z.object({ range: z.enum(['15m', '1h', '24h', '7d', '30d']).default('1h') }), req.query);
  const r = RANGES[q.range]!;
  const to = new Date();
  const from = new Date(to.getTime() - r.seconds * 1000);

  const points = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM endpoints WHERE id = $1`, [id])).rowCount) throw notFound('Endpoint');
    const result = await db.query<EndpointSeriesPoint>(
      `SELECT date_bin(make_interval(secs => $4), ts, timestamptz '2000-01-01') AS ts,
              avg(cpu_pct)::float8 AS cpu_pct,
              avg(ram_pct)::float8 AS ram_pct,
              avg(disk_used_pct)::float8 AS disk_used_pct,
              count(*)::int AS samples
         FROM endpoint_samples
        WHERE endpoint_id = $1 AND ts >= $2 AND ts < $3
        GROUP BY 1 ORDER BY 1`,
      [id, from, to, r.bucket],
    );
    return result.rows;
  });

  res.json({ from, to, bucket_seconds: r.bucket, points });
});

const commandInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refresh_inventory') }).strict(),
  z.object({
    kind: z.literal('kill_process'),
    pid: z.number().int().min(1).max(2_147_483_647),
    name: z.string().trim().min(1).max(160).optional(),
  }).strict(),
  z.object({
    kind: z.literal('service_action'),
    service: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.-]+$/, 'Service name contains invalid characters'),
    action: z.enum(['start', 'stop', 'restart']),
  }).strict(),
  z.object({
    kind: z.literal('power_action'),
    action: z.enum(['restart', 'shutdown', 'lock', 'logoff']),
    reason: z.string().trim().max(240).optional(),
  }).strict(),
  z.object({
    kind: z.literal('notify_user'),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(600),
  }).strict(),
  z.object({
    kind: z.literal('fs_op'),
    op: z.enum(['roots', 'list', 'search', 'mkdir', 'touch', 'rename', 'copy', 'move', 'delete', 'download', 'upload']),
    path: z.string().max(1024).optional(),
    paths: z.array(z.string().max(1024)).max(100).optional(),
    target_path: z.string().max(1024).optional(),
    new_name: z.string().max(255).optional(),
    query: z.string().max(200).optional(),
    show_hidden: z.boolean().optional(),
    confirm_destructive: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(524_288).optional(),
    append: z.boolean().optional(),
    data_base64: z.string().max(1_500_000).optional(),
    expected_sha256: z.string().max(64).optional(),
  }).strict(),
  z.object({
    kind: z.literal('rd_capture'),
    display_index: z.number().int().min(0).max(8).default(0),
    quality: z.number().int().min(25).max(95).default(65),
    scale: z.number().min(0.25).max(1.0).default(0.75),
  }).strict(),
  z.object({
    kind: z.literal('rd_input'),
    event_kind: z.enum(['mouse_move', 'mouse_click', 'mouse_down', 'mouse_up', 'mouse_wheel', 'key_press', 'text']),
    display_index: z.number().int().min(0).max(8).default(0),
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.5),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    double: z.boolean().optional(),
    delta_y: z.number().int().min(-2400).max(2400).optional(),
    key: z.string().max(40).optional(),
    text: z.string().max(240).optional(),
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    shift: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('software_action'),
    action: z.enum(['install', 'upgrade', 'uninstall']),
    package_id: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:+-]+$/, 'Invalid package identifier'),
  }).strict(),
  z.object({
    kind: z.literal('fetch_logs'),
    source: z.enum(['system', 'application', 'security']).default('system'),
    lines: z.number().int().min(10).max(200).default(60),
  }).strict(),
  z.object({
    kind: z.literal('diagnostic_command'),
    tool: z.enum(['ipconfig', 'route', 'arp', 'nslookup', 'whoami', 'systeminfo', 'netstat', 'gpresult', 'df', 'uptime']),
    target: z.string().trim().max(180).optional(),
  }).strict(),
  z.object({
    kind: z.literal('mobile_action'),
    action: z.enum([
      'lock_device',
      'reboot_device',
      'enable_lost_mode',
      'disable_lost_mode',
      'install_managed_app',
      'remove_managed_app',
      'push_wifi_profile',
      'push_vpn_profile',
      'enterprise_wipe',
    ]),
    app_identifier: z.string().max(180).optional(),
    lost_message: z.string().max(240).optional(),
    lost_phone: z.string().max(60).optional(),
    confirm_destructive: z.boolean().optional(),
  }).strict(),
]);

function validateCommandForPlatform(
  platform: EndpointPlatform,
  mode: EndpointManagementMode,
  security: EndpointSecurityPosture,
  body: z.infer<typeof commandInputSchema>,
  userRole: string,
): void {
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  // Role checks for high-impact / destructive commands
  if (body.kind === 'power_action' && (body.action === 'restart' || body.action === 'shutdown') && !isAdmin) {
    throw new AppError(403, 'forbidden', 'Restarting or shutting down a machine requires admin privileges');
  }
  if (body.kind === 'software_action' && !isAdmin) {
    throw new AppError(403, 'forbidden', 'Installing or removing software packages requires admin privileges');
  }
  if (body.kind === 'fs_op' && body.op === 'delete') {
    if (!body.confirm_destructive) {
      throw new AppError(400, 'confirmation_required', 'Deleting files or folders requires explicit confirmation');
    }
    if (!isAdmin) {
      throw new AppError(403, 'forbidden', 'Deleting remote files requires admin privileges');
    }
  }
  if (body.kind === 'mobile_action' && body.action === 'enterprise_wipe') {
    if (!body.confirm_destructive) {
      throw new AppError(400, 'confirmation_required', 'Enterprise wipe requires explicit destructive confirmation');
    }
    if (!isAdmin) {
      throw new AppError(403, 'forbidden', 'Enterprise wipe requires admin privileges');
    }
  }

  // Platform capability boundary enforcement
  if (platform === 'ios') {
    if (
      body.kind === 'kill_process' ||
      body.kind === 'service_action' ||
      body.kind === 'fs_op' ||
      body.kind === 'rd_capture' ||
      body.kind === 'rd_input' ||
      body.kind === 'diagnostic_command'
    ) {
      throw new AppError(
        409,
        'unsupported_by_platform',
        `Apple iOS/iPadOS platform security does not permit "${body.kind}"`,
      );
    }
    if (
      body.kind === 'mobile_action' &&
      (body.action === 'enable_lost_mode' || body.action === 'disable_lost_mode' || body.action === 'reboot_device')
    ) {
      if (mode !== 'ios_supervised_mdm' && !security?.supervised) {
        throw new AppError(
          409,
          'requires_supervision',
          `Apple restricts "${body.action}" to Supervised iOS/iPadOS devices`,
        );
      }
    }
  }

  if (platform === 'android') {
    if (body.kind === 'kill_process' || body.kind === 'service_action') {
      throw new AppError(
        409,
        'unsupported_by_platform',
        `Android OS sandboxing does not permit arbitrary "${body.kind}"`,
      );
    }
    if (body.kind === 'mobile_action' && mode === 'android_companion') {
      throw new AppError(
        409,
        'requires_enterprise_enrollment',
        'This action requires Android Enterprise Device Owner or Work Profile enrollment',
      );
    }
  }
}

endpointsRouter.post('/endpoints/:id/commands', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(commandInputSchema, req.body);
  const waitMs = Math.min(6000, Math.max(0, Number.parseInt(String(req.query.wait_ms ?? '0'), 10) || 0));

  const cmd = await withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{
        id: string;
        site_id: string;
        device_id: string | null;
        name: string;
        platform: EndpointPlatform;
        management_mode: EndpointManagementMode;
        status: string;
        last_heartbeat_at: Date | null;
        policy: EndpointPolicy;
        security: EndpointSecurityPosture;
        rd_active: boolean;
      }>(
        `SELECT id, site_id, device_id, name, platform, management_mode, status, last_heartbeat_at, policy, security,
                rd_session IS NOT NULL AS rd_active
           FROM endpoints WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');

    validateCommandForPlatform(ep.platform, ep.management_mode, ep.security ?? {}, body, ctx.role);

    // Screen capture and input only inside a started session: that is where the user is told.
    if ((body.kind === 'rd_capture' || body.kind === 'rd_input') && !ep.rd_active) {
      throw new AppError(409, 'no_remote_session', 'Start a remote desktop session first; the user is notified when it starts');
    }

    if (ep.status !== 'active' || !ep.last_heartbeat_at || ep.last_heartbeat_at.getTime() < Date.now() - 120_000) {
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
    // while auditing every mutating file op, process/service/power/software/mobile action, and session start/stop.
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
        severity:
          (kind === 'power_action' && (body.action === 'restart' || body.action === 'shutdown')) ||
          (kind === 'mobile_action' && body.action === 'enterprise_wipe')
            ? 'warning'
            : 'info',
        title: `Remote action "${kind}" sent to "${ep.name}" by ${ctx.userEmail}`,
        details: { endpoint_id: ep.id, endpoint_name: ep.name, command_id: created.id, kind, ...recorded, requested_by: ctx.userEmail },
        source: 'platform',
        occurredAt: new Date(),
      });
    }

    await notifyRealtime(db, ctx.organizationId, 'devices');
    return created;
  });

  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      const latest = await withTenant(ctx.organizationId, async (db) => {
        const row = (
          await db.query<EndpointCommand>(
            `SELECT id, endpoint_id, kind, payload, status, output, error, result_data, created_by_name, created_at, delivered_at, completed_at
               FROM endpoint_commands WHERE id = $1 AND endpoint_id = $2`,
            [cmd.id, id],
          )
        ).rows[0];
        return row;
      });
      if (latest && (latest.status === 'completed' || latest.status === 'failed')) {
        res.status(200).json(latest);
        return;
      }
    }
  }

  res.status(202).json(cmd);
});
