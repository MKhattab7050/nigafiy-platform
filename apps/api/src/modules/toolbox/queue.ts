import type { ToolKind } from '@lan-detective/shared-types';
import { AppError, notFound } from '../../common/http.ts';
import { isIPv4 } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';

// Queue a toolbox run from another module (playbooks), inside the caller's tenant transaction.
// Same rules as POST /toolbox (routes.ts): valid target, an online collector of the site, at most
// five runs waiting per collector. The caller audits.

export const TOOL_KINDS = ['ping', 'tcp', 'ports', 'dns', 'rdns', 'traceroute'] as const satisfies readonly ToolKind[];
// Same hostname pattern the collector enforces: cannot begin with '-', so it can never be parsed as an option flag.
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}))*\.?$/;

/** The toolbox's target rules (identical to routes.ts). Throws a 400 explaining what is wrong. */
export function assertToolTarget(tool: ToolKind, target: string, port: number | null): void {
  const ip = isIPv4(target);
  const hostOk = ip || (target.length <= 253 && HOSTNAME.test(target));
  if (!hostOk) throw new AppError(400, 'invalid_target', 'Target must be an IPv4 address or a valid hostname');
  if (tool === 'dns' && ip) throw new AppError(400, 'invalid_target', 'A DNS lookup needs a hostname; use reverse DNS for an IPv4 address');
  if (tool === 'rdns' && !ip) throw new AppError(400, 'invalid_target', 'Reverse DNS needs an IPv4 address');
  if (tool === 'tcp' && port === null) throw new AppError(400, 'invalid_target', 'A TCP port check needs a port between 1 and 65535');
  if (tool !== 'tcp' && port !== null) throw new AppError(400, 'invalid_target', 'Only a TCP port check takes a port');
}

export interface ToolRunQueued {
  run_id: string;
  collector_id: string;
  collector: string;
}

export async function queueToolRun(
  db: Db,
  organizationId: string,
  run: { siteId: string; tool: ToolKind; target: string; port: number | null; createdBy: string | null },
): Promise<ToolRunQueued> {
  assertToolTarget(run.tool, run.target, run.port);
  const site = await db.query(`SELECT 1 FROM sites WHERE id = $1`, [run.siteId]);
  if (!site.rowCount) throw notFound('Site');
  const collector = (
    await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM collectors
        WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '2 minutes'
        ORDER BY last_heartbeat_at DESC LIMIT 1`,
      [run.siteId],
    )
  ).rows[0];
  if (!collector) throw new AppError(409, 'no_collector', 'No collector of this site is online to run the tool');
  const pending = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM toolbox_runs WHERE collector_id = $1 AND status = 'pending'`, [collector.id]);
  if (Number(pending.rows[0]?.count ?? 0) >= 5) throw new AppError(429, 'too_many_runs', 'Several toolbox requests are already waiting on this collector');

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO toolbox_runs (organization_id, site_id, collector_id, tool, target, port, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [organizationId, run.siteId, collector.id, run.tool, run.target, run.port, run.createdBy],
  );
  const runId = inserted.rows[0]!.id;
  const payload: Record<string, unknown> = { run_id: runId, tool: run.tool, target: run.target };
  if (run.port !== null) payload.port = run.port;
  await db.query(`INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by) VALUES ($1,$2,'run_tool',$3,$4)`, [
    organizationId,
    collector.id,
    JSON.stringify(payload),
    run.createdBy,
  ]);
  await notifyRealtime(db, organizationId, 'checks');
  return { run_id: runId, collector_id: collector.id, collector: collector.name };
}

export interface ToolRunState {
  status: 'pending' | 'completed' | 'failed' | 'expired';
  output: Record<string, unknown> | null;
  error: string | null;
  duration_ms: number | null;
  completed_at: Date | null;
}

/** Current state of a run; a run nobody answered within 5 minutes is marked expired (as GET /toolbox does). */
export async function toolRunState(db: Db, runId: string): Promise<ToolRunState | null> {
  await db.query(
    `UPDATE toolbox_runs SET status = 'expired', error = 'The collector did not report a result within 5 minutes', completed_at = now()
      WHERE id = $1 AND status = 'pending' AND created_at < now() - interval '5 minutes'`,
    [runId],
  );
  const row = (await db.query<ToolRunState>(`SELECT status, output, error, duration_ms, completed_at FROM toolbox_runs WHERE id = $1`, [runId])).rows[0];
  return row ?? null;
}
