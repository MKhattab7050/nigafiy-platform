import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env, isWebOrigin } from '../src/config/env.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { type CliRunner, parseServeStatus, parseTailscaleStatus, serveArgs, setCliRunner } from '../src/modules/outside-access/detect.ts';
import { normalizeOrigin, refreshOutsideOrigins, webPort } from '../src/modules/outside-access/index.ts';
import { CSRF, app, newAccount, setRole } from './helpers.ts';
import request from 'supertest';

// UX review item 18: Tailscale / Cloudflare Tunnel origins accepted from Settings.

const TS_NAME = 'office-pc.tail1234.ts.net';
const TS_ORIGIN = `https://${TS_NAME}`;
const CF_ORIGIN = 'https://nigafiy-test.example.com';

/** A fake Tailscale + cloudflared, recording every command. */
function fakeTools(opts: { tailscale?: boolean; running?: boolean; serving?: boolean; serveOk?: boolean; cloudflared?: boolean } = {}) {
  const calls: string[][] = [];
  let serving = opts.serving ?? false;
  const runner: CliRunner = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'tailscale') {
      if (opts.tailscale === false) return { code: -1, stdout: '', stderr: 'ENOENT' };
      if (args[0] === 'version') return { code: 0, stdout: '1.76.1\n  tailscale commit: abc\n', stderr: '' };
      if (args[0] === 'status') {
        return { code: 0, stdout: JSON.stringify({ BackendState: opts.running === false ? 'NeedsLogin' : 'Running', Self: { DNSName: `${TS_NAME}.`, TailscaleIPs: ['100.101.102.103'] } }), stderr: '' };
      }
      if (args[0] === 'serve' && args[1] === 'status') {
        return { code: 0, stdout: serving ? JSON.stringify({ Web: { [`${TS_NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${webPort()}` } } } } }) : '{}', stderr: '' };
      }
      if (args[0] === 'serve') {
        if (opts.serveOk === false) return { code: 1, stdout: '', stderr: 'Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=x' };
        serving = !args.includes('off');
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    if (file === 'cloudflared') {
      if (!opts.cloudflared) return { code: -1, stdout: '', stderr: 'ENOENT' };
      return { code: 0, stdout: 'cloudflared version 2025.11.1 (built 2025-11-10)', stderr: '' };
    }
    return { code: -1, stdout: '', stderr: 'unknown' };
  };
  return { runner, calls };
}

const saved = { setup: env.OUTSIDE_ACCESS_SETUP, reg: env.ALLOW_REGISTRATION };
beforeEach(() => {
  env.OUTSIDE_ACCESS_SETUP = 'on';
  env.ALLOW_REGISTRATION = 'first'; // the test database already has accounts: sign-up is closed
});
afterEach(async () => {
  setCliRunner(null);
  env.OUTSIDE_ACCESS_SETUP = saved.setup;
  env.ALLOW_REGISTRATION = saved.reg;
  await systemPool.query(`DELETE FROM web_origins WHERE origin IN ($1, $2)`, [TS_ORIGIN, CF_ORIGIN]);
  await refreshOutsideOrigins();
});
afterAll(() => {
  env.OUTSIDE_ACCESS_SETUP = saved.setup;
  env.ALLOW_REGISTRATION = saved.reg;
});

/** A new owner account (sign-up opened just for it), then sign-up closed again as on an installed copy. */
async function owner(label: string) {
  env.ALLOW_REGISTRATION = 'true';
  try {
    return await newAccount(label);
  } finally {
    env.ALLOW_REGISTRATION = 'first';
  }
}

/** A state-changing, CSRF-checked request sent with this browser Origin. */
const patchMe = (agent: ReturnType<typeof request.agent>, origin: string) => agent.patch('/api/v1/auth/me').set(CSRF).set('Origin', origin).send({ locale: 'en' });

