import { Router } from 'express';
import { z } from 'zod';
import type { ToolRun } from '@nigafiy/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { assertToolScope, assertToolTarget, TOOL_KINDS } from './queue.ts';

export const toolboxRouter: Router = Router();

const RUN_SELECT = `
  SELECT r.id, r.site_id, r.collector_id, c.name AS collector_name, r.tool, r.target, r.port,
         r.status, r.output, r.error, r.duration_ms, r.created_at, r.completed_at
    FROM toolbox_runs r
    JOIN collectors c ON c.organization_id = r.organization_id AND c.id = r.collector_id`;

async function expireStaleRuns(db: Db): Promise<void> {
  await db.query(
    `UPDATE toolbox_runs
        SET status = 'expired',
            error = 'The collector did not report a result within 5 minutes',
            completed_at = now()
      WHERE status = 'pending' AND created_at < now() - interval '5 minutes'`,
  );
}

toolboxRouter.get('/toolbox', async (req, res) => {
  const ctx = auth(req);
  const q = parse(
    z.object({
      site_id: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
    req.query,
  );
  const items = await withTenant(ctx.organizationId, async (db) => {
    await expireStaleRuns(db);
    const result = await db.query<ToolRun>(
      `${RUN_SELECT}
        WHERE ($1::uuid IS NULL OR r.site_id = $1)
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [q.site_id ?? null, q.limit],
    );
    return result.rows;
  });
  res.json({ items });
});

toolboxRouter.get('/toolbox/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const run = await withTenant(ctx.organizationId, async (db) => {
    await expireStaleRuns(db);
    const result = await db.query<ToolRun>(`${RUN_SELECT} WHERE r.id = $1`, [id]);
    if (!result.rows[0]) throw notFound('Toolbox run');
    return result.rows[0];
  });
  res.json(run);
});

const createRunSchema = z
  .object({
    site_id: z.uuid(),
    tool: z.enum(TOOL_KINDS),
    target: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535).nullable().default(null),
  })
  .strict();

toolboxRouter.post('/toolbox', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(createRunSchema, req.body);
  assertToolTarget(body.tool, body.target, body.port);

  const run = await withTenant(ctx.organizationId, async (db) => {
    await expireStaleRuns(db);
    const site = await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id]);
    if (!site.rowCount) throw notFound('Site');
    await assertToolScope(db, body.site_id, body.tool, body.target);

    const collector = (
      await db.query<{ id: string; name: string }>(
        `SELECT id, name FROM collectors
          WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '2 minutes'
          ORDER BY last_heartbeat_at DESC LIMIT 1`,
        [body.site_id],
      )
    ).rows[0];
    if (!collector) {
      throw new AppError(409, 'no_collector', 'No collector of this site is online to run the tool');
    }

    const pending = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM toolbox_runs WHERE collector_id = $1 AND status = 'pending'`,
      [collector.id],
    );
    if (Number(pending.rows[0]?.count ?? 0) >= 5) {
      throw new AppError(429, 'too_many_runs', 'Several toolbox requests are already waiting on this collector');
    }

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO toolbox_runs (organization_id, site_id, collector_id, tool, target, port, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.organizationId, body.site_id, collector.id, body.tool, body.target, body.port, ctx.userId],
    );
    const runId = inserted.rows[0]!.id;

    const payload: Record<string, unknown> = { run_id: runId, tool: body.tool, target: body.target };
    if (body.port !== null) payload.port = body.port;

    await db.query(
      `INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by)
       VALUES ($1,$2,'run_tool',$3,$4)`,
      [ctx.organizationId, collector.id, JSON.stringify(payload), ctx.userId],
    );

    await audit(db, req, 'toolbox.run', { type: 'toolbox_run', id: runId }, {
      site_id: body.site_id,
      collector_id: collector.id,
      tool: body.tool,
      target: body.target,
      port: body.port,
    });
    await notifyRealtime(db, ctx.organizationId, 'checks');
    return (await db.query<ToolRun>(`${RUN_SELECT} WHERE r.id = $1`, [runId])).rows[0]!;
  });

  res.status(202).json(run);
});
