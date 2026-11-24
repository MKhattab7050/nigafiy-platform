import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { systemPool } from '../src/infrastructure/db.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { StreamHub, frameMeta, peerSignature, verifyPeerSignature } from '../src/modules/endpoints/remote-desktop/stream-hub.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Live Remote Desktop over WebSocket (Fleet Pro item 2): real HTTP servers, real `ws` sockets,
// the real database and pg_notify. Two hubs on two servers in this process stand for two API
// instances (they share nothing but PostgreSQL).

const ORIGIN = 'http://localhost:3100';

interface Instance {
  server: http.Server;
  hub: StreamHub;
  base: string;
}

async function instance(): Promise<Instance> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const hub = new StreamHub({ peerUrl: base });
  hub.attach(server);
  hub.start();
  return { server, hub, base };
}

async function closeInstance(i: Instance): Promise<void> {
  await i.hub.stop();
  i.server.closeAllConnections();
  await new Promise<void>((resolve) => i.server.close(() => resolve()));
}

/** A socket with a message queue the test can wait on. */
class Peer {
  readonly ws: WebSocket;
  readonly texts: Array<Record<string, unknown>> = [];
  readonly frames: Buffer[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (isBinary) this.frames.push(buf);
      else this.texts.push(JSON.parse(buf.toString('utf8')));
      this.wake();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async until<T>(check: () => T | undefined | null | false, what: string, ms = 5_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(this.texts.slice(-8))} closed=${JSON.stringify(this.closed)}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  text(t: string, pred: (m: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
    return this.until(() => this.texts.find((m) => m.t === t && pred(m)), `"${t}"`);
  }

  send(m: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(m));
  }
}

function open(url: string, headers: Record<string, string>): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const p = new Peer(ws);
    ws.once('open', () => resolve(p));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

function wsUrl(base: string, path: string): string {
  return base.replace(/^http/, 'ws') + path;
}

const agentSocket = (i: Instance, cred: string, session: string) => open(wsUrl(i.base, `/api/v1/agent/stream?session=${session}`), { Authorization: `Bearer ${cred}` });
const viewerSocket = (i: Instance, cookie: string, epId: string, session: string, origin = ORIGIN) =>
  open(wsUrl(i.base, `/api/v1/endpoints/${epId}/remote-desktop/stream?session=${session}`), { Cookie: cookie, Origin: origin });

async function loginCookie(a: TestAccount): Promise<string> {
  const r = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'correct horse battery' });
  const set = (r.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const c = set.find((s) => s.startsWith('ld_session='));
  if (!c) throw new Error(`login: ${r.status}`);
  return c.split(';')[0]!;
}

