import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { EndpointCommand, EndpointCreated, EndpointDetail, EndpointSeriesPoint, EndpointSummary } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { randomToken, safeEqual, sha256 } from '../../common/crypto.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { normalizeMac } from '../../common/net.ts';
import { env } from '../../config/env.ts';
import { type Db, systemPool, withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { emitEvent, notifyRealtime } from '../events/emit.ts';
import { agentEnrollSchema, agentHeartbeatSchema, agentInventorySchema, type EndpointContext } from './schema.ts';

export const endpointAgentGatewayRouter: Router = Router();
export const endpointsRouter: Router = Router();

const HEARTBEAT_INTERVAL_SECONDS = 20;
const ENROLLMENT_TTL_HOURS = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ENDPOINT_SUMMARY_SELECT = `
  SELECT e.id, e.site_id, s.name AS site_name, e.device_id, e.name, e.status, e.connection_state,
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

// ── Agent-facing gateway (/api/v1/agent/*) ──────────────────────────────────

const enrollLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many enrollment attempts' } },
});

endpointAgentGatewayRouter.use(express.json({ limit: '2mb' }));

endpointAgentGatewayRouter.post('/enroll', enrollLimiter, async (req, res) => {
  const body = parse(agentEnrollSchema, req.body);
  const secret = randomToken(32);
  const mac = body.primary_mac ? normalizeMac(body.primary_mac) : null;

  const enrolled = await withSystem(async (db) => {
    const updated = await db.query<{ id: string; organization_id: string; site_id: string; name: string; device_id: string | null }>(
      `UPDATE endpoints
          SET status = 'active', credential_hash = $2, enrollment_token_hash = NULL, enrollment_expires_at = NULL,
              hostname = $3, agent_version = $4, os = $5, os_version = $6, arch = $7,
              cpu_model = $8, cpu_cores = $9, ram_total_mb = $10, primary_ip = $11, primary_mac = $12
        WHERE enrollment_token_hash = $1 AND status = 'pending' AND enrollment_expires_at > now()
        RETURNING id, organization_id, site_id, name, device_id`,
      [
        sha256(body.enrollment_token),
        sha256(secret),
        body.hostname,
        body.agent_version,
        body.os,
        body.os_version ?? null,
        body.arch,
        body.cpu_model ?? null,
        body.cpu_cores ?? null,
        body.ram_total_mb ?? null,
        body.primary_ip ?? null,
        mac,
      ],
    );
    const row = updated.rows[0];
    if (!row) return null;

    if (!row.device_id && (mac || body.primary_ip)) {
      const linked = await db.query<{ id: string }>(
        `SELECT id FROM devices
          WHERE organization_id = $1 AND site_id = $2
            AND (($3::macaddr IS NOT NULL AND primary_mac = $3::macaddr)
                 OR ($4::inet IS NOT NULL AND current_ip = $4::inet))
          ORDER BY (primary_mac IS NOT NULL AND primary_mac = $3::macaddr) DESC, last_seen_at DESC
          LIMIT 1`,
        [row.organization_id, row.site_id, mac, body.primary_ip ?? null],
      );
      if (linked.rows[0]) {
        await db.query(`UPDATE endpoints SET device_id = $2 WHERE id = $1`, [row.id, linked.rows[0].id]);
        row.device_id = linked.rows[0].id;
      }
    }

    await emitEvent(db, row.organization_id, {
      siteId: row.site_id,
      deviceId: row.device_id,
      type: 'endpoint_enrolled',
      severity: 'info',
      title: `Endpoint "${row.name}" (${body.hostname}) enrolled`,
      details: {
        endpoint_id: row.id,
        hostname: body.hostname,
        os: body.os,
        os_version: body.os_version ?? null,
        arch: body.arch,
        agent_version: body.agent_version,
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
    credential_hash: string | null;
    connection_state: EndpointContext['connectionState'];
  }>(`SELECT id, organization_id, site_id, device_id, name, credential_hash, connection_state FROM endpoints WHERE id = $1 AND status = 'active'`, [match[1]]);
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
    connectionState: row.connection_state,
  };
  next();
}

endpointAgentGatewayRouter.post('/heartbeat', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(agentHeartbeatSchema, req.body);
  const now = new Date();
  const mac = body.primary_mac ? normalizeMac(body.primary_mac) : null;

  const response = await withTenant(ep.organizationId, async (db) => {
    const deviceId = ep.deviceId ?? (await resolveDeviceLink(db, ep.siteId, mac ?? undefined, body.primary_ip));

    await db.query(
      `UPDATE endpoints
          SET last_heartbeat_at = $2, connection_state = 'online', device_id = coalesce($3, device_id),
              agent_version = $4, hostname = $5, os = $6, os_version = coalesce($7, os_version), arch = $8,
              cpu_model = coalesce($9, cpu_model), cpu_cores = coalesce($10, cpu_cores), ram_total_mb = coalesce($11, ram_total_mb),
              uptime_seconds = $12, logged_in_users = $13, primary_ip = coalesce($14, primary_ip), primary_mac = coalesce($15, primary_mac),
              cpu_pct = $16, ram_used_mb = $17, ram_pct = $18, disk_used_pct = coalesce($19, disk_used_pct),
              disks = CASE WHEN $20::jsonb IS NOT NULL THEN $20::jsonb ELSE disks END,
              interfaces = CASE WHEN $21::jsonb IS NOT NULL THEN $21::jsonb ELSE interfaces END
        WHERE id = $1`,
      [
        ep.id,
        now,
        deviceId,
        body.agent_version,
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
        body.disk_used_pct ?? null,
        body.disks ? JSON.stringify(body.disks) : null,
        body.interfaces ? JSON.stringify(body.interfaces) : null,
      ],
    );

    await db.query(
      `INSERT INTO endpoint_samples (endpoint_id, ts, organization_id, cpu_pct, ram_pct, ram_used_mb, disk_used_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [ep.id, now, ep.organizationId, body.cpu_pct, body.ram_pct, body.ram_used_mb, body.disk_used_pct ?? null],
    );

    for (const resItem of body.command_results) {
      await db.query(
        `UPDATE endpoint_commands
            SET status = $3, output = $4, error = $5, completed_at = $6
          WHERE id = $1 AND endpoint_id = $2 AND status IN ('pending', 'delivered')`,
        [resItem.id, ep.id, resItem.ok ? 'completed' : 'failed', resItem.output ?? null, resItem.error ?? null, now],
      );
    }

    // Expire stale pending commands older than 10 minutes
    await db.query(
      `UPDATE endpoint_commands
          SET status = 'expired', error = 'Command expired before the agent executed it', completed_at = $2
        WHERE endpoint_id = $1 AND status IN ('pending', 'delivered') AND created_at < $2::timestamptz - interval '10 minutes'`,
      [ep.id, now],
    );

    const commands = await db.query<{ id: string; kind: string; payload: Record<string, unknown> }>(
      `UPDATE endpoint_commands
          SET status = 'delivered', delivered_at = coalesce(delivered_at, $2)
        WHERE endpoint_id = $1 AND status IN ('pending', 'delivered')
        RETURNING id, kind, payload`,
      [ep.id, now],
    );

    if (ep.connectionState !== 'online' || body.command_results.length > 0) {
      await notifyRealtime(db, ep.organizationId, 'devices');
    }

    return {
      server_time: now.toISOString(),
      heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
      commands: commands.rows,
    };
  });

  res.json(response);
});

