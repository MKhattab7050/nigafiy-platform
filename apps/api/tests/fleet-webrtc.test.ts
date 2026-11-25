import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { env } from '../src/config/env.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { StreamHub } from '../src/modules/endpoints/remote-desktop/stream-hub.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// WebRTC video signalling (docs/features/fleet-pro.md "WebRTC video"): real HTTP servers, real `ws`
// sockets, the real database and pg_notify. The browser and the agent are played by sockets; the
// peer connection itself is exercised in Go (agents/endpoint-agent/internal/rdstream/webrtc_test.go).

const ORIGIN = 'http://localhost:3100';
const PASSWORD = 'correct horse battery';
const OFFER = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=recvonly\r\n';
const HOST_CANDIDATE = { candidate: 'candidate:842163049 1 udp 2122260223 10.0.0.23 54321 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 };
const HELLO_RTC = { t: 'hello', session_id: '', displays: [], desktop: { mode: 'helper' }, encoder: 'jpeg', webrtc: { supported: true, encoder: 'Media Foundation H.264 (hardware: Test MFT)' } };

interface Instance {
  server: http.Server;
  hub: StreamHub;
  base: string;
}

async function instance(): Promise<Instance> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

class Peer {
  readonly ws: WebSocket;
  readonly texts: Array<Record<string, unknown>> = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.texts.push(JSON.parse((Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).toString('utf8')));
      for (const w of this.waiters.splice(0)) w();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of this.waiters.splice(0)) w();
    });
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
  /** The last message of a type (counts change over time). */
  last(t: string): Record<string, unknown> | undefined {
    return this.texts.filter((m) => m.t === t).at(-1);
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
const wsUrl = (base: string, path: string) => base.replace(/^http/, 'ws') + path;
const agentSocket = (i: Instance, cred: string, session: string) => open(wsUrl(i.base, `/api/v1/agent/stream?session=${session}`), { Authorization: `Bearer ${cred}` });
const viewerSocket = (i: Instance, cookie: string, epId: string, session: string) =>
  open(wsUrl(i.base, `/api/v1/endpoints/${epId}/remote-desktop/stream?session=${session}`), { Cookie: cookie, Origin: ORIGIN });

async function loginCookie(email: string): Promise<string> {
  const r = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email, password: PASSWORD });
  const c = ((r.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((s) => s.startsWith('ld_session='));
  if (!c) throw new Error(`login: ${r.status}`);
  return c.split(';')[0]!;
}

async function addTechnician(owner: TestAccount) {
  const email = `tech-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const inv = await owner.agent.post('/api/v1/team/invitations').set(CSRF).send({ email, role: 'technician' });
  expect(inv.status).toBe(201);
  const agent = request.agent(app);
  expect((await agent.post(`/api/v1/auth/invitations/${inv.body.token}/accept`).set(CSRF).send({ display_name: 'Tech', password: PASSWORD })).status).toBe(200);
  const id = (await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [email])).rows[0]!.id;
  return { email, agent, id };
}

async function fullAdminGroup(a: TestAccount, epId: string) {
  const profiles = (await a.agent.get('/api/v1/fleet/profiles')).body.profiles as Array<{ id: string; builtin_key: string | null }>;
  const full = profiles.find((p) => p.builtin_key === 'full_admin')!.id;
  const g = await a.agent
    .post('/api/v1/fleet/groups')
    .set(CSRF)
    .send({ name: `RTC ${Math.random().toString(36).slice(2, 6)}`, access_mode: 'unattended', default_profile_id: full, max_profile_id: full });
  expect(g.status).toBe(201);
  await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.body.group.id });
}

const transportAudits = async (orgId: string) =>
  (await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'fleet.session_transport' ORDER BY created_at, id`, [orgId])).rows.map(
    (r) => r.metadata as Record<string, unknown>,
  );
const settle = () => new Promise((r) => setTimeout(r, 300));