describe('outside access: pure helpers', () => {
  it('accepts only https host-name origins, with nothing after them', () => {
    expect(normalizeOrigin('https://Nigafiy.Example.com/')).toBe('https://nigafiy.example.com');
    expect(normalizeOrigin('https://a.example.com:8443')).toBe('https://a.example.com:8443');
    for (const bad of ['http://a.example.com', 'https://1.2.3.4', 'https://localhost', 'https://x.localhost', 'https://example', 'https://a.example.com/path', 'https://a.example.com/?q', 'https://u:p@a.example.com', 'javascript:alert(1)', '']) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
  });

  it('reads tailscale status and serve status', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'PC.tail1.ts.net.', TailscaleIPs: ['100.1.2.3'] } }))).toEqual({
      state: 'Running',
      dns_name: 'pc.tail1.ts.net',
      ips: ['100.1.2.3'],
      origin: 'https://pc.tail1.ts.net',
    });
    // A name that is not a tailnet name never becomes an origin.
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'evil.example.com.' } })).origin).toBeNull();
    expect(parseTailscaleStatus('not json').state).toBeNull();
    const web = (proxy: string) => JSON.stringify({ Web: { 'pc.tail1.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } });
    expect(parseServeStatus(web('http://127.0.0.1:47130'), 'pc.tail1.ts.net', 47130)).toEqual({ serving: true, serve_target: 'http://127.0.0.1:47130' });
    expect(parseServeStatus(web('http://127.0.0.1:8080'), 'pc.tail1.ts.net', 47130).serving).toBe(false);
    expect(parseServeStatus('{}', 'pc.tail1.ts.net', 47130)).toEqual({ serving: false, serve_target: null });
  });

  it('serves to the tailnet only (Serve, never Funnel) and forwards to the loopback web port', () => {
    const args = serveArgs(47130);
    expect(args).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:47130']);
    expect(args.join(' ')).not.toMatch(/funnel/i);
  });
});

