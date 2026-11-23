import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PortfolioOrganization, PortfolioSite } from '@nigafiy/shared-types';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, type TestAccount, app, newAccount } from './helpers.ts';

/**
 * Portfolio roll-ups: per-site KPIs of the current organization and per-organization KPIs over the
 * user's active memberships, each read under its own tenant (Row Level Security).
 */

const q = (sql: string, params: unknown[]) => systemPool.query(sql, params);

async function seedSite(a: TestAccount, siteId: string, tag: string) {
  const org = a.organizationId;
  // Devices: 2 online (1 reviewed), 1 offline, 1 unknown.
  for (const [i, status, trust] of [
    [1, 'online', 'known'],
    [2, 'online', 'unreviewed'],
    [3, 'offline', 'unreviewed'],
    [4, 'unknown', 'unreviewed'],
  ] as const) {
    await q(
      `INSERT INTO devices (organization_id, site_id, identity_basis, current_ip, status, trust, first_seen_at, last_seen_at) VALUES ($1,$2,'ip',$3,$4,$5,now(),now())`,
      [org, siteId, `10.${tag}.0.${i}`, status, trust],
    );
  }
  // Collectors: online, never connected, and a revoked one that must not count.
  await q(`INSERT INTO collectors (organization_id, site_id, name, status, connection_state, last_heartbeat_at) VALUES ($1,$2,'edge-a','active','online',$3)`, [org, siteId, `2026-11-20T10:0${tag.length}:00Z`]);
  await q(`INSERT INTO collectors (organization_id, site_id, name, status, connection_state) VALUES ($1,$2,'edge-b','pending','never')`, [org, siteId]);
  await q(`INSERT INTO collectors (organization_id, site_id, name, status, connection_state, revoked_at) VALUES ($1,$2,'old','revoked','offline',now())`, [org, siteId]);
  // Managed computers: compliant online, non-compliant offline, a revoked one that must not count.
  await q(`INSERT INTO endpoints (organization_id, site_id, name, status, connection_state, compliance_status) VALUES ($1,$2,'pc-1','active','online','compliant')`, [org, siteId]);
  await q(`INSERT INTO endpoints (organization_id, site_id, name, status, connection_state, compliance_status) VALUES ($1,$2,'pc-2','active','offline','non_compliant')`, [org, siteId]);
  await q(`INSERT INTO endpoints (organization_id, site_id, name, status, connection_state, compliance_status) VALUES ($1,$2,'pc-3','revoked','offline','attention')`, [org, siteId]);
  // Checks: replace the defaults with ok / down / degraded / a disabled one.
  await q(`DELETE FROM monitoring_checks WHERE organization_id = $1 AND site_id = $2`, [org, siteId]);
  await q(`INSERT INTO monitoring_checks (organization_id, site_id, name, kind, target, state) VALUES ($1,$2,'gw','icmp','10.0.0.1','ok')`, [org, siteId]);
  await q(`INSERT INTO monitoring_checks (organization_id, site_id, name, kind, target, state, state_changed_at) VALUES ($1,$2,$3,'icmp','10.0.0.2','down','2026-11-21T08:00:00Z')`, [org, siteId, `nas-${tag}`]);
  await q(`INSERT INTO monitoring_checks (organization_id, site_id, name, kind, target, state, state_changed_at) VALUES ($1,$2,'dns','dns','example.com','degraded','2026-11-20T08:00:00Z')`, [org, siteId]);
  await q(`INSERT INTO monitoring_checks (organization_id, site_id, name, kind, target, state, enabled) VALUES ($1,$2,'off','icmp','10.0.0.3','down',false)`, [org, siteId]);
}

async function incident(a: TestAccount, siteId: string | null, severity: string, status = 'open') {
  await q(
    `INSERT INTO incidents (organization_id, site_id, number, kind, correlation_key, status, severity, title, opened_at, resolved_at)
     VALUES ($1,$2,(SELECT coalesce(max(number),0)+1 FROM incidents WHERE organization_id = $1),'network',$3,$4,$5,'t',now(), CASE WHEN $4 = 'resolved' THEN now() END)`,
    [a.organizationId, siteId, `test:${randomUUID()}`, status, severity],
  );
}