/** A binary frame packet as the Go agent builds it (remotedesktop.EncodedFrame.Packet). */
function packet(seq: number, full: boolean, tile = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])): Buffer {
  const header = Buffer.from(
    JSON.stringify({ t: 'frame', seq, full, display: 0, w: 64, h: 64, sw: 64, sh: 64, q: 70, s: 1, fmt: 'jpeg', tiles: [{ x: 0, y: 0, w: 64, h: 64, n: tile.length }], mode: 'test' }),
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([Buffer.from([0x4e, 1]), len, header, tile]);
}

async function rejectedStatus(p: Promise<Peer>): Promise<string> {
  try {
    const peer = await p;
    peer.ws.close();
    return 'opened';
  } catch (err) {
    return (err as Error).message;
  }
}

async function fleetRow(epId: string, session: string) {
  return (await systemPool.query(`SELECT * FROM fleet_sessions WHERE endpoint_id = $1 AND public_id = $2`, [epId, session])).rows[0];
}

describe('live remote desktop stream (WebSocket hub)', () => {
  let A: Instance;
  let B: Instance;

  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
    A = await instance();
    B = await instance();
  });
  afterAll(async () => {
    await closeInstance(A);
    await closeInstance(B);
    await endpointsModule.lifecycle.stop();
  });

  it('checks packets and peer signatures', () => {
    expect(frameMeta(packet(7, true))).toEqual({ seq: 7, full: true });
    const bad = packet(1, false);
    expect(frameMeta(bad.subarray(0, bad.length - 1))).toBeNull(); // tile bytes missing
    expect(frameMeta(Buffer.from('not a frame'))).toBeNull();
    const ep = '00000000-0000-4000-8000-000000000001';
    const inst = '00000000-0000-4000-8000-000000000002';
    const sig = peerSignature(ep, 's1', inst);
    expect(verifyPeerSignature(sig, ep, 's1', inst)).toBe(true);
    expect(verifyPeerSignature(sig, ep, 's2', inst)).toBe(false);
    expect(verifyPeerSignature(peerSignature(ep, 's1', inst, Date.now() - 120_000), ep, 's1', inst)).toBe(false);
  });

  it('relays frames, input, clipboard and acks between the agent and an operator on one instance', async () => {
    const a = await newAccount('stream');
    const { epId, cred } = await onlineEndpoint(a);
    const cookie = await loginCookie(a);
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
    const session: string = start.body.session.id;

    // Who may connect.
    expect(await rejectedStatus(agentSocket(A, 'lda_bogus.bogus', session))).toBe('HTTP 401');
    expect(await rejectedStatus(agentSocket(A, cred, 'wrong-session'))).toBe('HTTP 409');
    expect(await rejectedStatus(viewerSocket(A, cookie, epId, session, 'https://evil.example'))).toBe('HTTP 403');
    expect(await rejectedStatus(viewerSocket(A, 'ld_session=nope', epId, session))).toBe('HTTP 401');
    expect(await rejectedStatus(viewerSocket(A, cookie, epId, 'wrong-session'))).toBe('HTTP 409');
    const outsider = await newAccount('stream-outsider');
    expect(await rejectedStatus(viewerSocket(A, await loginCookie(outsider), epId, session))).toBe('HTTP 404');

    const agent = await agentSocket(A, cred, session);
    await agent.text('viewers', (m) => m.count === 0);
    agent.send({ t: 'hello', session_id: session, displays: [{ index: 0, name: 'Display 1', width: 1920, height: 1080, primary: true }], desktop: { mode: 'helper' }, encoder: 'jpeg' });

    const viewer = await viewerSocket(A, cookie, epId, session);
    await viewer.text('path', (m) => m.path === 'direct');
    await viewer.text('session', (m) => m.state === 'active');
    await agent.text('viewers', (m) => m.count === 1);
    expect((await viewer.text('hello')).encoder).toBe('jpeg');
    const status = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`);
    expect(status.body.stream_connected).toBe(true);

    // A partial frame before any full one is held back (the new viewer has nothing to draw it on).
    agent.ws.send(packet(1, false), { binary: true });
    await agent.text('full');
    agent.ws.send(packet(2, true), { binary: true });
    const got = await viewer.until(() => viewer.frames[0], 'a frame');
    expect(frameMeta(got)).toEqual({ seq: 2, full: true });
    expect(viewer.frames).toHaveLength(1);
    agent.ws.send(Buffer.from([0x4e, 1, 0, 0, 0, 200, 1]), { binary: true }); // malformed: dropped
    agent.ws.send(packet(3, false), { binary: true });
    await viewer.until(() => viewer.frames.length === 2, 'second frame');
    viewer.send({ t: 'ack', seq: 3 });
    expect((await agent.text('ack')).seq).toBe(3);

    // Input: forwarded in the agent's format, audited with keys redacted; pointer moves are not audited.
    viewer.send({ t: 'input', ev: { kind: 'mouse_move', x: 0.5, y: 0.5 } });
    viewer.send({ t: 'input', ev: { kind: 'key_press', key: 'a', ctrl: true } });
    const key = await agent.text('input', (m) => (m.ev as { kind: string }).kind === 'key_press');
    expect(key.ev).toMatchObject({ kind: 'key_press', key: 'a', ctrl: true, display_index: 0 });
    viewer.send({ t: 'input', ev: { kind: 'explode' } });
    await viewer.text('input_error');

    // Clipboard both ways: only the asking viewer gets the answer; counted and audited.
    viewer.send({ t: 'clipboard_set', req: 'c1', text: 'hello remote' });
    const set = await agent.text('clipboard_set');
    expect(set.text).toBe('hello remote');
    agent.send({ t: 'clipboard_set_ok', req: set.req });
    expect((await viewer.text('clipboard_set_ok')).req).toBe('c1');
    viewer.send({ t: 'clipboard_get', req: 'c2' });
    const get = await agent.text('clipboard_get');
    agent.send({ t: 'clipboard', req: get.req, text: 'from the endpoint' });
    expect((await viewer.text('clipboard')).text).toBe('from the endpoint');
    viewer.send({ t: 'clipboard_set', req: 'c3', text: 'x'.repeat(16_001) });
    await viewer.text('error', (m) => m.where === 'message');

    await new Promise((r) => setTimeout(r, 300));
    const audits = (await systemPool.query(`SELECT action, metadata, user_email FROM audit_logs WHERE target_id = $1 ORDER BY created_at, id`, [epId])).rows;
    const inputs = audits.filter((x) => x.action === 'endpoint.rd_input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].metadata).toMatchObject({ via: 'live_stream', kind: 'key_press', key: '[redacted]', session_id: session });
    expect(inputs[0].user_email).toBe(a.email);
    const clip = audits.filter((x) => x.action === 'fleet.session_clipboard').map((x) => x.metadata);
    expect(clip).toEqual([expect.objectContaining({ direction: 'to_remote', chars: 12 }), expect.objectContaining({ direction: 'from_remote', chars: 17 })]);

    // The operator ends the session: every socket closes with "session ended".
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
    await agent.until(() => agent.closed, 'agent close');
    await viewer.until(() => viewer.closed, 'viewer close');
    expect(agent.closed?.code).toBe(4000);
    expect(viewer.closed?.code).toBe(4000);
    await new Promise((r) => setTimeout(r, 200));
    const row = await fleetRow(epId, session);
    expect(row).toMatchObject({ transport: 'ws', desktop_mode: 'helper', clipboard_to_remote: 1, clipboard_from_remote: 1 });
    expect(Number(row.frames_relayed)).toBe(2);
    expect(Number(row.bytes_relayed)).toBe(packet(2, true).length + packet(3, false).length);
    expect(row.stream_connected_at).toBeTruthy();
    // Nothing of a frame is stored: only the counters.
    const leaked = await systemPool.query(`SELECT count(*)::int AS n FROM endpoint_commands WHERE endpoint_id = $1 AND result_data::text LIKE '%jpeg_base64%'`, [epId]);
    expect(leaked.rows[0].n).toBe(0);
  });

  it('relays nothing under "prompt" until the user accepted', async () => {
    const a = await newAccount('stream-consent');
    const { epId, cred } = await onlineEndpoint(a);
    const cookie = await loginCookie(a);
    await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({ remote_desktop_consent: 'prompt' });
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
    const session: string = start.body.session.id;
    const agent = await agentSocket(A, cred, session);
    const viewer = await viewerSocket(A, cookie, epId, session);
    await viewer.text('session', (m) => m.state === 'waiting_consent');
    await agent.text('viewers', (m) => m.count === 0);
    agent.ws.send(packet(1, true), { binary: true });
    viewer.send({ t: 'input', ev: { kind: 'text', text: 'x' } });
    expect((await viewer.text('input_error')).error).toMatch(/not accepted/);
    await new Promise((r) => setTimeout(r, 300));
    expect(viewer.frames).toHaveLength(0);
    expect(agent.texts.some((m) => m.t === 'input')).toBe(false);

    const open = (await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({})).body.commands[0];
    await request(app)
      .post('/api/v1/agent/command-result')
      .set('Authorization', `Bearer ${cred}`)
      .send({ command_results: [{ id: open.id, ok: true, output: '', data: { consent: 'accepted', banner: 'shown', stream: 'connecting' } }] });
    await viewer.text('session', (m) => m.state === 'active');
    await agent.text('viewers', (m) => m.count === 1);
    agent.ws.send(packet(2, true), { binary: true });
    await viewer.until(() => viewer.frames.length === 1, 'frame after consent');
    expect(frameMeta(viewer.frames[0]!)?.seq).toBe(2);
    agent.ws.close();
    viewer.ws.close();
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
  });

  it('routes through the instance holding the agent when the operator is on another one', async () => {
    const a = await newAccount('stream-peer');
    const { epId, cred } = await onlineEndpoint(a);
    const cookie = await loginCookie(a);
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
    const session: string = start.body.session.id;

    // The operator connects to B first: no agent anywhere yet.
    const viewer = await viewerSocket(B, cookie, epId, session);
    await viewer.text('path', (m) => m.path === 'waiting');
    // The agent then connects to A: A announces it (pg_notify), B opens the peer link.
    const agent = await agentSocket(A, cred, session);
    await viewer.text('path', (m) => m.path === 'relay' && m.instance === A.hub.instanceId);
    await agent.text('viewers', (m) => m.count === 1);
    expect(A.hub.stats(epId)).toMatchObject({ agent: true, peers: 1, viewers: 0 });
    expect(B.hub.stats(epId)).toMatchObject({ agent: false, upstream: true, viewers: 1 });

    agent.send({ t: 'hello', session_id: session, displays: [], desktop: { mode: 'local' }, encoder: 'jpeg' });
    await viewer.text('hello');
    agent.ws.send(packet(5, true), { binary: true });
    await viewer.until(() => viewer.frames.length === 1, 'relayed frame');
    expect(frameMeta(viewer.frames[0]!)?.seq).toBe(5);
    viewer.send({ t: 'ack', seq: 5 });
    expect((await agent.text('ack')).seq).toBe(5);
    viewer.send({ t: 'input', ev: { kind: 'mouse_click', x: 0.1, y: 0.2, button: 'left' } });
    expect((await agent.text('input')).ev).toMatchObject({ kind: 'mouse_click', x: 0.1, y: 0.2 });
    viewer.send({ t: 'clipboard_get', req: 'p1' });
    const get = await agent.text('clipboard_get');
    agent.send({ t: 'clipboard', req: get.req, text: 'over the relay' });
    expect((await viewer.text('clipboard')).text).toBe('over the relay');

    // A second operator on A sees the same picture (A now has one local viewer and B's link).
    const viewer2 = await viewerSocket(A, cookie, epId, session);
    await agent.text('viewers', (m) => m.count === 2);
    agent.ws.send(packet(6, true), { binary: true });
    await viewer2.until(() => viewer2.frames.length === 1, 'frame on A');
    await viewer.until(() => viewer.frames.length === 2, 'frame on B');

    // A peer link needs a valid signature.
    const forged = await rejectedStatus(
      open(wsUrl(A.base, `/api/v1/internal/rd-peer?endpoint=${epId}&session=${session}&instance=${B.hub.instanceId}`), { 'x-ld-peer': `${Math.floor(Date.now() / 1000)}.deadbeef` }),
    );
    expect(forged).toBe('HTTP 401');

    // The agent drops: B's operator is told; the session end closes everything everywhere.
    agent.ws.close();
    await viewer.text('path', (m) => m.path === 'waiting');
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
    await viewer.until(() => viewer.closed, 'viewer on B closed');
    await viewer2.until(() => viewer2.closed, 'viewer on A closed');
    expect(viewer.closed?.code).toBe(4000);
    expect(B.hub.stats(epId)).toBeNull();
  });
  it('enforces the session permission profile on every operator message (view only, clipboard directions)', async () => {
    const a = await newAccount('stream-profile');
    const { epId, cred } = await onlineEndpoint(a);
    const cookie = await loginCookie(a);
    const profiles = (await a.agent.get('/api/v1/fleet/profiles')).body.profiles as Array<{ id: string; builtin_key: string | null }>;
    const custom = await a.agent.post('/api/v1/fleet/profiles').set(CSRF).send({ name: 'Copy out only', control: true, clipboard_out: true });
    const g = await a.agent
      .post('/api/v1/fleet/groups')
      .set(CSRF)
      .send({ name: 'Kiosks', access_mode: 'unattended', default_profile_id: profiles.find((p) => p.builtin_key === 'view_only')!.id });
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.body.group.id });

    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Kiosk check' });
    const session: string = start.body.session.id;
    const agent = await agentSocket(A, cred, session);
    const viewer = await viewerSocket(A, cookie, epId, session);
    expect((await viewer.text('session')).permissions).toMatchObject({ view: true, control: false, clipboard_in: false, clipboard_out: false });
    viewer.send({ t: 'input', ev: { kind: 'key_press', key: 'Enter' } });
    expect((await viewer.text('input_error')).code).toBe('profile_forbids_control');
    viewer.send({ t: 'clipboard_get', req: 'c1' });
    expect((await viewer.text('clipboard_error', (m) => m.req === 'c1')).code).toBe('profile_forbids_clipboard_out');
    viewer.send({ t: 'clipboard_set', req: 'c2', text: 'secret text' });
    expect((await viewer.text('clipboard_error', (m) => m.req === 'c2')).code).toBe('profile_forbids_clipboard_in');
    viewer.send({ t: 'ack', seq: 1 });
    await agent.text('ack');
    // Nothing refused reached the agent.
    expect(agent.texts.some((m) => m.t === 'input' || m.t === 'clipboard_get' || m.t === 'clipboard_set')).toBe(false);
    const refused = (await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'fleet.session_refused_action' ORDER BY created_at, id`, [a.organizationId])).rows;
    expect(refused.map((r) => r.metadata.code)).toEqual(['profile_forbids_control', 'profile_forbids_clipboard_out', 'profile_forbids_clipboard_in']);
    expect(JSON.stringify(refused)).not.toContain('secret text');
    viewer.ws.close();
    agent.ws.close();

    // A custom profile: clipboard from the computer allowed, to the computer refused; control allowed.
    const s2 = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Copy a log line', profile_id: custom.body.profile.id });
    const sid2: string = s2.body.session.id;
    const agent2 = await agentSocket(A, cred, sid2);
    const viewer2 = await viewerSocket(A, cookie, epId, sid2);
    await viewer2.text('session', (m) => m.state === 'active');
    viewer2.send({ t: 'input', ev: { kind: 'key_press', key: 'a' } });
    await agent2.text('input');
    viewer2.send({ t: 'clipboard_get', req: 'k1' });
    const get = await agent2.text('clipboard_get');
    agent2.send({ t: 'clipboard', req: get.req, text: 'log line' });
    expect((await viewer2.text('clipboard')).text).toBe('log line');
    viewer2.send({ t: 'clipboard_set', req: 'k2', text: 'nope' });
    expect((await viewer2.text('clipboard_error', (m) => m.req === 'k2')).code).toBe('profile_forbids_clipboard_in');
    viewer2.ws.close();
    agent2.ws.close();
  });
});
