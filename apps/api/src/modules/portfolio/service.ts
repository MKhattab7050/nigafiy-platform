import type { InsightsReport, MfaRequirement, PortfolioKpis, PortfolioOrganization, PortfolioSite, Role } from '@nigafiy/shared-types';
import { type Db, systemPool, withTenant } from '../../infrastructure/db.ts';
import { buildInsights, loadInsightFacts } from '../insights/index.ts';

/**
 * Portfolio roll-ups. Everything tenant-owned is read through `withTenant` (Row Level Security): the
 * cross-organization view opens one tenant transaction per organization, never a system query over
 * tenant tables. Only the user's own memberships (an identity table) are read with the system pool.
 */

const emptyKpis = (): Omit<PortfolioKpis, 'health'> => ({
  incidents: { critical: 0, warning: 0, info: 0, total: 0 },
  devices: { total: 0, online: 0, offline: 0, unknown: 0, unreviewed: 0 },
  collectors: { total: 0, online: 0, offline: 0, never: 0, last_heartbeat_at: null },
  endpoints: { total: 0, online: 0, compliant: 0, non_compliant: 0, attention: 0, unknown: 0 },
  checks: { total: 0, ok: 0, degraded: 0, down: 0, unknown: 0, last_failure: null },
});

const health = (report: InsightsReport) => ({ score: report.score, verdict: report.verdict });

/** Per-site KPIs of the organization the transaction is bound to. */
export async function siteRollup(db: Db, organizationId: string): Promise<PortfolioSite[]> {
  const sites = (await db.query<{ id: string; name: string; timezone: string }>(`SELECT id, name, timezone FROM sites ORDER BY name`)).rows;
  const out = new Map<string, PortfolioSite>(sites.map((s) => [s.id, { site_id: s.id, name: s.name, timezone: s.timezone, health: null, ...emptyKpis() }]));

  const incidents = await db.query<{ site_id: string | null; severity: 'critical' | 'warning' | 'info'; n: number }>(
    `SELECT site_id, severity, count(*)::int AS n FROM incidents WHERE status <> 'resolved' GROUP BY 1, 2`,
  );
  for (const r of incidents.rows) {
    const s = r.site_id ? out.get(r.site_id) : undefined;
    if (!s) continue;
    s.incidents[r.severity] += r.n;
    s.incidents.total += r.n;
  }

  const devices = await db.query<{ site_id: string; total: number; online: number; offline: number; unknown: number; unreviewed: number }>(
    `SELECT site_id, count(*)::int AS total,
            count(*) FILTER (WHERE status = 'online')::int AS online,
            count(*) FILTER (WHERE status = 'offline')::int AS offline,
            count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
            count(*) FILTER (WHERE trust = 'unreviewed')::int AS unreviewed
       FROM devices GROUP BY site_id`,
  );
  for (const { site_id, ...r } of devices.rows) if (out.has(site_id)) out.get(site_id)!.devices = r;

  const collectors = await db.query<{ site_id: string; total: number; online: number; offline: number; never: number; last_heartbeat_at: Date | null }>(
    `SELECT site_id, count(*)::int AS total,
            count(*) FILTER (WHERE connection_state = 'online')::int AS online,
            count(*) FILTER (WHERE connection_state = 'offline')::int AS offline,
            count(*) FILTER (WHERE connection_state = 'never')::int AS never,
            max(last_heartbeat_at) AS last_heartbeat_at
       FROM collectors WHERE status IN ('pending', 'active') GROUP BY site_id`,
  );
  for (const { site_id, last_heartbeat_at, ...r } of collectors.rows) {
    if (out.has(site_id)) out.get(site_id)!.collectors = { ...r, last_heartbeat_at: last_heartbeat_at?.toISOString() ?? null };
  }

  const endpoints = await db.query<{ site_id: string; total: number; online: number; compliant: number; non_compliant: number; attention: number; unknown: number }>(
    `SELECT site_id, count(*)::int AS total,
            count(*) FILTER (WHERE connection_state = 'online')::int AS online,
            count(*) FILTER (WHERE compliance_status = 'compliant')::int AS compliant,
            count(*) FILTER (WHERE compliance_status = 'non_compliant')::int AS non_compliant,
            count(*) FILTER (WHERE compliance_status = 'attention')::int AS attention,
            count(*) FILTER (WHERE compliance_status = 'unknown')::int AS unknown
       FROM endpoints WHERE status = 'active' GROUP BY site_id`,
  );
  for (const { site_id, ...r } of endpoints.rows) if (out.has(site_id)) out.get(site_id)!.endpoints = r;

  const checks = await db.query<{ site_id: string; total: number; ok: number; degraded: number; down: number; unknown: number }>(
    `SELECT site_id, count(*)::int AS total,
            count(*) FILTER (WHERE state = 'ok')::int AS ok,
            count(*) FILTER (WHERE state = 'degraded')::int AS degraded,
            count(*) FILTER (WHERE state = 'down')::int AS down,
            count(*) FILTER (WHERE state = 'unknown')::int AS unknown
       FROM monitoring_checks WHERE enabled GROUP BY site_id`,
  );
  for (const { site_id, ...r } of checks.rows) if (out.has(site_id)) out.get(site_id)!.checks = { ...r, last_failure: null };
  // The most recent check that is failing now (down or degraded), per site.
  const failing = await db.query<{ site_id: string; id: string; name: string; at: Date }>(
    `SELECT DISTINCT ON (site_id) site_id, id, name, coalesce(state_changed_at, last_result_at, created_at) AS at
       FROM monitoring_checks WHERE enabled AND state IN ('down', 'degraded')
      ORDER BY site_id, coalesce(state_changed_at, last_result_at, created_at) DESC`,
  );
  for (const r of failing.rows) {
    const s = out.get(r.site_id);
    if (s) s.checks.last_failure = { check_id: r.id, name: r.name, at: r.at.toISOString() };
  }

  // Health score: the same deterministic rules as GET /insights?site_id=…
  for (const s of out.values()) s.health = health(buildInsights(await loadInsightFacts(db, organizationId, s.site_id)));
  return [...out.values()];
}

