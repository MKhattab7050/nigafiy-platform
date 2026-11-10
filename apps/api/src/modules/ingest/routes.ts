import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError, parse } from '../../common/http.ts';
import { randomToken, safeEqual, sha256 } from '../../common/crypto.ts';
import { env } from '../../config/env.ts';
import { systemPool, withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { emitEvent, notifyRealtime } from '../events/emit.ts';
import { refineCollectorIncident } from '../incidents/engine.ts';
import { processCheckResult } from './checks.ts';
import { processDiscoveryRun } from './discovery.ts';
import { type CollectorContext, ItemRejected, enrollSchema, heartbeatSchema, telemetryBatchSchema } from './schema.ts';

/** Collector-facing API. Collectors only ever make outbound HTTPS requests to these endpoints. */
export const collectorGatewayRouter: Router = Router();

const HEARTBEAT_INTERVAL_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalidCredential = () => new AppError(401, 'invalid_collector_credential', 'Collector credential is missing, invalid or revoked');

const enrollLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many enrollment attempts' } },
});

collectorGatewayRouter.use(express.json({ limit: '2mb' }));

/**
 * Enrollment: exchange a single-use, expiring enrollment token (created by an administrator)
 * for a long-lived per-collector credential. The organization and site come from the token's
 * database row — never from anything the collector sends.
 */
collectorGatewayRouter.post('/enroll', enrollLimiter, async (req, res) => {
  const body = parse(enrollSchema, req.body);
  const secret = randomToken(32);
  const enrolled = await withSystem(async (db) => {
    // Single statement = atomic: two racing requests cannot both consume the token.
    const updated = await db.query<{ id: string; organization_id: string; site_id: string; name: string }>(
      `UPDATE collectors
          SET status = 'active', credential_hash = $2, enrollment_token_hash = NULL, enrollment_expires_at = NULL,
              hostname = $3, version = $4, os = $5, arch = $6, last_ip = $7
        WHERE enrollment_token_hash = $1 AND status = 'pending' AND enrollment_expires_at > now()
        RETURNING id, organization_id, site_id, name`,
      [sha256(body.enrollment_token), sha256(secret), body.hostname, body.version, body.os, body.arch, req.ip ?? null],
    );
    const row = updated.rows[0];
    if (!row) return null;
    await emitEvent(db, row.organization_id, {
      siteId: row.site_id,
      collectorId: row.id,
      type: 'collector_enrolled',
      severity: 'info',
      title: `Collector "${row.name}" enrolled`,
      details: { hostname: body.hostname, version: body.version, os: body.os, arch: body.arch, remote_address: req.ip ?? null },
      source: 'platform',
      occurredAt: new Date(),
    });
    await notifyRealtime(db, row.organization_id, 'collectors');
    return row;
  });
  if (!enrolled) {
    logger.warn({ ip: req.ip }, 'rejected collector enrollment');
    throw new AppError(401, 'invalid_enrollment_token', 'Enrollment token is invalid, already used or expired');
  }
  logger.info({ collector_id: enrolled.id, organization_id: enrolled.organization_id }, 'collector enrolled');
  res.status(201).json({ collector_id: enrolled.id, credential: `ldc_${enrolled.id}.${secret}`, heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS });
});

/** Authenticates `Authorization: Bearer ldc_<collector-id>.<secret>` and loads the tenant binding from the database. */
async function requireCollector(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer ldc_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!match || !UUID.test(match[1]!)) throw invalidCredential();
  const { rows } = await systemPool.query<{
    id: string;
    organization_id: string;
    site_id: string;
    name: string;
    credential_hash: string | null;
    connection_state: CollectorContext['connectionState'];
    gateway_ip: string | null;
    os: string | null;
    hostname: string | null;
  }>(
    `SELECT id, organization_id, site_id, name, credential_hash, connection_state, host(gateway_ip) AS gateway_ip, os, hostname
       FROM collectors WHERE id = $1 AND status = 'active'`,
    [match[1]],
  );
  const row = rows[0];
  if (!row?.credential_hash || !safeEqual(row.credential_hash, sha256(match[2]!))) throw invalidCredential();
  req.collector = {
    id: row.id,
    organizationId: row.organization_id,
    siteId: row.site_id,
    name: row.name,
    connectionState: row.connection_state,
    gatewayIp: row.gateway_ip,
    os: row.os,
    hostname: row.hostname,
  };
  next();
}

