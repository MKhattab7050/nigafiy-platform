import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/common/crypto.ts';
import { createApp } from '../src/app.ts';
import { env, isOwnOrigin } from '../src/config/env.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { isHomeAddress, netsFrom, phoneDashboardProxy } from '../src/modules/auth/phone-dashboard.ts';
import { CSRF, app, newAccount } from './helpers.ts';

// Admin phones open the dashboard over the API's HTTPS listener (docs/roadmap/2026-11-26-admin-phones.md).

let web: http.Server;
let webOrigin = '';
beforeAll(async () => {
  web = http.createServer((req, res) => {
    if (req.url === '/moved') {
      res.writeHead(308, { location: `${webOrigin}/fleet/endpoints` });
      return void res.end();
    }
    // /secure: a page with the web app's own security headers (its per-request CSP), as proxy.ts writes them.
    const own = req.url === '/secure' ? { 'content-security-policy': "script-src 'nonce-abc'", 'x-frame-options': 'DENY' } : {};
    res.writeHead(200, { 'content-type': 'text/html', 'x-from': 'web', ...own });
    res.end(`page ${req.url} host=${req.headers.host}`);
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  webOrigin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => web.close(() => r())));

/** The proxy as mounted in app.ts, on a socket that says it is TLS (the HTTPS listener) or not. */
function listener(tls: boolean, home = false) {
  const a = express();
  a.use((req, _res, next) => {
    (req.socket as { encrypted?: boolean }).encrypted = tls;
    next();
  });
  a.use(phoneDashboardProxy(webOrigin, () => home));
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

  it('a browser on another computer at home gets the pages and the login page, over HTTPS only', async () => {
    const page = await request(listener(true, true)).get('/login');
    expect(page.status).toBe(200);
    expect(page.headers['x-from']).toBe('web');
    expect((await request(listener(false, true)).get('/login')).status).toBe(404);
    expect((await request(listener(true, true)).get('/api/v1/auth/me')).status).toBe(404);
    const moved = await request(listener(true, true)).get('/moved').set('Host', '192.168.1.147:47143').redirects(0);
    expect(moved.status).toBe(308);
    expect(moved.headers.location).toBe('https://192.168.1.147:47143/fleet/endpoints');
  });

  it('home means the same network as this computer, never Tailscale or the internet', () => {
    const nets = netsFrom([
      { address: '192.168.1.147', netmask: '255.255.255.0' },
      { address: '100.95.99.101', netmask: '255.192.0.0' },
      { address: '169.254.211.158', netmask: '255.255.0.0' },
    ]);
    expect(isHomeAddress('192.168.1.20', nets)).toBe(true);
    expect(isHomeAddress('::ffff:192.168.1.20', nets)).toBe(true);
    expect(isHomeAddress('192.168.2.20', nets)).toBe(false);
    expect(isHomeAddress('100.123.69.25', nets)).toBe(false);
    expect(isHomeAddress('169.254.1.1', nets)).toBe(false);
    expect(isHomeAddress('8.8.8.8', nets)).toBe(false);
    expect(isHomeAddress('127.0.0.1', nets)).toBe(false);
    expect(isHomeAddress('fe80::1', nets)).toBe(false);
    expect(isHomeAddress(undefined, nets)).toBe(false);
  });

  it('as mounted by createApp: after helmet (its headers on the pages, the web app CSP wins)', async () => {
    const { cred } = await phoneSession('admin');
    const s = await request(app).post('/api/v1/agent/dashboard-session').set('Authorization', `Bearer ${cred}`).send({});
    const cookie = `ld_session=${s.body.value}`;
    const saved = env.WEB_ORIGIN;
    (env as { WEB_ORIGIN: string }).WEB_ORIGIN = webOrigin;
    let full: express.Express;
    try {
      full = createApp(); // the proxy reads WEB_ORIGIN once, here
    } finally {
      (env as { WEB_ORIGIN: string }).WEB_ORIGIN = saved;
    }
    // An HTTP server whose sockets say they are TLS, like the API's HTTPS listener.
    const srv = http.createServer(full);
    srv.on('connection', (sock) => ((sock as { encrypted?: boolean }).encrypted = true));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const page = await request(srv).get('/fleet').set('Cookie', cookie);
      expect(page.status).toBe(200);
      expect(page.headers['x-from']).toBe('web');
      expect(page.headers['strict-transport-security']).toBeTruthy();
      expect(page.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      // helmet's own policy (no nonce) would block the page's scripts: never sent on a proxied page.
      expect(page.headers['content-security-policy']).toBeUndefined();
      expect(page.headers['ratelimit-policy']).toBeTruthy(); // the proxy's own limiter answered (tests lift the number)

      const secure = await request(srv).get('/secure').set('Cookie', cookie);
      expect(secure.headers['content-security-policy']).toBe("script-src 'nonce-abc'");
      expect(secure.headers['x-frame-options']).toBe('DENY');

      // The API's own answers keep helmet's policy.
      expect((await request(srv).get('/healthz')).headers['content-security-policy']).toContain("default-src 'self'");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('the rate limit runs before the session lookup: made-up cookies are cut off too', async () => {
    const a = express();
    a.use((req, _res, next) => {
      (req.socket as { encrypted?: boolean }).encrypted = true;
      next();
    });
    a.use(phoneDashboardProxy(webOrigin, () => false, rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: 'draft-7', legacyHeaders: false })));
    a.use((_req, res) => void res.status(404).json({ error: 'not_found' }));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await request(a).get('/fleet').set('Cookie', `ld_session=made-up-${i}`)).status);
    expect(statuses).toEqual([404, 404, 429]);
    // Requests the proxy does not handle are not counted here (/api has its own limit).
    expect((await request(a).get('/api/v1/auth/me')).status).toBe(404);
  });
});