/** Offer → answer → active, as a browser and an agent do it; returns the agent-side routing id. */
async function startRtc(viewer: Peer, agent: Peer, encoder = 'Media Foundation H.264 (hardware: Test MFT)'): Promise<string> {
  const before = agent.texts.filter((m) => m.t === 'rtc_offer').length;
  viewer.send({ t: 'rtc_offer', sdp: OFFER });
  const offer = await agent.until(() => agent.texts.filter((m) => m.t === 'rtc_offer')[before], 'rtc_offer');
  const req = offer.req as string;
  agent.send({ t: 'rtc_answer', req, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' });
  await viewer.until(() => viewer.texts.filter((m) => m.t === 'rtc_answer').length > 0, 'rtc_answer');
  agent.send({ t: 'rtc_state', req, state: 'connected', encoder });
  viewer.send({ t: 'rtc_active', encoder });
  return req;
}

describe('WebRTC video signalling (stream hub)', () => {
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

  it('checks and relays the offer, routes the answer to the asking browser, audits start/fallback/stop and the data-channel input', async () => {
    const a = await newAccount('rtc');
    const { epId, cred } = await onlineEndpoint(a);
    const cookie = await loginCookie(a.email);
    const session = (await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Smooth video' })).body.session.id as string;
    const agent = await agentSocket(A, cred, session);
    // An agent without WebRTC (Linux, macOS, older, no encoder): the offer is refused, audited.
    agent.send({ t: 'hello', session_id: session, displays: [], desktop: { mode: 'helper' }, encoder: 'jpeg', webrtc: { supported: false, reason: 'no H.264 encoder' } });
    const viewer = await viewerSocket(A, cookie, epId, session);
    const s = await viewer.text('session');
    expect(s).toMatchObject({ webrtc: true, ice_servers: [] });
    await viewer.text('hello');
    await agent.until(() => agent.last('viewers')?.count === 1, 'viewers = 1');
    viewer.send({ t: 'rtc_offer', sdp: OFFER });
    expect((await viewer.text('rtc_refused')).code).toBe('webrtc_unsupported');
    expect(agent.texts.some((m) => m.t === 'rtc_offer')).toBe(false);

    agent.send({ ...HELLO_RTC, session_id: session });
    await viewer.until(() => viewer.texts.filter((m) => m.t === 'hello').length === 2, 'second hello');
    // Malformed signalling never reaches the agent: not an SDP, a relay candidate, an unknown reason.
    viewer.send({ t: 'rtc_offer', sdp: 'hello there' });
    viewer.send({ t: 'rtc_ice', candidate: { candidate: 'candidate:1 1 udp 1 203.0.113.9 3478 typ relay raddr 0.0.0.0 rport 0' } });
    viewer.send({ t: 'rtc_fallback', reason: 'because' });
    await viewer.until(() => viewer.texts.filter((m) => m.t === 'error' && m.where === 'message').length === 3, 'three refusals');
    // Candidates before an accepted offer are dropped.
    viewer.send({ t: 'rtc_ice', candidate: HOST_CANDIDATE });

    // The browser cannot choose its routing id or its control: the hub sets both.
    viewer.send({ t: 'rtc_offer', sdp: OFFER, req: 'someone-else', control: true, ice_servers: ['turn:evil.example'] });
    const offer = await agent.text('rtc_offer');
    expect(offer.req).toMatch(/^[0-9a-f]{32}\.rtc$/);
    expect(offer).toMatchObject({ sdp: OFFER, control: true, ice_servers: [] });
    expect(agent.texts.filter((m) => m.t === 'rtc_ice')).toHaveLength(0);
    const req = offer.req as string;
    viewer.send({ t: 'rtc_ice', candidate: HOST_CANDIDATE });
    expect((await agent.text('rtc_ice')).candidate).toMatchObject(HOST_CANDIDATE);
    viewer.send({ t: 'rtc_perms', control: true });

    agent.send({ t: 'rtc_answer', req, sdp: 'v=0\r\no=- 1 1 IN IP4 10.0.0.5\r\ns=-\r\nt=0 0\r\n' });
    expect(await viewer.text('rtc_answer')).toMatchObject({ req: 'rtc' });
    agent.send({ t: 'rtc_ice', req, candidate: { candidate: 'candidate:1 1 udp 2130706431 10.0.0.5 50000 typ host', sdpMid: '0' } });
    expect((await viewer.text('rtc_ice')).req).toBe('rtc');
    agent.send({ t: 'rtc_state', req, state: 'connected', encoder: HELLO_RTC.webrtc.encoder });
    expect((await viewer.text('rtc_state')).state).toBe('connected');

    // The first frame decoded: the viewer leaves the JPEG count (the agent stops encoding JPEG).
    viewer.send({ t: 'rtc_active', encoder: HELLO_RTC.webrtc.encoder });
    await agent.until(() => agent.last('viewers')?.count === 0, 'viewers = 0');
    expect(A.hub.stats(epId)).toMatchObject({ viewers: 1, rtc: 1 });
    agent.send({ t: 'rtc_stats', fps: 29.8, kbps: 3900, bitrate_kbps: 4000, encoder: 'x', peers: 1 });
    expect((await viewer.text('rtc_stats')).fps).toBe(29.8);

    // Input on the data channel: the agent reports it; the hub audits it and does not forward it.
    agent.send({ t: 'rtc_input', req, kind: 'key_down', button: '', display_index: 0, double: false });
    agent.send({ t: 'rtc_input', req, kind: 'mouse_click', button: 'left', display_index: 1, double: true });
    agent.send({ t: 'rtc_input', req, kind: 'mouse_click', refused: 'profile_forbids_control' });
    agent.send({ t: 'rtc_input', req, kind: 'launch_rockets' });
    await settle();
    expect(viewer.texts.some((m) => m.t === 'rtc_input')).toBe(false);
    const inputs = (await systemPool.query(`SELECT user_email, metadata FROM audit_logs WHERE organization_id = $1 AND action = 'endpoint.rd_input' ORDER BY created_at, id`, [a.organizationId])).rows;
    expect(inputs.map((r) => r.metadata)).toEqual([
      expect.objectContaining({ via: 'webrtc', kind: 'key_down', display_index: 0, session_id: session }),
      expect.objectContaining({ via: 'webrtc', kind: 'mouse_click', button: 'left', display_index: 1, double: true }),
    ]);
    expect(inputs[0]!.user_email).toBe(a.email);
    const refused = (await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'fleet.session_refused_action'`, [a.organizationId])).rows;
    expect(refused.map((r) => r.metadata)).toEqual([expect.objectContaining({ via: 'webrtc', code: 'profile_forbids_control', kind: 'mouse_click' })]);

    // ICE failed in the browser: back to JPEG, the agent drops the peer and sends a full frame.
    viewer.send({ t: 'rtc_fallback', reason: 'ice_failed' });
    expect((await agent.text('rtc_close')).req).toBe(req);
    await agent.until(() => agent.last('viewers')?.count === 1, 'viewers = 1');
    await agent.text('full');
    expect(A.hub.stats(epId)).toMatchObject({ rtc: 0 });
    await settle();
    expect(await systemPool.query(`SELECT transport, rtc_encoder, rtc_fallback_reason, rtc_started_at IS NOT NULL AS started FROM fleet_sessions WHERE public_id = $1`, [session]).then((r) => r.rows[0])).toEqual({
      transport: 'webrtc',
      rtc_encoder: HELLO_RTC.webrtc.encoder,
      rtc_fallback_reason: 'ice_failed',
      started: true,
    });
    // The agent reconnecting does not rewrite the history's transport.
    agent.ws.close();
    const agent2 = await agentSocket(A, cred, session);
    agent2.send({ ...HELLO_RTC, session_id: session });
    await settle();
    expect((await systemPool.query(`SELECT transport FROM fleet_sessions WHERE public_id = $1`, [session])).rows[0]!.transport).toBe('webrtc');

    // Again, then the viewer leaves: the agent closes that peer; audited as stopped.
    const req2 = await startRtc(viewer, agent2);
    await agent2.until(() => agent2.last('viewers')?.count === 0, 'viewers = 0');
    viewer.ws.close();
    expect((await agent2.text('rtc_close')).req).toBe(req2);
    await settle();
    expect((await transportAudits(a.organizationId)).map((m) => [m.event, m.mode, m.code ?? m.reason ?? m.encoder ?? null])).toEqual([
      ['refused', 'webrtc', 'webrtc_unsupported'],
      ['started', 'webrtc', HELLO_RTC.webrtc.encoder],
      ['fallback', 'jpeg', 'ice_failed'],
      ['started', 'webrtc', HELLO_RTC.webrtc.encoder],
      ['stopped', 'webrtc', 'viewer_left'],
    ]);
    // Nothing of the SDP or the candidates is audited.
    const all = JSON.stringify((await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1`, [a.organizationId])).rows);
    expect(all).not.toContain('10.0.0.23');
    expect(all).not.toContain('v=0');
    agent2.ws.close();
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
  });

  it('keeps recorded sessions on the server path: offers are refused and WebRTC viewers go back to JPEG when recording starts', async () => {
    const a = await newAccount('rtc-rec');
    const { epId, cred } = await onlineEndpoint(a);
    await fullAdminGroup(a, epId);
    const session = (await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Recorded fix' })).body.session.id as string;
    const agent = await agentSocket(A, cred, session);
    agent.send({ ...HELLO_RTC, session_id: session });
    const viewer = await viewerSocket(A, await loginCookie(a.email), epId, session);
    await viewer.text('hello');
    const req = await startRtc(viewer, agent);
    await agent.until(() => agent.last('viewers')?.count === 0, 'viewers = 0');

    const rec = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/recording`).set(CSRF).send({ on: true });
    expect(rec.status).toBe(200);
    expect((await viewer.text('rtc_closed')).reason).toBe('recording');
    expect((await agent.text('rtc_close')).req).toBe(req);
    await agent.until(() => agent.last('viewers')?.count === 1, 'JPEG viewer again');
    viewer.send({ t: 'rtc_offer', sdp: OFFER });
    expect((await viewer.text('rtc_refused')).code).toBe('webrtc_recording_active');
    await settle();
    const events = (await transportAudits(a.organizationId)).map((m) => [m.event, m.reason ?? m.code ?? null]);
    expect(events).toEqual([
      ['started', null],
      ['fallback', 'recording'],
      ['refused', 'webrtc_recording_active'],
    ]);
    viewer.ws.close();
    agent.ws.close();
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/recording`).set(CSRF).send({ on: false });
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
  });

  it("gives a view-only colleague's peer no control and follows a hand-over (rtc_perms)", async () => {
    const a = await newAccount('rtc-multi');
    const b = await addTechnician(a);
    const { epId, cred } = await onlineEndpoint(a);
    await fullAdminGroup(a, epId);
    const session = (await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Two of us' })).body.session.id as string;
    const agent = await agentSocket(A, cred, session);
    agent.send({ ...HELLO_RTC, session_id: session });
    const viewOnly = { view: true, control: false, clipboard_in: false, clipboard_out: false, files: false, audio: false, record: false, restart: false, privacy_screen: false, block_input: false, shell: false };
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants`).set(CSRF).send({ user_id: b.id, permissions: viewOnly })).status).toBe(200);
    expect((await b.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants/join`).set(CSRF).send({})).status).toBe(200);
    const bView = await viewerSocket(A, await loginCookie(b.email), epId, session);
    await bView.text('hello');
    bView.send({ t: 'rtc_offer', sdp: OFFER, control: true });
    const offer = await agent.text('rtc_offer');
    expect(offer.control).toBe(false);

    // Hand-over: b holds the session (full permissions); the agent is told for b's peer.
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants/${b.id}/handover`).set(CSRF)).status).toBe(200);
    const perms = await agent.text('rtc_perms', (m) => m.req === offer.req);
    expect(perms.control).toBe(true);
    bView.ws.close();
    agent.ws.close();
    await b.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
  });

  it('relays the signalling through the instance holding the agent and audits the input on the operator’s instance', async () => {
    const a = await newAccount('rtc-peer');
    const { epId, cred } = await onlineEndpoint(a);
    const session = (await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Across instances' })).body.session.id as string;
    const viewer = await viewerSocket(B, await loginCookie(a.email), epId, session);
    await viewer.text('path', (m) => m.path === 'waiting');
    const agent = await agentSocket(A, cred, session);
    await viewer.text('path', (m) => m.path === 'relay');
    agent.send({ ...HELLO_RTC, session_id: session });
    await viewer.text('hello');
    await agent.until(() => agent.last('viewers')?.count === 1, 'viewers = 1');
    const req = await startRtc(viewer, agent);
    expect(req).toMatch(/^[0-9a-f]{32}\.rtc$/);
    await agent.until(() => agent.last('viewers')?.count === 0, 'viewers = 0');
    agent.send({ t: 'rtc_input', req, kind: 'key_press', display_index: 0 });
    await settle();
    const inputs = (await systemPool.query(`SELECT user_email, metadata FROM audit_logs WHERE organization_id = $1 AND action = 'endpoint.rd_input'`, [a.organizationId])).rows;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ user_email: a.email, metadata: { via: 'webrtc', kind: 'key_press' } });
    viewer.send({ t: 'rtc_fallback', reason: 'no_video' });
    expect((await agent.text('rtc_close')).req).toBe(req);
    await agent.until(() => agent.last('viewers')?.count === 1, 'JPEG viewer again');
    viewer.ws.close();
    agent.ws.close();
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
  });

  it('refuses every offer while RD_WEBRTC=off and says so in the session message', async () => {
    const mutable = env as { RD_WEBRTC: 'on' | 'off' };
    mutable.RD_WEBRTC = 'off';
    try {
      const a = await newAccount('rtc-off');
      const { epId, cred } = await onlineEndpoint(a);
      const session = (await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'No video' })).body.session.id as string;
      const agent = await agentSocket(A, cred, session);
      agent.send({ ...HELLO_RTC, session_id: session });
      const viewer = await viewerSocket(A, await loginCookie(a.email), epId, session);
      expect((await viewer.text('session')).webrtc).toBe(false);
      await viewer.text('hello');
      viewer.send({ t: 'rtc_offer', sdp: OFFER });
      expect((await viewer.text('rtc_refused')).code).toBe('webrtc_disabled');
      expect(agent.texts.some((m) => m.t === 'rtc_offer')).toBe(false);
      viewer.ws.close();
      agent.ws.close();
      await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
    } finally {
      mutable.RD_WEBRTC = 'on';
    }
  });
});
