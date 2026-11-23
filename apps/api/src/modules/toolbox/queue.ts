import type { ToolKind } from '@nigafiy/shared-types';
import { env } from '../../config/env.ts';
import { AppError, notFound } from '../../common/http.ts';
import { classifyTarget, isIP } from '../../common/net.ts';
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
  const ip = isIP(target);
  const hostOk = ip || (target.length <= 253 && HOSTNAME.test(target));
  if (!hostOk) throw new AppError(400, 'invalid_target', 'Target must be an IPv4 or IPv6 address or a valid hostname');
  if (tool === 'dns' && ip) throw new AppError(400, 'invalid_target', 'A DNS lookup needs a hostname; use reverse DNS for an address');
  if (tool === 'rdns' && !ip) throw new AppError(400, 'invalid_target', 'Reverse DNS needs an IPv4 or IPv6 address');
  if (tool === 'tcp' && port === null) throw new AppError(400, 'invalid_target', 'A TCP port check needs a port between 1 and 65535');
  if (tool !== 'tcp' && port !== null) throw new AppError(400, 'invalid_target', 'Only a TCP port check takes a port');
}

/** Tools that open TCP connections to many or chosen ports: authorized private scopes only. */
const SCOPE_ONLY_TOOLS: readonly ToolKind[] = ['tcp', 'ports'];

/**
 * Scope rule of the toolbox (same rule in the collector, internal/tools/scope.go):
 *  - an address of the local kind (RFC 1918 private, loopback, IPv4 link-local, CGNAT 100.64/10, IPv6
 *    unique-local fc00::/7) must lie inside one of the site's enabled authorized network_scopes, for every tool;
 *  - a global IPv6 address inside a scope is a LAN address (every tool); outside every scope it is public;
 *  - TCP port check and service port scan only ever target such in-scope addresses — never a public
 *    address, and never a host name (the API cannot know what it resolves to; the collector checks
 *    again after resolving);
 *  - ping, traceroute and reverse DNS may target a public address (internet reachability diagnostics:
 *    a few ICMP/UDP probes, no port scanning); DNS lookups of a name are always allowed (a query to the
 *    collector's resolver, nothing is sent to the name);
 *  - unspecified, broadcast, multicast and reserved addresses are refused, and so is IPv6 link-local
 *    (fe80::/10 needs an interface to mean anything): see classifyTarget in common/net.ts.
 */
export async function assertToolScope(db: Db, siteId: string, tool: ToolKind, target: string): Promise<void> {
  if (tool === 'dns') return;
  if (!isIP(target)) {
    if (SCOPE_ONLY_TOOLS.includes(tool)) {
      throw new AppError(422, 'out_of_scope', 'Port checks need an address inside an authorized network scope of the site, not a host name');
    }
    return; // the collector resolves the name and applies the same rule to the address
  }
  const cls = classifyTarget(target);
  if (cls.kind === 'refused') throw new AppError(422, 'out_of_scope', `This address cannot be a toolbox target (${cls.reason})`);
  if (cls.kind === 'loopback' && !env.ALLOW_LOOPBACK_SCOPES) {
    throw new AppError(422, 'out_of_scope', 'Loopback addresses are not toolbox targets');
  }
  const inScope = (await db.query(`SELECT 1 FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr LIMIT 1`, [siteId, target])).rowCount! > 0;
  if (inScope) return;
  if (cls.kind === 'global') {
    // A public IPv4 address, or a global IPv6 address outside every scope of the site.
    if (SCOPE_ONLY_TOOLS.includes(tool)) {
      throw new AppError(422, 'out_of_scope', 'Port checks are only allowed for addresses inside an authorized network scope of the site; public addresses are refused');
    }
    return;
  }
  throw new AppError(422, 'out_of_scope', 'This address is not inside an authorized network scope of the site');
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
  await assertToolScope(db, run.siteId, run.tool, run.target);
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