collectorGatewayRouter.post('/heartbeat', requireCollector, async (req, res) => {
  const c = req.collector!;
  const body = parse(heartbeatSchema, req.body);
  const now = new Date();

  const response = await withTenant(c.organizationId, async (db) => {
    await db.query(
      `UPDATE collectors
          SET last_heartbeat_at = $2, connection_state = 'online', hostname = $3, version = $4, os = $5, arch = $6,
              gateway_ip = $7, interfaces = $8, spool_depth = $9, last_ip = $10
        WHERE id = $1`,
      [c.id, now, body.hostname, body.version, body.os, body.arch, body.gateway_ip ?? null, JSON.stringify(body.interfaces), body.spool_depth, req.ip ?? null],
    );
    if (c.connectionState !== 'online') {
      if (c.connectionState === 'offline') {
        await emitEvent(db, c.organizationId, {
          siteId: c.siteId,
          collectorId: c.id,
          type: 'collector_online',
          severity: 'info',
          title: `Collector "${c.name}" reconnected`,
          details: { buffered_batches_waiting: body.spool_depth, note: 'Telemetry buffered while disconnected is uploaded with its original timestamps.' },
          source: 'platform',
          occurredAt: now,
        });
      }
      await notifyRealtime(db, c.organizationId, 'collectors');
    }
    if (body.completed_commands.length) {
      await db.query(`UPDATE collector_commands SET status = 'completed', completed_at = $3 WHERE collector_id = $1 AND id = ANY($2)`, [c.id, body.completed_commands, now]);
    }

    const site = await db.query<{ discovery_interval_seconds: number }>(`SELECT discovery_interval_seconds FROM sites WHERE id = $1`, [c.siteId]);
    const scopes = await db.query<{ id: string; cidr: string }>(
      `SELECT id, cidr::text AS cidr FROM network_scopes WHERE site_id = $1 AND enabled ORDER BY cidr`,
      [c.siteId],
    );
    const checks = await db.query(
      `SELECT id, kind, target, port, interval_seconds FROM monitoring_checks WHERE site_id = $1 AND enabled ORDER BY array_position(ARRAY['gateway','internet','dns','service'], role), name, id`,
      [c.siteId],
    );
    // A wake request that could not be delivered within 10 minutes expires: waking a computer an
    // hour after someone asked is not what they wanted.
    await db.query(
      `UPDATE collector_commands SET status = 'completed', completed_at = $2
        WHERE collector_id = $1 AND kind = 'wake_device' AND status <> 'completed' AND created_at < $2::timestamptz - interval '10 minutes'`,
      [c.id, now],
    );
    // Commands stay "delivered" (and are re-sent) until the collector acknowledges completion.
    const commands = await db.query<{ id: string; kind: string; payload: Record<string, unknown> }>(
      `UPDATE collector_commands SET status = 'delivered', delivered_at = coalesce(delivered_at, $2)
        WHERE collector_id = $1 AND status <> 'completed' RETURNING id, kind, payload`,
      [c.id, now],
    );

    return {
      server_time: now.toISOString(),
      config: {
        heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
        discovery: {
          interval_seconds: site.rows[0]?.discovery_interval_seconds ?? 300,
          // The server-side source of truth for what may be probed. The collector additionally
          // enforces its own local allow-list and hard limits.
          scopes: scopes.rows,
        },
        checks: checks.rows,
      },
      commands: commands.rows,
    };
  });
  res.json(response);
});

collectorGatewayRouter.post('/telemetry', requireCollector, async (req, res) => {
  const c = req.collector!;
  const batch = parse(telemetryBatchSchema, req.body);
  const now = new Date();

  const result = await withTenant(c.organizationId, async (db) => {
    // Idempotency: collectors deliver at-least-once; a replayed batch is acknowledged and ignored.
    const ledger = await db.query(`INSERT INTO ingest_batches (collector_id, batch_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      c.id,
      batch.batch_id,
      c.organizationId,
    ]);
    if (ledger.rowCount === 0) return { duplicate: true, accepted: 0, rejected: [] as { index: number; reason: string }[] };

    const ordered = batch.items
      .map((item, index) => ({ item, index, at: Date.parse(item.type === 'discovery_run' ? item.finished_at : item.ts) }))
      .sort((a, b) => a.at - b.at);
    const rejected: { index: number; reason: string }[] = [];
    let accepted = 0;
    let touchedDevices = false;
    for (const { item, index } of ordered) {
      // Savepoint per item: one bad item cannot abort or poison the rest of the batch.
      await db.query('SAVEPOINT item');
      try {
        if (item.type === 'discovery_run') {
          await processDiscoveryRun(db, c, item, now);
          touchedDevices = true;
        } else {
          await processCheckResult(db, c, item, now);
        }
        await db.query('RELEASE SAVEPOINT item');
        accepted++;
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT item');
        if (!(err instanceof ItemRejected)) throw err;
        rejected.push({ index, reason: err.message });
      }
    }
    if (touchedDevices) await notifyRealtime(db, c.organizationId, 'devices');
    if (accepted) await refineCollectorIncident(db, c.organizationId, c.id);
    return { duplicate: false, accepted, rejected };
  });

  if (result.rejected.length) logger.warn({ collector_id: c.id, rejected: result.rejected.slice(0, 5) }, 'telemetry items rejected');
  res.json(result);
});