endpointAgentGatewayRouter.post('/inventory', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(agentInventorySchema, req.body);
  const now = new Date();
  const topDiskPct = body.disks.length ? Math.max(...body.disks.map((d) => d.used_pct)) : null;

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
        JSON.stringify(body.connections),
        topDiskPct,
        now,
      ],
    );
    await notifyRealtime(db, ep.organizationId, 'devices');
  });

  res.json({ ok: true });
});

// ── User-facing API (/api/v1/endpoints/*) ───────────────────────────────────

endpointsRouter.get('/endpoints', async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ site_id: z.uuid().optional(), device_id: z.uuid().optional() }), req.query);
  const items = await withTenant(ctx.organizationId, (db) =>
    db.query<EndpointSummary>(
      `${ENDPOINT_SUMMARY_SELECT}
        WHERE ($1::uuid IS NULL OR e.site_id = $1)
          AND ($2::uuid IS NULL OR e.device_id = $2)
        ORDER BY CASE e.connection_state WHEN 'online' THEN 0 WHEN 'offline' THEN 1 ELSE 2 END, e.name`,
      [q.site_id ?? null, q.device_id ?? null],
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
      device_id: z.uuid().nullable().optional(),
    }).strict(),
    req.body,
  );
  const enrollment = newEnrollmentToken();
  const endpoint = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) throw notFound('Site');
    if (body.device_id) {
      if (!(await db.query(`SELECT 1 FROM devices WHERE id = $1 AND site_id = $2`, [body.device_id, body.site_id])).rowCount) {
        throw notFound('Device');
      }
    }
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO endpoints (organization_id, site_id, device_id, name, enrollment_token_hash, enrollment_expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.organizationId, body.site_id, body.device_id ?? null, body.name, enrollment.hash, enrollment.expires, ctx.userId],
    );
    const id = inserted.rows[0]!.id;
    await audit(db, req, 'endpoint.created', { type: 'endpoint', id }, { name: body.name, site_id: body.site_id, device_id: body.device_id ?? null });
    return (await db.query<EndpointSummary>(`${ENDPOINT_SUMMARY_SELECT} WHERE e.id = $1`, [id])).rows[0]!;
  });
  const response: EndpointCreated = { endpoint, enrollment_token: enrollment.token };
  res.status(201).json(response);
});

