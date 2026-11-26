import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/common/crypto.ts';
import { isOwnOrigin } from '../src/config/env.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { phoneDashboardProxy } from '../src/modules/auth/phone-dashboard.ts';
import { CSRF, app, newAccount } from './helpers.ts';

// Admin phones open the dashboard over the API's HTTPS listener (docs/roadmap/2026-11-26-admin-phones.md).

let web: http.Server;
let webOrigin = '';
beforeAll(async () => {
  web = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-from': 'web' });
    res.end(`page ${req.url} host=${req.headers.host}`);
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  webOrigin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => web.close(() => r())));

/** The proxy as mounted in app.ts, on a socket that says it is TLS (the HTTPS listener) or not. */
function listener(tls: boolean) {
  const a = express();
  a.use((req, _res, next) => {
    (req.socket as { encrypted?: boolean }).encrypted = tls;
    next();
  });
  a.use(phoneDashboardProxy(webOrigin));
  a.use((_req, res) => void res.status(404).json({ error: 'not_found' }));
  return a;
}

async function phoneSession(role: 'user' | 'admin') {
  const a = await newAccount(`dash-${role}`);
  const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Phone', platform: 'android', phone_role: role });
  const enrolled = await request(app)
    .post('/api/v1/agent/enroll')
    .send({ enrollment_token: created.body.enrollment_token, agent_version: '1.0.6', hostname: 'Phone', platform: 'android', os: 'android', os_version: 'Android 16 (API 36)', arch: 'arm64-v8a' });
  expect(enrolled.status).toBe(201);
  return { a, epId: created.body.endpoint.id as string, cred: enrolled.body.credential as string };
}

describe('dashboard pages for admin phones', () => {
  it('only a live admin-phone session gets the pages, only over HTTPS; /api stays the API', async () => {
    const { a, cred } = await phoneSession('admin');
    const s = await request(app).post('/api/v1/agent/dashboard-session').set('Authorization', `Bearer ${cred}`).send({});
    const cookie = `ld_session=${s.body.value}`;

    const page = await request(listener(true)).get('/fleet').set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.headers['x-from']).toBe('web');
    expect(page.text).toContain('page /fleet');

    expect((await request(listener(false)).get('/fleet').set('Cookie', cookie)).status).toBe(404);
    expect((await request(listener(true)).get('/fleet')).status).toBe(404);
    expect((await request(listener(true)).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(404);

    // A person's own browser session (not a phone's) gets nothing here.
    const token = `browser-${Math.random().toString(36).slice(2)}`;
    await systemPool.query(
      `INSERT INTO sessions (user_id, token_hash, active_organization_id, expires_at)
       SELECT id, $2, $3, now() + interval '1 hour' FROM users WHERE lower(email) = $1`,
      [a.email, sha256(token), a.organizationId],
    );
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `ld_session=${token}`)).status).toBe(200);
    expect((await request(listener(true)).get('/fleet').set('Cookie', `ld_session=${token}`)).status).toBe(404);
  });

  it('a regular phone has no session to show, and a revoked admin phone stops getting pages', async () => {
    const { a, epId, cred } = await phoneSession('admin');
    const s = await request(app).post('/api/v1/agent/dashboard-session').set('Authorization', `Bearer ${cred}`).send({});
    const proxy = listener(true);
    expect((await request(proxy).get('/').set('Cookie', `ld_session=${s.body.value}`)).status).toBe(200);
    await a.agent.post(`/api/v1/endpoints/${epId}/revoke`).set(CSRF).send({});
    // Answers are remembered for 15 s; a new listener has no memory.
    expect((await request(listener(true)).get('/').set('Cookie', `ld_session=${s.body.value}`)).status).toBe(404);
  });

  it('accepts the page\'s own HTTPS address as the Origin, never another site', () => {
    const tls = { headers: { host: '192.168.1.147:47143' }, socket: { encrypted: true } };
    const plain = { headers: { host: '192.168.1.147:47100' }, socket: {} };
    expect(isOwnOrigin('https://192.168.1.147:47143', tls)).toBe(true);
    expect(isOwnOrigin('https://evil.example', tls)).toBe(false);
    expect(isOwnOrigin('https://192.168.1.147:47143', { ...tls, headers: { host: 'other:1' } })).toBe(false);
    expect(isOwnOrigin('http://192.168.1.147:47100', plain)).toBe(false);
    expect(isOwnOrigin(undefined, tls)).toBe(false);
  });
});
