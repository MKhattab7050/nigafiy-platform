import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { isPublicAddress, validateScope } from '../src/common/net.ts';
import { appPool, closePools, systemPool, withTenant } from '../src/infrastructure/db.ts';
import { CSRF, addScope, app, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

afterAll(closePools);

describe('authentication', () => {
  it('registers, reports the session, logs out', async () => {
    const a = await newAccount('auth');
    const me = await a.agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('owner');
    expect(me.body.user.email).toBe(a.email);
    expect((await a.agent.post('/api/v1/auth/logout').set(CSRF)).status).toBe(200);
    expect((await a.agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('never stores the password and sets an HttpOnly cookie', async () => {
    const a = await newAccount('pw');
    const row = await systemPool.query(`SELECT password_hash FROM users WHERE lower(email) = $1`, [a.email]);
    expect(row.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(row.rows[0].password_hash).not.toContain('correct horse');
    const login = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'correct horse battery' });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/ld_session=.+HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // Only a hash of the session token is stored.
    const token = /ld_session=([^;]+)/.exec(cookie)![1]!;
    expect((await systemPool.query(`SELECT 1 FROM sessions WHERE token_hash = $1`, [token])).rowCount).toBe(0);
  });

  it('rejects wrong passwords and unknown users with the same generic error', async () => {
    const a = await newAccount('wrong');
    const bad = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'not the password' });
    const ghost = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email: 'ghost@example.test', password: 'whatever it is' });
    expect(bad.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(bad.body.error.message).toBe(ghost.body.error.message);
  });

  it('validates registration input', async () => {
    const res = await request(app).post('/api/v1/auth/register').set(CSRF).send({ email: 'nope', password: 'short', display_name: '', organization_name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('blocks state-changing requests without the CSRF header or from a foreign origin', async () => {
    const a = await newAccount('csrf');
    expect((await a.agent.post('/api/v1/sites').send({ name: 'x' })).status).toBe(403);
    expect((await a.agent.post('/api/v1/sites').set(CSRF).set('Origin', 'https://evil.example').send({ name: 'x' })).status).toBe(403);
    expect((await a.agent.post('/api/v1/sites').set(CSRF).set('Origin', 'http://localhost:3100').send({ name: 'Branch' })).status).toBe(201);
  });

  it('requires a session for every data endpoint', async () => {
    for (const path of ['/overview', '/devices', '/sites', '/collectors', '/checks', '/events', '/scopes', '/notification-channels', '/audit-logs', '/stream']) {
      expect((await request(app).get(`/api/v1${path}`)).status, path).toBe(401);
    }
  });
});

describe('role based access control', () => {
  it('enforces roles on the server', async () => {
    const a = await newAccount('rbac');
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get('/api/v1/devices')).status).toBe(200);
    expect((await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Nope' })).status).toBe(403);
    expect((await a.agent.post('/api/v1/collectors').set(CSRF).send({ site_id: a.siteId, name: 'c' })).status).toBe(403);
    expect((await a.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: '192.168.50.0/24', authorization_confirmed: true })).status).toBe(403);
    expect((await a.agent.get('/api/v1/audit-logs')).status).toBe(403);
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Nope' })).status).toBe(403);
  });
});

describe('network scope authorization', () => {
  it('accepts only private ranges of bounded size', () => {
    expect(validateScope('192.168.1.7/24')).toEqual({ ok: true, cidr: '192.168.1.0/24' });
    expect(validateScope('10.20.0.0/20').ok).toBe(true);
    expect(validateScope('8.8.8.0/24').ok).toBe(false); // public
    expect(validateScope('10.0.0.0/8').ok).toBe(false); // too large
    expect(validateScope('127.0.0.0/24').ok).toBe(false); // loopback only in dev/test mode
    expect(validateScope('fd00::/64').ok).toBe(false);
    expect(validateScope('not-a-cidr').ok).toBe(false);
  });

  it('requires explicit confirmation and rejects overlaps', async () => {
    const a = await newAccount('scope');
    const noConfirm = await a.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: '192.168.1.0/24' });
    expect(noConfirm.status).toBe(400);
    const publicRange = await a.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: '1.1.1.0/24', authorization_confirmed: true });
    expect(publicRange.status).toBe(400);
    await addScope(a, '192.168.1.0/24');
    const overlap = await a.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: '192.168.1.128/25', authorization_confirmed: true });
    expect(overlap.status).toBe(409);
    const audit = await a.agent.get('/api/v1/audit-logs');
    expect(audit.body.items.some((e: { action: string }) => e.action === 'scope.authorized')).toBe(true);
  });

  it('recognises non-public webhook destinations', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd00::1']) expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress('93.184.216.34')).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('keeps two organizations completely apart through the API', async () => {
    const a = await newAccount('tenant-a');
    const b = await newAccount('tenant-b');
    const scopeA = await addScope(a, '192.168.10.0/24');
    const collectorA = await newCollector(a);
    await heartbeat(collectorA);
    await telemetry(collectorA, [sweep(scopeA, [{ ip: '192.168.10.5', mac: 'aa:bb:cc:00:00:05', hostname: 'a-secret-host' }])]);

    const devicesA = await a.agent.get('/api/v1/devices');
    expect(devicesA.body.total).toBe(1);
    const deviceId = devicesA.body.items[0].id;
    const checkA = (await a.agent.get('/api/v1/checks')).body.items[0].id;

    // B sees none of it …
    expect((await b.agent.get('/api/v1/devices')).body.total).toBe(0);
    expect((await b.agent.get('/api/v1/collectors')).body.items).toHaveLength(0);
    expect((await b.agent.get('/api/v1/scopes')).body.items).toHaveLength(0);
    expect((await b.agent.get('/api/v1/events')).body.items.every((e: { site_id: string }) => e.site_id !== a.siteId)).toBe(true);
    expect((await b.agent.get(`/api/v1/devices?site_id=${a.siteId}`)).body.total).toBe(0);
    expect((await b.agent.get('/api/v1/overview')).body.devices.total).toBe(0);
    // … and cannot reach A's objects by id (404, not 403: existence is not revealed).
    expect((await b.agent.get(`/api/v1/devices/${deviceId}`)).status).toBe(404);
    expect((await b.agent.patch(`/api/v1/devices/${deviceId}`).set(CSRF).send({ notes: 'pwned' })).status).toBe(404);
    expect((await b.agent.get(`/api/v1/checks/${checkA}/series`)).status).toBe(404);
    expect((await b.agent.delete(`/api/v1/checks/${checkA}`).set(CSRF)).status).toBe(404);
    expect((await b.agent.delete(`/api/v1/scopes/${scopeA}`).set(CSRF)).status).toBe(404);
    expect((await b.agent.post('/api/v1/collectors').set(CSRF).send({ site_id: a.siteId, name: 'intruder' })).status).toBe(404);
    expect((await b.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: '192.168.99.0/24', authorization_confirmed: true })).status).toBe(404);
    expect((await b.agent.post(`/api/v1/collectors/${collectorA.id}/revoke`).set(CSRF)).status).toBe(404);
    expect((await b.agent.post(`/api/v1/collectors/${collectorA.id}/scan`).set(CSRF)).status).toBe(404);
    expect((await b.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: a.organizationId })).status).toBe(403);
    // A's data is intact.
    expect((await a.agent.get(`/api/v1/devices/${deviceId}`)).body.notes).toBeNull();
  });

  it("a collector cannot write into another tenant's site, whatever ids it sends", async () => {
    const a = await newAccount('ingest-a');
    const b = await newAccount('ingest-b');
    const scopeA = await addScope(a, '192.168.20.0/24');
    await addScope(b, '192.168.20.0/24');
    const collectorB = await newCollector(b);
    const checkA = (await a.agent.get('/api/v1/checks')).body.items[0].id;

    const res = await telemetry(collectorB, [
      sweep(scopeA, [{ ip: '192.168.20.9', mac: 'aa:bb:cc:00:00:09' }]),
      { type: 'check_result', check_id: checkA, ts: new Date().toISOString(), ok: false },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(0);
    expect(res.body.rejected).toHaveLength(2);
    expect((await a.agent.get('/api/v1/devices')).body.total).toBe(0);
    expect((await b.agent.get('/api/v1/devices')).body.total).toBe(0);
    expect((await a.agent.get('/api/v1/checks')).body.items[0].state).toBe('unknown');
  });

  it('is enforced by PostgreSQL Row Level Security, not only by application code', async () => {
    const a = await newAccount('rls-a');
    const b = await newAccount('rls-b');
    const scopeA = await addScope(a, '192.168.30.0/24');
    const collectorA = await newCollector(a);
    await telemetry(collectorA, [sweep(scopeA, [{ ip: '192.168.30.5', mac: 'aa:bb:cc:00:30:05' }])]);

    // No tenant set → the app role sees nothing at all.
    for (const table of ['devices', 'sites', 'collectors', 'network_events', 'monitoring_checks', 'network_scopes', 'audit_logs', 'organizations']) {
      expect((await appPool.query(`SELECT 1 FROM ${table}`)).rowCount, table).toBe(0);
    }
    // Tenant B's transaction cannot read, modify or forge rows of tenant A — even with a deliberately unfiltered query.
    await withTenant(b.organizationId, async (db) => {
      expect((await db.query(`SELECT 1 FROM devices`)).rowCount).toBe(0);
      expect((await db.query(`SELECT 1 FROM sites WHERE id = $1`, [a.siteId])).rowCount).toBe(0);
      expect((await db.query(`UPDATE devices SET notes = 'pwned'`)).rowCount).toBe(0);
      expect((await db.query(`DELETE FROM network_events`)).rowCount).toBe(0);
    });
    await expect(
      withTenant(b.organizationId, (db) => db.query(`INSERT INTO sites (organization_id, name) VALUES ($1, 'forged')`, [a.organizationId])),
    ).rejects.toThrow(/row-level security/);
    // A site of tenant B cannot be attached to tenant A's organization id either (composite foreign key).
    await expect(
      systemPool.query(`INSERT INTO network_scopes (organization_id, site_id, cidr) VALUES ($1, $2, '10.9.9.0/24')`, [a.organizationId, b.siteId]),
    ).rejects.toThrow(/foreign key/);
    // The app role has no access to identity tables and cannot rewrite the audit trail.
    await expect(appPool.query(`SELECT * FROM users`)).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`SELECT * FROM sessions`)).rejects.toThrow(/permission denied/);
    await expect(withTenant(a.organizationId, (db) => db.query(`DELETE FROM audit_logs`))).rejects.toThrow(/permission denied/);
    // The tenant setting does not leak to the next user of a pooled connection.
    expect((await appPool.query(`SELECT current_setting('app.current_org', true) AS v`)).rows[0].v ?? '').toBe('');
    await withTenant(a.organizationId, async (db) => expect((await db.query(`SELECT 1 FROM devices`)).rowCount).toBe(1));
  });
});
