import type { Db } from '../../infrastructure/db.ts';

/** `auto:gateway` is resolved by the collector to the default gateway of the host it runs on. */
export const AUTO_GATEWAY = 'auto:gateway';

interface StarterCheck {
  name: string;
  kind: 'icmp' | 'dns';
  role: 'gateway' | 'internet' | 'dns';
  target: string;
  interval_seconds: number;
  latency_warn_ms: number;
  loss_warn_pct: number | null;
}

/** The starter checks, in creation order. */
export const STARTER_CHECKS: readonly StarterCheck[] = [
  { name: 'Default gateway', kind: 'icmp', role: 'gateway', target: AUTO_GATEWAY, interval_seconds: 30, latency_warn_ms: 50, loss_warn_pct: 5 },
  { name: 'Internet — 1.1.1.1 (Cloudflare)', kind: 'icmp', role: 'internet', target: '1.1.1.1', interval_seconds: 30, latency_warn_ms: 150, loss_warn_pct: 5 },
  { name: 'Internet — 8.8.8.8 (Google)', kind: 'icmp', role: 'internet', target: '8.8.8.8', interval_seconds: 30, latency_warn_ms: 150, loss_warn_pct: 5 },
  { name: 'DNS resolution (system resolver)', kind: 'dns', role: 'dns', target: 'example.com', interval_seconds: 60, latency_warn_ms: 300, loss_warn_pct: null },
];

async function insertStarter(db: Db, organizationId: string, siteId: string, checks: readonly StarterCheck[]): Promise<void> {
  if (!checks.length) return;
  await db.query(
    `INSERT INTO monitoring_checks (organization_id, site_id, name, kind, role, target, interval_seconds, latency_warn_ms, loss_warn_pct)
     SELECT $1, $2, x.name, x.kind, x.role, x.target, x.interval_seconds, x.latency_warn_ms, x.loss_warn_pct
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::float8[], $9::float8[]) WITH ORDINALITY
            AS x(name, kind, role, target, interval_seconds, latency_warn_ms, loss_warn_pct, n)
      ORDER BY x.n`,
    [
      organizationId,
      siteId,
      checks.map((c) => c.name),
      checks.map((c) => c.kind),
      checks.map((c) => c.role),
      checks.map((c) => c.target),
      checks.map((c) => c.interval_seconds),
      checks.map((c) => c.latency_warn_ms),
      checks.map((c) => c.loss_warn_pct),
    ],
  );
}

/**
 * Starter checks for a new site so "is it the LAN, DNS or the ISP?" has data from minute one.
 * They are ordinary checks: an administrator can edit or delete every one of them.
 */
export async function createDefaultChecks(db: Db, organizationId: string, siteId: string): Promise<void> {
  await insertStarter(db, organizationId, siteId, STARTER_CHECKS);
}

/**
 * Re-create the starter checks the site no longer has; idempotent. A starter check counts as present
 * when the site has a check of the same kind, role and target (whatever it was renamed to or
 * however it was tuned), so an edited starter check is never duplicated or reset.
 */
export async function restoreDefaultChecks(db: Db, organizationId: string, siteId: string): Promise<{ created: string[]; existing: string[] }> {
  const present = (
    await db.query<{ kind: string; role: string; target: string }>(`SELECT kind, role, target FROM monitoring_checks WHERE site_id = $1 AND organization_id = $2`, [siteId, organizationId])
  ).rows;
  const has = (c: StarterCheck) => present.some((p) => p.kind === c.kind && p.role === c.role && p.target.toLowerCase() === c.target.toLowerCase());
  const missing = STARTER_CHECKS.filter((c) => !has(c));
  await insertStarter(db, organizationId, siteId, missing);
  return { created: missing.map((c) => c.name), existing: STARTER_CHECKS.filter(has).map((c) => c.name) };
}
