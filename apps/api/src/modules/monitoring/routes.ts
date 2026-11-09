import { Router } from 'express';
import { z } from 'zod';
import type { CheckSeriesPoint, MonitoringCheck } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { isIPv4 } from '../../common/net.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../events/emit.ts';
import { AUTO_GATEWAY } from './defaults.ts';

export const monitoringRouter: Router = Router();

const CHECK_SELECT = `
  SELECT c.id, c.site_id, s.name AS site_name, c.name, c.kind, c.role, c.target, c.port, c.interval_seconds, c.failure_threshold,
         c.latency_warn_ms, c.loss_warn_pct, c.enabled, c.state, c.state_changed_at, c.last_result_at, c.last_latency_ms,
         c.last_loss_pct, c.last_error, c.last_resolved_target
    FROM monitoring_checks c JOIN sites s ON s.id = c.site_id`;

const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const checkBase = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['icmp', 'tcp', 'dns']),
  role: z.enum(['gateway', 'internet', 'dns', 'service']).default('service'),
  target: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  interval_seconds: z.number().int().min(15).max(3600).default(60),
  failure_threshold: z.number().int().min(1).max(20).default(3),
  latency_warn_ms: z.number().min(1).max(60_000).nullable().default(null),
  loss_warn_pct: z.number().min(0).max(100).nullable().default(null),
  enabled: z.boolean().default(true),
});

function assertValidTarget(kind: string, target: string, port: number | null): void {
  const hostOk = isIPv4(target) || HOSTNAME.test(target);
  if (kind === 'icmp' && target !== AUTO_GATEWAY && !hostOk) throw new AppError(400, 'invalid_target', `Target must be an IPv4 address, a hostname, or "${AUTO_GATEWAY}"`);
  if (kind !== 'icmp' && !hostOk) throw new AppError(400, 'invalid_target', 'Target must be an IPv4 address or a hostname');
  if (kind === 'dns' && isIPv4(target)) throw new AppError(400, 'invalid_target', 'A DNS check needs a hostname to resolve');
  if (kind === 'tcp' && port === null) throw new AppError(400, 'invalid_target', 'A TCP check needs a port');
  if (kind !== 'tcp' && port !== null) throw new AppError(400, 'invalid_target', 'Only TCP checks take a port');
}

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
  const body = parse(checkBase.extend({ site_id: z.uuid() }), req.body);
  assertValidTarget(body.kind, body.target, body.port);
  const check = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) throw notFound('Site');
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO monitoring_checks (organization_id, site_id, name, kind, role, target, port, interval_seconds, failure_threshold,
                                      latency_warn_ms, loss_warn_pct, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [ctx.organizationId, body.site_id, body.name, body.kind, body.role, body.target, body.port, body.interval_seconds, body.failure_threshold, body.latency_warn_ms, body.loss_warn_pct, body.enabled],
    );
    const id = inserted.rows[0]!.id;
    await audit(db, req, 'check.created', { type: 'monitoring_check', id }, { name: body.name, kind: body.kind, target: body.target });
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
    }).partial().strict(),
    req.body,
  );
  const check = await withTenant(ctx.organizationId, async (db) => {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, value] of Object.entries(body)) {
      values.push(value);
      sets.push(`${key} = $${values.length}`); // keys come from the strict schema above, never from the client verbatim
    }
    if (body.enabled === false) sets.push(`state = 'unknown'`, `pending_state = NULL`, `pending_count = 0`);
    if (sets.length) await db.query(`UPDATE monitoring_checks SET ${sets.join(', ')} WHERE id = $1`, values);
    const row = (await db.query<MonitoringCheck>(`${CHECK_SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!row) throw notFound('Check');
    await audit(db, req, 'check.updated', { type: 'monitoring_check', id }, body);
    await notifyRealtime(db, ctx.organizationId, 'checks');
    return row;
  });
  res.json(check);
});

monitoringRouter.delete('/checks/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const deleted = await db.query<{ name: string }>(`DELETE FROM monitoring_checks WHERE id = $1 RETURNING name`, [id]);
    if (!deleted.rows[0]) throw notFound('Check');
    await audit(db, req, 'check.deleted', { type: 'monitoring_check', id }, { name: deleted.rows[0].name });
  });
  res.status(204).end();
});

// Bucket sizes keep every chart at a few hundred points regardless of range.
const RANGES: Record<string, { seconds: number; bucket: number }> = {
  '15m': { seconds: 900, bucket: 15 },
  '1h': { seconds: 3600, bucket: 30 },
  '24h': { seconds: 86_400, bucket: 300 },
  '7d': { seconds: 604_800, bucket: 3600 },
  '30d': { seconds: 2_592_000, bucket: 14_400 },
};

monitoringRouter.get('/checks/:id/series', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const q = parse(
    z.object({
      range: z.enum(['15m', '1h', '24h', '7d', '30d']).default('1h'),
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
    return db.query<CheckSeriesPoint>(
      `SELECT date_bin(make_interval(secs => $4), ts, timestamptz '2000-01-01') AS ts,
              count(*)::int AS samples,
              avg(ok::int)::float8 AS ok_ratio,
              (avg(latency_ms) FILTER (WHERE ok))::float8 AS latency_ms,
              (max(latency_ms) FILTER (WHERE ok))::float8 AS latency_max_ms,
              avg(loss_pct)::float8 AS loss_pct,
              (avg(jitter_ms) FILTER (WHERE ok))::float8 AS jitter_ms
         FROM check_results
        WHERE check_id = $1 AND ts >= $2 AND ts < $3
        GROUP BY 1 ORDER BY 1`,
      [id, from, to, bucket],
    );
  });
  res.json({ from, to, bucket_seconds: bucket, points: result.rows });
});