describe('portfolio roll-ups', () => {
  it('per site: devices, collectors, managed computers, checks and open incidents, with the health score', async () => {
    const a = await newAccount('pf-sites');
    const branch = (await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Branch', timezone: 'Europe/Berlin' })).body.id as string;
    await seedSite(a, a.siteId, '1');
    await seedSite(a, branch, '22');
    await incident(a, a.siteId, 'critical');
    await incident(a, a.siteId, 'warning', 'acknowledged');
    await incident(a, a.siteId, 'critical', 'resolved'); // resolved: not counted
    await incident(a, null, 'warning'); // no site: organization total only

    const res = await a.agent.get('/api/v1/portfolio/sites');
    expect(res.status).toBe(200);
    expect(res.body.organization_id).toBe(a.organizationId);
    const items = res.body.items as PortfolioSite[];
    expect(items.map((s) => s.name)).toEqual(['Branch', 'HQ']);
    const hq = items.find((s) => s.site_id === a.siteId)!;
    expect(hq.incidents).toEqual({ critical: 1, warning: 1, info: 0, total: 2 });
    expect(hq.devices).toEqual({ total: 4, online: 2, offline: 1, unknown: 1, unreviewed: 3 });
    expect(hq.collectors).toEqual({ total: 2, online: 1, offline: 0, never: 1, last_heartbeat_at: '2026-11-20T10:01:00.000Z' });
    expect(hq.endpoints).toEqual({ total: 2, online: 1, compliant: 1, non_compliant: 1, attention: 0, unknown: 0 });
    expect(hq.checks).toMatchObject({ total: 3, ok: 1, degraded: 1, down: 1, unknown: 0 });
    expect(hq.checks.last_failure).toMatchObject({ name: 'nas-1', at: '2026-11-21T08:00:00.000Z' });
    // The health score is the same deterministic rule set as the site's Insights page.
    const insights = (await a.agent.get(`/api/v1/insights?site_id=${a.siteId}`)).body;
    expect(hq.health).toEqual({ score: insights.score, verdict: insights.verdict });
    const br = items.find((s) => s.site_id === branch)!;
    expect(br.timezone).toBe('Europe/Berlin');
    expect(br.incidents.total).toBe(0);
    expect(br.collectors.last_heartbeat_at).toBe('2026-11-20T10:02:00.000Z');

    // A viewer reads the same roll-up; nothing without a session.
    const viewerEmail = `pf-viewer-${randomUUID().slice(0, 8)}@example.test`;
    const inv = await a.agent.post('/api/v1/team/invitations').set(CSRF).send({ email: viewerEmail, role: 'viewer' });
    const viewer = request.agent(app);
    await viewer.post(`/api/v1/auth/invitations/${inv.body.token}/accept`).set(CSRF).send({ password: 'correct horse battery' });
    expect(((await viewer.get('/api/v1/portfolio/sites')).body.items as PortfolioSite[]).length).toBe(2);
    expect((await request(app).get('/api/v1/portfolio/sites')).status).toBe(401);

    // Another organization sees none of it.
    const other = await newAccount('pf-sites-other');
    const theirs = (await other.agent.get('/api/v1/portfolio/sites')).body.items as PortfolioSite[];
    expect(theirs.map((s) => s.site_id)).toEqual([other.siteId]);
    expect(theirs[0]!.devices.total).toBe(0);
  });

  it('per organization: sums the sites plus site-less incidents, lists only active memberships, and keeps MFA-locked organizations closed', async () => {
    const a = await newAccount('pf-orgs');
    const branch = (await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Branch', timezone: 'UTC' })).body.id as string;
    await seedSite(a, a.siteId, '3');
    await seedSite(a, branch, '44');
    await incident(a, a.siteId, 'critical');
    await incident(a, null, 'warning');
    await incident(a, null, 'info', 'resolved');

    // The same user is a viewer in an organization that requires MFA for everyone (the user has none),
    // and a deactivated technician in a third organization.
    const locked = await newAccount('pf-locked');
    await seedSite(locked, locked.siteId, '5');
    const inv = await locked.agent.post('/api/v1/team/invitations').set(CSRF).send({ email: a.email, role: 'viewer' });
    expect((await a.agent.post(`/api/v1/auth/invitations/${inv.body.token}/accept`).set(CSRF).send({ password: 'correct horse battery' })).status).toBe(200);
    expect((await locked.agent.patch('/api/v1/team/security').set(CSRF).send({ mfa_required: 'all' })).status).toBe(200);
    const gone = await newAccount('pf-gone');
    const inv2 = await gone.agent.post('/api/v1/team/invitations').set(CSRF).send({ email: a.email, role: 'technician' });
    await a.agent.post(`/api/v1/auth/invitations/${inv2.body.token}/accept`).set(CSRF).send({ password: 'correct horse battery' });
    const uid = (await q(`SELECT id FROM users WHERE lower(email) = $1`, [a.email])).rows[0]!.id as string;
    expect((await gone.agent.patch(`/api/v1/team/members/${uid}`).set(CSRF).send({ status: 'deactivated' })).status).toBe(200);

    const login = request.agent(app);
    expect((await login.post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'correct horse battery' })).status).toBe(200);
    const res = await login.get('/api/v1/portfolio/organizations');
    expect(res.status).toBe(200);
    const items = res.body.items as PortfolioOrganization[];
    expect(items.map((o) => o.organization_id).sort()).toEqual([a.organizationId, locked.organizationId].sort());

    const mine = items.find((o) => o.organization_id === a.organizationId)!;
    expect(mine).toMatchObject({ role: 'owner', current: true, locked: null, sites: 2 });
    expect(mine.devices).toEqual({ total: 8, online: 4, offline: 2, unknown: 2, unreviewed: 6 });
    expect(mine.collectors).toMatchObject({ total: 4, online: 2, never: 2, last_heartbeat_at: '2026-11-20T10:02:00.000Z' });
    expect(mine.endpoints).toEqual({ total: 4, online: 2, compliant: 2, non_compliant: 2, attention: 0, unknown: 0 });
    expect(mine.checks).toMatchObject({ total: 6, ok: 2, degraded: 2, down: 2 });
    expect(mine.incidents).toEqual({ critical: 1, warning: 1, info: 0, total: 2 }); // the site-less warning counts here
    const orgInsights = (await login.get('/api/v1/insights')).body;
    expect(mine.health).toEqual({ score: orgInsights.score, verdict: orgInsights.verdict });

    const closed = items.find((o) => o.organization_id === locked.organizationId)!;
    expect(closed).toMatchObject({ role: 'viewer', current: false, locked: 'mfa_required', sites: 0, health: null });
    expect(closed.devices.total).toBe(0); // no figures leak from an organization this session may not open
  });
});
