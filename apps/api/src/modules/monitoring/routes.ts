import { Router } from 'express';
import { z } from 'zod';
import type { CheckSeriesPoint, DefaultChecksRestored, MonitoringCheck } from '@nigafiy/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { classifyTarget, isIP, isIPv6 } from '../../common/net.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { refreshSiteCorrelation, resolveOpenIncidentByKey } from '../correlation/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { AUTO_GATEWAY, restoreDefaultChecks } from './defaults.ts';
import { CHECK_KINDS, type Kind, SNMP_PRESET_CATALOG, assertWatchTarget, parseConfig } from './kinds.ts';

export const monitoringRouter: Router = Router();

const CHECK_SELECT = `
  SELECT c.id, c.site_id, s.name AS site_name, c.name, c.kind, c.role, c.target, c.port, c.interval_seconds, c.failure_threshold,
         c.latency_warn_ms, c.loss_warn_pct, c.enabled, c.state, c.state_changed_at, c.last_result_at, c.last_latency_ms,
         c.last_loss_pct, c.last_error, c.last_resolved_target, c.config, c.snmp_target_id, c.last_value, c.last_details
    FROM monitoring_checks c JOIN sites s ON s.id = c.site_id`;

const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const checkBase = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(CHECK_KINDS),
  role: z.enum(['gateway', 'internet', 'dns', 'service']).default('service'),
  target: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  interval_seconds: z.number().int().min(15).max(3600).default(60),
  failure_threshold: z.number().int().min(1).max(20).default(3),
  latency_warn_ms: z.number().min(1).max(60_000).nullable().default(null),
  loss_warn_pct: z.number().min(0).max(100).nullable().default(null),
  enabled: z.boolean().default(true),
  /** Settings of the watch kinds (http / https / tls_expiry / snmp_oid), validated per kind in kinds.ts. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** snmp_oid: the Port Detective device to read (its stored credentials are reused). */
  snmp_target_id: z.uuid().nullable().default(null),
});

function assertValidTarget(kind: Kind, target: string, port: number | null): void {
  const hostOk = isIP(target) || HOSTNAME.test(target);
  if (kind === 'snmp_oid') {
    if (port !== null) throw new AppError(400, 'invalid_target', 'An SNMP check reads the port configured for its device');
    return; // the target is the configured SNMP device
  }
  if (kind === 'icmp' && target !== AUTO_GATEWAY && !hostOk) throw new AppError(400, 'invalid_target', `Target must be an IPv4 or IPv6 address, a hostname, or "${AUTO_GATEWAY}"`);
  if (kind !== 'icmp' && !hostOk) throw new AppError(400, 'invalid_target', 'Target must be an IPv4 or IPv6 address or a hostname');
  if (isIPv6(target)) {
    const cls = classifyTarget(target);
    if (cls.kind === 'refused') throw new AppError(400, 'invalid_target', `This address cannot be a check target (${cls.reason})`);
  }
  if (kind === 'dns' && isIP(target)) throw new AppError(400, 'invalid_target', 'A DNS check needs a hostname to resolve');
  if ((kind === 'tcp' || kind === 'tls_expiry') && port === null) {
    throw new AppError(400, 'invalid_target', kind === 'tcp' ? 'A TCP check needs a port' : 'A certificate check needs a port (443 for HTTPS)');
  }
  if (!['tcp', 'tls_expiry', 'http', 'https'].includes(kind) && port !== null) throw new AppError(400, 'invalid_target', 'Only TCP, HTTP(S) and certificate checks take a port');
}

/** Validates a watch check's config and target; returns the config to store and, for snmp_oid, the device address. */
async function prepareKind(
  db: Db,
  siteId: string,
  kind: Kind,
  target: string,
  rawConfig: unknown,
  snmpTargetId: string | null,
): Promise<{ config: Record<string, unknown>; target: string; snmpTargetId: string | null }> {
  const config = parseConfig(kind, rawConfig);
  if (kind === 'snmp_oid') {
    if (!snmpTargetId) throw new AppError(400, 'invalid_target', 'Choose the SNMP device (from Port Detective) to read');
    const t = (await db.query<{ host: string }>(`SELECT host(host) AS host FROM snmp_targets WHERE id = $1 AND site_id = $2`, [snmpTargetId, siteId])).rows[0];
    if (!t) throw new AppError(400, 'invalid_target', 'That SNMP device is not configured at this site');
    return { config, target: t.host, snmpTargetId };
  }
  if (snmpTargetId) throw new AppError(400, 'invalid_target', 'Only SNMP checks reference an SNMP device');
  if (kind === 'http' || kind === 'https' || kind === 'tls_expiry') await assertWatchTarget(db, siteId, target, config.allow_public === true);
  return { config, target, snmpTargetId: null };
}

/** The presets of the SNMP check form, with their vendor notes. */
monitoringRouter.get('/checks/snmp-presets', (_req, res) => {
  res.json({ items: SNMP_PRESET_CATALOG });
});