describe('outside access: API', () => {
  it('reports what is installed (admin and up; members are refused)', async () => {
    const tools = fakeTools({ cloudflared: true });
    setCliRunner(tools.runner);
    const acct = await owner('outside-get');
    const r = await acct.agent.get('/api/v1/outside-access');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      available: true,
      registration_open: false,
      web_port: webPort(),
      tailscale: { installed: true, state: 'Running', dns_name: TS_NAME, origin: TS_ORIGIN, serving: false, origin_accepted: false },
      cloudflared: { installed: true, version: '2025.11.1' },
    });
    expect(r.body.serve_command).toBe(`tailscale serve --bg --https=443 http://127.0.0.1:${webPort()}`);

    await setRole(acct.email, acct.organizationId, 'viewer');
    expect((await acct.agent.get('/api/v1/outside-access')).status).toBe(403);
  });

  it('says when Tailscale is missing, without failing', async () => {
    setCliRunner(fakeTools({ tailscale: false }).runner);
    const acct = await owner('outside-missing');
    const r = await acct.agent.get('/api/v1/outside-access');
    expect(r.status).toBe(200);
    expect(r.body.tailscale).toMatchObject({ installed: false, origin: null });
    expect(r.body.cloudflared.installed).toBe(false);
  });

  it('accepts a Cloudflare Tunnel origin: CSRF passes from it, sign-up stays closed, removing it refuses it again', async () => {
    setCliRunner(fakeTools().runner);
    const acct = await owner('outside-cf');
    expect((await patchMe(acct.agent, CF_ORIGIN)).status).toBe(403); // not accepted yet

    const add = await acct.agent.post('/api/v1/outside-access/origins').set(CSRF).send({ origin: `${CF_ORIGIN}/`, kind: 'cloudflare' });
    expect(add.status).toBe(201);
    expect(add.body.origins.map((o: { origin: string }) => o.origin)).toContain(CF_ORIGIN);
    expect(isWebOrigin(CF_ORIGIN)).toBe(true);
    expect((await patchMe(acct.agent, CF_ORIGIN)).status).toBe(200);
    expect((await patchMe(acct.agent, 'https://other.example.com')).status).toBe(403);

    // From the tunnel, nobody can create an account.
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .set(CSRF)
      .set('Origin', CF_ORIGIN)
      .send({ email: 'stranger@example.test', password: 'correct horse battery', display_name: 'S', organization_name: 'S', site_name: 'S' });
    expect(reg.status).toBe(403);
    expect(reg.body.error.code).toBe('registration_disabled');

    const audit = await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'outside_access.%'`, [acct.organizationId]);
    expect(audit.rows.map((r) => r.action)).toContain('outside_access.origin_added');

    const rm = await acct.agent.post('/api/v1/outside-access/origins/remove').set(CSRF).send({ origin: CF_ORIGIN });
    expect(rm.body.removed).toBe(true);
    expect(isWebOrigin(CF_ORIGIN)).toBe(false);
    expect((await patchMe(acct.agent, CF_ORIGIN)).status).toBe(403);
  });

  it('refuses bad origins, a Tailscale origin that is not this PC, and non-owners', async () => {
    setCliRunner(fakeTools().runner);
    const acct = await owner('outside-bad');
    for (const origin of ['http://nigafiy-test.example.com', 'https://10.0.0.5', 'https://nigafiy-test.example.com/x']) {
      const r = await acct.agent.post('/api/v1/outside-access/origins').set(CSRF).send({ origin, kind: 'custom' });
      expect(r.status, origin).toBe(400);
      expect(r.body.error.code).toBe('invalid_origin');
    }
    const ts = await acct.agent.post('/api/v1/outside-access/origins').set(CSRF).send({ origin: 'https://someone-else.tail9.ts.net', kind: 'tailscale' });
    expect(ts.status).toBe(400);

    await setRole(acct.email, acct.organizationId, 'admin');
    expect((await acct.agent.post('/api/v1/outside-access/origins').set(CSRF).send({ origin: CF_ORIGIN, kind: 'cloudflare' })).status).toBe(403);
    expect((await acct.agent.post('/api/v1/outside-access/tailscale/serve').set(CSRF).send({ on: true, confirm: true })).status).toBe(403);
  });

  it('refuses while anyone can sign up, and on a server with several organizations (auto)', async () => {
    setCliRunner(fakeTools().runner);
    const acct = await owner('outside-open');
    env.ALLOW_REGISTRATION = 'true';
    const open = await acct.agent.post('/api/v1/outside-access/origins').set(CSRF).send({ origin: CF_ORIGIN, kind: 'cloudflare' });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe('registration_open');
    expect((await acct.agent.post('/api/v1/outside-access/tailscale/serve').set(CSRF).send({ on: true, confirm: true })).status).toBe(409);

    env.ALLOW_REGISTRATION = 'first';
    env.OUTSIDE_ACCESS_SETUP = 'auto'; // the shared test database has many organizations
    const multi = await acct.agent.post('/api/v1/outside-access/origins').set(CSRF).send({ origin: CF_ORIGIN, kind: 'cloudflare' });
    expect(multi.status).toBe(403);
    expect(multi.body.error.code).toBe('outside_access_unavailable');
    expect((await acct.agent.get('/api/v1/outside-access')).body).toMatchObject({ available: false, blocked_reason: 'multi_tenant' });

    env.OUTSIDE_ACCESS_SETUP = 'off';
    expect((await acct.agent.get('/api/v1/outside-access')).body).toMatchObject({ available: false, blocked_reason: 'disabled' });
    expect(isWebOrigin(CF_ORIGIN)).toBe(false);
  });

  it('turns Tailscale Serve on (accepting this PC’s tailnet origin) and off again', async () => {
    const tools = fakeTools();
    setCliRunner(tools.runner);
    const acct = await owner('outside-ts');
    const without = await acct.agent.post('/api/v1/outside-access/tailscale/serve').set(CSRF).send({ on: true });
    expect(without.status).toBe(400); // confirm: true is required

    const on = await acct.agent.post('/api/v1/outside-access/tailscale/serve').set(CSRF).send({ on: true, confirm: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ ok: true, origin: TS_ORIGIN, tailscale: { serving: true } });
    expect(tools.calls).toContainEqual(['tailscale', ...serveArgs(webPort())]);
    expect((await patchMe(acct.agent, TS_ORIGIN)).status).toBe(200);
    expect((await acct.agent.get('/api/v1/outside-access')).body.tailscale).toMatchObject({ serving: true, origin_accepted: true });

    const off = await acct.agent.post('/api/v1/outside-access/tailscale/serve').set(CSRF).send({ on: false, confirm: true });
    expect(off.body.ok).toBe(true);
    expect(tools.calls).toContainEqual(['tailscale', 'serve', '--https=443', 'off']);
    expect((await patchMe(acct.agent, TS_ORIGIN)).status).toBe(403);
  });

  it("shows Tailscale's own answer when it refuses, and accepts nothing", async () => {
    setCliRunner(fakeTools({ serveOk: false }).runner);
    const acct = await owner('outside-ts-fail');
    const r = await acct.agent.post('/api/v1/outside-access/tailscale/serve').set(CSRF).send({ on: true, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.output).toContain('login.tailscale.com');
    expect(isWebOrigin(TS_ORIGIN)).toBe(false);
  });

  it('will not turn Serve on while Tailscale is signed out', async () => {
    setCliRunner(fakeTools({ running: false }).runner);
    const acct = await owner('outside-ts-out');
    const r = await acct.agent.post('/api/v1/outside-access/tailscale/serve').set(CSRF).send({ on: true, confirm: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('tailscale_not_ready');
  });
});