/** Organization-wide KPIs: per-site counts summed, health from the organization-wide insight rules. */
export async function organizationKpis(db: Db, organizationId: string): Promise<PortfolioKpis & { sites: number }> {
  const sites = await siteRollup(db, organizationId);
  const k = emptyKpis();
  const sum = <T extends Record<string, unknown>>(into: T, from: T) => {
    for (const key of Object.keys(into) as (keyof T)[]) if (typeof into[key] === 'number') (into[key] as number) += from[key] as number;
  };
  for (const s of sites) {
    sum(k.incidents, s.incidents);
    sum(k.devices, s.devices);
    sum(k.collectors, s.collectors);
    sum(k.endpoints, s.endpoints);
    sum(k.checks, s.checks);
    if (s.collectors.last_heartbeat_at && (!k.collectors.last_heartbeat_at || s.collectors.last_heartbeat_at > k.collectors.last_heartbeat_at)) k.collectors.last_heartbeat_at = s.collectors.last_heartbeat_at;
    if (s.checks.last_failure && (!k.checks.last_failure || s.checks.last_failure.at > k.checks.last_failure.at)) k.checks.last_failure = s.checks.last_failure;
  }
  // Incidents not tied to a site still count for the organization.
  const orphan = await db.query<{ severity: 'critical' | 'warning' | 'info'; n: number }>(
    `SELECT severity, count(*)::int AS n FROM incidents WHERE status <> 'resolved' AND site_id IS NULL GROUP BY 1`,
  );
  for (const r of orphan.rows) {
    k.incidents[r.severity] += r.n;
    k.incidents.total += r.n;
  }
  const report = buildInsights(await loadInsightFacts(db, organizationId, null));
  return { ...k, health: health(report), sites: sites.length };
}

/** One entry per organization where the user has an ACTIVE membership; each read in its own tenant context. */
export async function organizationRollup(userId: string, currentOrganizationId: string): Promise<PortfolioOrganization[]> {
  const memberships = await systemPool.query<{ organization_id: string; name: string; kind: string; role: Role; mfa_required: MfaRequirement; has_mfa: boolean }>(
    `SELECT m.organization_id, o.name, o.kind, m.role, o.mfa_required, (u.mfa_secret_enc IS NOT NULL) AS has_mfa
       FROM memberships m JOIN organizations o ON o.id = m.organization_id JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY o.name`,
    [userId],
  );
  const out: PortfolioOrganization[] = [];
  for (const m of memberships.rows) {
    const base = { organization_id: m.organization_id, name: m.name, kind: m.kind, role: m.role, current: m.organization_id === currentOrganizationId };
    // Same rule as switching organization: an organization that requires MFA for this role stays closed without it.
    const demandsMfa = m.mfa_required === 'all' || (m.mfa_required === 'admins' && (m.role === 'owner' || m.role === 'admin'));
    if (demandsMfa && !m.has_mfa) {
      out.push({ ...base, locked: 'mfa_required', sites: 0, health: null, ...emptyKpis() });
      continue;
    }
    const kpis = await withTenant(m.organization_id, (db) => organizationKpis(db, m.organization_id));
    out.push({ ...base, locked: null, ...kpis });
  }
  return out;
}