monitoringRouter.get('/checks', async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ site_id: z.uuid().optional() }), req.query);
  const result = await withTenant(ctx.organizationId, (db) =>
    db.query<MonitoringCheck>(
      `${CHECK_SELECT} WHERE ($1::uuid IS NULL OR c.site_id = $1)
        ORDER BY s.name, array_position(ARRAY['gateway','internet','dns','service'], c.role), c.name`,
      [q.site_id ?? null],
    ),
  );
  res.json({ items: result.rows });
});

monitoringRouter.post('/checks', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(checkBase.extend({ site_id: z.uuid(), target: z.string().trim().max(253).default('') }), req.body);
  if (body.kind !== 'snmp_oid' && !body.target) throw new AppError(400, 'invalid_target', 'A target is required');
  assertValidTarget(body.kind, body.target, body.port);
  const check = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) throw notFound('Site');
    const prepared = await prepareKind(db, body.site_id, body.kind, body.target, body.config, body.snmp_target_id);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO monitoring_checks (organization_id, site_id, name, kind, role, target, port, interval_seconds, failure_threshold,
                                      latency_warn_ms, loss_warn_pct, enabled, config, snmp_target_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        ctx.organizationId,
        body.site_id,
        body.name,
        body.kind,
        body.role,
        prepared.target,
        body.port,
        body.interval_seconds,
        body.failure_threshold,
        body.latency_warn_ms,
        body.loss_warn_pct,
        body.enabled,
        JSON.stringify(prepared.config),
        prepared.snmpTargetId,
      ],
    );
    const id = inserted.rows[0]!.id;
    await audit(db, req, 'check.created', { type: 'monitoring_check', id }, {
      name: body.name,
      kind: body.kind,
      target: prepared.target,
      ...(body.port !== null ? { port: body.port } : {}),
      ...(Object.keys(prepared.config).length ? { config: prepared.config } : {}),
    });
    return (await db.query<MonitoringCheck>(`${CHECK_SELECT} WHERE c.id = $1`, [id])).rows[0]!;
  });
  res.status(201).json(check);
});

monitoringRouter.patch('/checks/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(80),
      interval_seconds: z.number().int().min(15).max(3600),
      failure_threshold: z.number().int().min(1).max(20),
      latency_warn_ms: z.number().min(1).max(60_000).nullable(),
      loss_warn_pct: z.number().min(0).max(100).nullable(),
      enabled: z.boolean(),
      config: z.record(z.string(), z.unknown()),
    }).partial().strict(),
    req.body,
  );
  const check = await withTenant(ctx.organizationId, async (db) => {
    const current = (
      await db.query<{ site_id: string; kind: Kind; target: string; snmp_target_id: string | null }>(
        `SELECT site_id, kind, target, snmp_target_id FROM monitoring_checks WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!current) throw notFound('Check');
    const sets: string[] = [];
    const values: unknown[] = [id];
    const { config: rawConfig, ...plain } = body;
    for (const [key, value] of Object.entries(plain)) {
      values.push(value);
      sets.push(`${key} = $${values.length}`); // keys come from the strict schema above, never from the client verbatim
    }
    let auditBody: Record<string, unknown> = plain;
    if (rawConfig !== undefined) {
      // Kind, target and device stay as created; the settings are replaced as a whole and re-validated.
      const prepared = await prepareKind(db, current.site_id, current.kind, current.target, rawConfig, current.snmp_target_id);
      values.push(JSON.stringify(prepared.config));
      sets.push(`config = $${values.length}`);
      auditBody = { ...plain, config: prepared.config };
    }
    if (body.enabled === false) sets.push(`state = 'unknown'`, `pending_state = NULL`, `pending_count = 0`);
    if (sets.length) await db.query(`UPDATE monitoring_checks SET ${sets.join(', ')} WHERE id = $1`, values);
    const row = (await db.query<MonitoringCheck>(`${CHECK_SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!row) throw notFound('Check');
    if (body.enabled === false) {
      await resolveOpenIncidentByKey(db, ctx.organizationId, `check:${id}`, 'the check was disabled');
      await refreshSiteCorrelation(db, ctx.organizationId, row.site_id);
      await notifyRealtime(db, ctx.organizationId, 'events');
    }
    await audit(db, req, 'check.updated', { type: 'monitoring_check', id }, auditBody);
    await notifyRealtime(db, ctx.organizationId, 'checks');
    return row;
  });
  res.json(check);
});

monitoringRouter.delete('/checks/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const deleted = await db.query<{ name: string; site_id: string }>(`DELETE FROM monitoring_checks WHERE id = $1 RETURNING name, site_id`, [id]);
    if (!deleted.rows[0]) throw notFound('Check');
    await resolveOpenIncidentByKey(db, ctx.organizationId, `check:${id}`, 'the check was deleted');
    await refreshSiteCorrelation(db, ctx.organizationId, deleted.rows[0].site_id);
    await audit(db, req, 'check.deleted', { type: 'monitoring_check', id }, { name: deleted.rows[0].name });
    await notifyRealtime(db, ctx.organizationId, 'checks');
    await notifyRealtime(db, ctx.organizationId, 'events');
  });
  res.status(204).end();
});