endpointsRouter.post('/endpoints/:id/enrollment-token', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const enrollment = newEnrollmentToken();
  const endpoint = await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE endpoints SET enrollment_token_hash = $2, enrollment_expires_at = $3 WHERE id = $1 AND status = 'pending'`,
      [id, enrollment.hash, enrollment.expires],
    );
    if (!updated.rowCount) throw new AppError(409, 'not_pending', 'Only endpoints that have not enrolled yet can get a new enrollment token');
    await audit(db, req, 'endpoint.enrollment_token_reissued', { type: 'endpoint', id });
    return (await db.query<EndpointSummary>(`${ENDPOINT_SUMMARY_SELECT} WHERE e.id = $1`, [id])).rows[0]!;
  });
  const response: EndpointCreated = { endpoint, enrollment_token: enrollment.token };
  res.json(response);
});

endpointsRouter.post('/endpoints/:id/revoke', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE endpoints SET status = 'revoked', connection_state = 'offline', revoked_at = now(), credential_hash = NULL, enrollment_token_hash = NULL
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
        `${ENDPOINT_SUMMARY_SELECT.replace('FROM endpoints e', ', e.disks, e.interfaces, e.processes, e.services, e.software, e.connections FROM endpoints e')}
          WHERE e.id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    const commands = await db.query<EndpointCommand>(
      `SELECT id, endpoint_id, kind, payload, status, output, error, created_by_name, created_at, delivered_at, completed_at
         FROM endpoint_commands
        WHERE endpoint_id = $1
        ORDER BY created_at DESC
        LIMIT 40`,
      [id],
    );
    ep.commands = commands.rows;
    return ep;
  });
  res.json(detail);
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
]);

endpointsRouter.post('/endpoints/:id/commands', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(commandInputSchema, req.body);

  // Powering off or rebooting a remote machine requires admin/owner privileges.
  if (body.kind === 'power_action' && (body.action === 'restart' || body.action === 'shutdown')) {
    if (ctx.role !== 'admin' && ctx.role !== 'owner') {
      throw new AppError(403, 'forbidden', 'Restarting or shutting down a machine requires admin privileges');
    }
  }

  const { kind, ...payload } = body;

  const cmd = await withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{ id: string; site_id: string; device_id: string | null; name: string; status: string; last_heartbeat_at: Date | null }>(
        `SELECT id, site_id, device_id, name, status, last_heartbeat_at FROM endpoints WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');
    if (ep.status !== 'active' || !ep.last_heartbeat_at || ep.last_heartbeat_at.getTime() < Date.now() - 120_000) {
      throw new AppError(409, 'endpoint_offline', 'This endpoint is not currently online');
    }

    const inserted = await db.query<EndpointCommand>(
      `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, endpoint_id, kind, payload, status, output, error, created_by_name, created_at, delivered_at, completed_at`,
      [ctx.organizationId, id, kind, JSON.stringify(payload), ctx.userId, ctx.userEmail],
    );
    const created = inserted.rows[0]!;

    await audit(db, req, `endpoint.${kind}`, { type: 'endpoint', id }, { command_id: created.id, ...payload });

    if (kind !== 'refresh_inventory') {
      await emitEvent(db, ctx.organizationId, {
        siteId: ep.site_id,
        deviceId: ep.device_id,
        type: 'endpoint_command',
        severity: kind === 'power_action' && (body.action === 'restart' || body.action === 'shutdown') ? 'warning' : 'info',
        title: `Remote action "${kind}" sent to "${ep.name}" by ${ctx.userEmail}`,
        details: { endpoint_id: ep.id, endpoint_name: ep.name, command_id: created.id, kind, ...payload, requested_by: ctx.userEmail },
        source: 'platform',
        occurredAt: new Date(),
      });
    }

    await notifyRealtime(db, ctx.organizationId, 'devices');
    return created;
  });

  res.status(202).json(cmd);
});
