import { Router } from 'express';
import { z } from 'zod';
import type { CheckRole, CheckState, DeviceType, SummaryReport } from '@lan-detective/shared-types';
import { auth, notFound, parse } from '../../common/http.ts';
import { systemPool, withTenant } from '../../infrastructure/db.ts';
import { SCOPES, type ScopeRow, loadFacts, summarize } from '../ipam/facts.ts';

export const reportsRouter: Router = Router();

const querySchema = z.object({
  site_id: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
});

const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100;

reportsRouter.get('/reports/summary', async (req, res) => {
  const ctx = auth(req);
  const { site_id, days } = parse(querySchema, req.query);
  const siteId = site_id ?? null;

  const orgRes = await systemPool.query<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE id = $1`,
    [ctx.organizationId],
  );
  const organization = orgRes.rows[0] ?? { id: ctx.organizationId, name: 'Organization' };

  const now = new Date();
  const fromDate = new Date(now.getTime() - days * 86_400_000);

  const report = await withTenant(ctx.organizationId, async (db): Promise<SummaryReport> => {
    const sitesRes = await db.query<{ id: string; name: string; timezone: string }>(
      `SELECT id, name, timezone FROM sites ORDER BY name`,
    );
    let selectedSite: { id: string; name: string; timezone: string } | null = null;
    if (siteId) {
      selectedSite = sitesRes.rows.find((s) => s.id === siteId) ?? null;
      if (!selectedSite) throw notFound('Site');
    }

    const devCounts = await db.query<{
      total: number;
      online: number;
      offline: number;
      unknown: number;
      critical: number;
      critical_offline: number;
      new_in_window: number;
      known: number;
      unreviewed: number;
      unwanted: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'online')::int AS online,
              count(*) FILTER (WHERE status = 'offline')::int AS offline,
              count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
              count(*) FILTER (WHERE is_critical)::int AS critical,
              count(*) FILTER (WHERE is_critical AND status = 'offline')::int AS critical_offline,
              count(*) FILTER (WHERE first_seen_at >= $2)::int AS new_in_window,
              count(*) FILTER (WHERE trust = 'known')::int AS known,
              count(*) FILTER (WHERE trust = 'unreviewed')::int AS unreviewed,
              count(*) FILTER (WHERE trust = 'unwanted')::int AS unwanted
         FROM devices
        WHERE ($1::uuid IS NULL OR site_id = $1)`,
      [siteId, fromDate],
    );
    const devByType = await db.query<{ device_type: DeviceType; count: number }>(
      `SELECT device_type, count(*)::int AS count
         FROM devices
        WHERE ($1::uuid IS NULL OR site_id = $1)
        GROUP BY device_type
        ORDER BY count DESC, device_type`,
      [siteId],
    );
    const collectorsRes = await db.query<{ total: number; online: number; offline: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE connection_state = 'online')::int AS online,
              count(*) FILTER (WHERE connection_state = 'offline')::int AS offline
         FROM collectors
        WHERE status = 'active' AND ($1::uuid IS NULL OR site_id = $1)`,
      [siteId],
    );
    const checksRes = await db.query<{ role: CheckRole; state: CheckState }>(
      `SELECT role, state
         FROM monitoring_checks
        WHERE enabled AND ($1::uuid IS NULL OR site_id = $1)`,
      [siteId],
    );
    const checkWindowRes = await db.query<{
      role: CheckRole | null;
      samples: number;
      ok_ratio: string | null;
      avg_latency: string | null;
      avg_loss: string | null;
    }>(
      `SELECT GROUPING(c.role) AS grp, c.role,
              count(*)::int AS samples,
              avg(r.ok::int) AS ok_ratio,
              avg(r.latency_ms) FILTER (WHERE r.ok) AS avg_latency,
              avg(r.loss_pct) AS avg_loss
         FROM check_results r
         JOIN monitoring_checks c ON c.id = r.check_id
        WHERE r.ts >= $2 AND c.enabled AND ($1::uuid IS NULL OR c.site_id = $1)
        GROUP BY GROUPING SETS ((c.role), ())`,
      [siteId, fromDate],
    );
    const incidentsRes = await db.query<{
      total: number;
      total_in_window: number;
      active: number;
      resolved: number;
      resolved_in_window: number;
      mttr_minutes: string | null;
      critical: number;
      warning: number;
      info: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE opened_at >= $2)::int AS total_in_window,
              count(*) FILTER (WHERE status <> 'resolved')::int AS active,
              count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE status = 'resolved' AND resolved_at >= $2)::int AS resolved_in_window,
              avg(extract(epoch FROM (resolved_at - opened_at)) / 60.0)
                FILTER (WHERE status = 'resolved' AND resolved_at IS NOT NULL AND (opened_at >= $2 OR resolved_at >= $2)) AS mttr_minutes,
              count(*) FILTER (WHERE severity = 'critical' AND (opened_at >= $2 OR status <> 'resolved'))::int AS critical,
              count(*) FILTER (WHERE severity = 'warning' AND (opened_at >= $2 OR status <> 'resolved'))::int AS warning,
              count(*) FILTER (WHERE severity = 'info' AND (opened_at >= $2 OR status <> 'resolved'))::int AS info
         FROM incidents
        WHERE ($1::uuid IS NULL OR site_id = $1)`,
      [siteId, fromDate],
    );
    const endpointsRes = await db.query<{
      total: number;
      online: number;
      offline: number;
      compliant: number;
      non_compliant: number;
      attention: number;
      unknown: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE connection_state = 'online')::int AS online,
              count(*) FILTER (WHERE connection_state = 'offline')::int AS offline,
              count(*) FILTER (WHERE compliance_status = 'compliant')::int AS compliant,
              count(*) FILTER (WHERE compliance_status = 'non_compliant')::int AS non_compliant,
              count(*) FILTER (WHERE compliance_status = 'attention')::int AS attention,
              count(*) FILTER (WHERE compliance_status = 'unknown' OR compliance_status IS NULL)::int AS unknown
         FROM endpoints
        WHERE status <> 'revoked' AND ($1::uuid IS NULL OR site_id = $1)`,
      [siteId],
    );
    const scopesRes = await db.query<ScopeRow>(`${SCOPES} WHERE ($1::uuid IS NULL OR s.site_id = $1) ORDER BY s.cidr`, [siteId]);
    const switchesRes = await db.query<{
      total: number;
      ok: number;
      error: number;
      ports_total: number;
      ports_up: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE t.last_status = 'ok')::int AS ok,
              count(*) FILTER (WHERE t.last_status IS NOT NULL AND t.last_status <> 'ok')::int AS error,
              coalesce((
                SELECT count(*)::int FROM switch_ports p
                  JOIN snmp_targets st ON st.id = p.target_id
                 WHERE ($1::uuid IS NULL OR st.site_id = $1)
              ), 0) AS ports_total,
              coalesce((
                SELECT count(*)::int FROM switch_ports p
                  JOIN snmp_targets st ON st.id = p.target_id
                 WHERE p.oper_up AND ($1::uuid IS NULL OR st.site_id = $1)
              ), 0) AS ports_up
         FROM snmp_targets t
        WHERE ($1::uuid IS NULL OR t.site_id = $1)`,
      [siteId],
    );
    const routersRes = await db.query<{
      total: number;
      ok: number;
      active_blocks: number;
      clients: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE r.status = 'ok')::int AS ok,
              coalesce((
                SELECT count(*)::int FROM router_blocks b
                 WHERE b.released_at IS NULL AND ($1::uuid IS NULL OR b.site_id = $1)
              ), 0) AS active_blocks,
              coalesce((
                SELECT count(*)::int FROM router_clients c
                 WHERE ($1::uuid IS NULL OR c.site_id = $1)
              ), 0) AS clients
         FROM site_routers r
        WHERE ($1::uuid IS NULL OR r.site_id = $1)`,
      [siteId],
    );

    // IPAM summary across matching scopes
    const scopeSiteIds = [...new Set(scopesRes.rows.map((s) => s.site_id))];
    const facts = scopeSiteIds.length > 0 ? await loadFacts(db, scopeSiteIds) : { devices: [], records: [], collectors: [] };
    let usableAddresses = 0;
    let onlineAddresses = 0;
    let documentedAddresses = 0;
    let conflicts = 0;
    for (const sc of scopesRes.rows) {
      const s = summarize(sc, facts);
      usableAddresses += s.usable;
      onlineAddresses += s.online;
      documentedAddresses += s.documented_only;
      conflicts += s.conflicts;
    }
    const usedAddresses = onlineAddresses + documentedAddresses;
    const utilizationPct = usableAddresses > 0 ? Math.round((usedAddresses / usableAddresses) * 1000) / 10 : null;

    const overallCheckWin = checkWindowRes.rows.find((r) => r.role === null);
    const roles: CheckRole[] = ['gateway', 'internet', 'dns', 'service'];
    const byRole = roles
      .map((role) => {
        const matching = checksRes.rows.filter((c) => c.role === role);
        const win = checkWindowRes.rows.find((r) => r.role === role);
        const okRatio = num(win?.ok_ratio ?? null);
        return {
          role,
          total: matching.length,
          ok: matching.filter((c) => c.state === 'ok').length,
          degraded: matching.filter((c) => c.state === 'degraded').length,
          down: matching.filter((c) => c.state === 'down').length,
          samples: win?.samples ?? 0,
          availability_pct: okRatio === null ? null : Math.round(okRatio * 10000) / 100,
          avg_latency_ms: num(win?.avg_latency ?? null),
          avg_loss_pct: num(win?.avg_loss ?? null),
        };
      })
      .filter((r) => r.total > 0 || r.samples > 0);

    const overallRatio = num(overallCheckWin?.ok_ratio ?? null);
    const d = devCounts.rows[0]!;
    const col = collectorsRes.rows[0]!;
    const inc = incidentsRes.rows[0]!;
    const ep = endpointsRes.rows[0]!;
    const sw = switchesRes.rows[0]!;
    const rt = routersRes.rows[0]!;

    const fromIso = fromDate.toISOString();
    const toIso = now.toISOString();

    return {
      generated_at: toIso,
      days,
      from: fromIso,
      to: toIso,
      period: { days, from: fromIso, to: toIso },
      organization,
      site: selectedSite,
      sites_count: siteId ? 1 : sitesRes.rows.length,
      devices: {
        total: d.total,
        online: d.online,
        offline: d.offline,
        unknown: d.unknown,
        critical: d.critical,
        critical_offline: d.critical_offline,
        new_in_window: d.new_in_window,
        by_trust: {
          known: d.known,
          unreviewed: d.unreviewed,
          unwanted: d.unwanted,
        },
        by_type: devByType.rows,
      },
      collectors: col,
      checks: {
        total: checksRes.rows.length,
        ok: checksRes.rows.filter((c) => c.state === 'ok').length,
        degraded: checksRes.rows.filter((c) => c.state === 'degraded').length,
        down: checksRes.rows.filter((c) => c.state === 'down').length,
        unknown: checksRes.rows.filter((c) => c.state === 'unknown').length,
        availability_pct: overallRatio === null ? null : Math.round(overallRatio * 10000) / 100,
        avg_latency_ms: num(overallCheckWin?.avg_latency ?? null),
        avg_loss_pct: num(overallCheckWin?.avg_loss ?? null),
        by_role: byRole,
      },
      incidents: {
        total: inc.total,
        total_in_window: inc.total_in_window,
        active: inc.active,
        resolved: inc.resolved,
        resolved_in_window: inc.resolved_in_window,
        mttr_minutes: num(inc.mttr_minutes),
        by_severity: {
          critical: inc.critical,
          warning: inc.warning,
          info: inc.info,
        },
      },
      endpoints: {
        total: ep.total,
        online: ep.online,
        offline: ep.offline,
        compliant: ep.compliant,
        non_compliant: ep.non_compliant,
        attention: ep.attention,
        unknown: ep.unknown,
        by_compliance: {
          compliant: ep.compliant,
          non_compliant: ep.non_compliant,
          attention: ep.attention,
          unknown: ep.unknown,
        },
      },
      ipam: {
        subnets: scopesRes.rows.length,
        usable_addresses: usableAddresses,
        online_addresses: onlineAddresses,
        documented_addresses: documentedAddresses,
        utilization_pct: utilizationPct,
        conflicts,
      },
      switches: sw,
      routers: rt,
    };
  });

  res.json(report);
});