/**
 * Re-create the site's starter checks (gateway, two internet targets, DNS) that are missing.
 * Idempotent: existing ones — even renamed or re-tuned — are left as they are. 201 when something was created.
 */
monitoringRouter.post('/sites/:id/default-checks', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const result = await withTenant(ctx.organizationId, async (db): Promise<DefaultChecksRestored> => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [id])).rowCount) throw notFound('Site');
    const restored = await restoreDefaultChecks(db, ctx.organizationId, id);
    if (restored.created.length) {
      await audit(db, req, 'check.defaults_restored', { type: 'site', id }, { created: restored.created });
      await notifyRealtime(db, ctx.organizationId, 'checks');
    }
    return { site_id: id, ...restored };
  });
  res.status(result.created.length ? 201 : 200).json(result);
});

// Bucket sizes keep every chart at a few hundred points regardless of range.
const RANGES: Record<string, { seconds: number; bucket: number }> = {
  '15m': { seconds: 900, bucket: 15 },
  '1h': { seconds: 3600, bucket: 30 },
  '24h': { seconds: 86_400, bucket: 300 },
  '7d': { seconds: 604_800, bucket: 3600 },
  '30d': { seconds: 2_592_000, bucket: 14_400 },
  '90d': { seconds: 7_776_000, bucket: 43_200 },
};
// Ranges beyond raw retention are answered from hourly roll-ups.
const ROLLUP_RANGES = new Set(['30d', '90d']);

monitoringRouter.get('/checks/:id/series', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const q = parse(
    z.object({
      range: z.enum(['15m', '1h', '24h', '7d', '30d', '90d']).default('1h'),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    }),
    req.query,
  );
  let from: Date;
  let to: Date;
  let bucket: number;
  if (q.from && q.to) {
    from = new Date(q.from);
    to = new Date(q.to);
    if (to <= from) throw new AppError(400, 'invalid_range', '"to" must be after "from"');
    bucket = Math.max(15, Math.ceil((to.getTime() - from.getTime()) / 1000 / 300));
  } else {
    const r = RANGES[q.range]!;
    to = new Date();
    from = new Date(to.getTime() - r.seconds * 1000);
    bucket = r.bucket;
  }
  const result = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM monitoring_checks WHERE id = $1`, [id])).rowCount) throw notFound('Check');
    if (!(q.from && q.to) && ROLLUP_RANGES.has(q.range)) {
      return db.query<CheckSeriesPoint>(
        `SELECT date_bin(make_interval(secs => $4), bucket, timestamptz '2000-01-01') AS ts,
                sum(samples)::int AS samples,
                (sum(ok_samples)::float8 / nullif(sum(samples), 0)) AS ok_ratio,
                (sum(latency_avg * ok_samples) / nullif(sum(ok_samples) FILTER (WHERE latency_avg IS NOT NULL), 0))::float8 AS latency_ms,
                max(latency_max)::float8 AS latency_max_ms,
                (sum(loss_avg * samples) / nullif(sum(samples) FILTER (WHERE loss_avg IS NOT NULL), 0))::float8 AS loss_pct,
                (sum(jitter_avg * ok_samples) / nullif(sum(ok_samples) FILTER (WHERE jitter_avg IS NOT NULL), 0))::float8 AS jitter_ms,
                (sum(value_avg * ok_samples) / nullif(sum(ok_samples) FILTER (WHERE value_avg IS NOT NULL), 0))::float8 AS value,
                min(value_min)::float8 AS value_min, max(value_max)::float8 AS value_max
           FROM check_results_hourly
          WHERE check_id = $1 AND bucket >= $2 AND bucket < $3
          GROUP BY 1 ORDER BY 1`,
        [id, from, to, bucket],
      );
    }
    return db.query<CheckSeriesPoint>(
      `SELECT date_bin(make_interval(secs => $4), ts, timestamptz '2000-01-01') AS ts,
              count(*)::int AS samples,
              avg(ok::int)::float8 AS ok_ratio,
              (avg(latency_ms) FILTER (WHERE ok))::float8 AS latency_ms,
              (max(latency_ms) FILTER (WHERE ok))::float8 AS latency_max_ms,
              avg(loss_pct)::float8 AS loss_pct,
              (avg(jitter_ms) FILTER (WHERE ok))::float8 AS jitter_ms,
              (avg(value) FILTER (WHERE ok))::float8 AS value,
              (min(value) FILTER (WHERE ok))::float8 AS value_min,
              (max(value) FILTER (WHERE ok))::float8 AS value_max
         FROM check_results
        WHERE check_id = $1 AND ts >= $2 AND ts < $3
        GROUP BY 1 ORDER BY 1`,
      [id, from, to, bucket],
    );
  });
  res.json({ from, to, bucket_seconds: bucket, points: result.rows });
});
