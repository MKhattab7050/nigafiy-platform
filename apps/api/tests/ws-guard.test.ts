import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MessageRate, SocketCounter, heartbeat } from '../src/common/ws-guard.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { StreamHub } from '../src/modules/endpoints/remote-desktop/stream-hub.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// EXT-2: WebSocket limits (message size, message rate, connection count, idle sockets) on the
// remote desktop stream hub, which owns the listener the remote shell shares. Real HTTP server,
// real `ws` sockets, real database.

const ORIGIN = 'http://localhost:3100';

describe('WebSocket guard units', () => {
  it('MessageRate drops above soft and closes above hard, per one-second window', () => {
    let now = 10_000;
    const rate = new MessageRate(3, 5, () => now);
    const got = Array.from({ length: 6 }, () => rate.take());
    expect(got).toEqual(['ok', 'ok', 'ok', 'drop', 'drop', 'close']);
    now += 1000;
    expect(rate.take()).toBe('ok');
  });

  it('SocketCounter caps a key and releases once', () => {
    const c = new SocketCounter();
    const r1 = c.acquire('u', 2);
    const r2 = c.acquire('u', 2);
    expect(r1 && r2).toBeTruthy();
    expect(c.acquire('u', 2)).toBeNull();
    expect(c.acquire('other', 2)).not.toBeNull();
    r1!();
    r1!(); // a second release does not free a slot that is still held
    expect(c.count('u')).toBe(1);
    expect(c.acquire('u', 2)).not.toBeNull();
    expect(c.acquire('u', 2)).toBeNull();
  });

  it('heartbeat ends a socket that stops answering pings and keeps one that answers', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const ends: string[] = [];
    wss.on('connection', (ws, req) => {
      heartbeat(ws, 100);
      ws.on('close', () => ends.push(req.url ?? ''));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const silent = new WebSocket(`ws://127.0.0.1:${port}/silent`, { autoPong: false });
    const alive = new WebSocket(`ws://127.0.0.1:${port}/alive`);
    await Promise.all([silent, alive].map((w) => new Promise((resolve) => w.once('open', resolve))));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(ends).toEqual(['/silent']);
    expect(alive.readyState).toBe(WebSocket.OPEN);
    alive.close();
    silent.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

interface Instance {
  server: http.Server;
  hub: StreamHub;
  base: string;
}

async function instance(limits: ConstructorParameters<typeof StreamHub>[0]['limits']): Promise<Instance> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const hub = new StreamHub({ peerUrl: base, limits });
  hub.attach(server);
  hub.start();
  return { server, hub, base };
}

async function closeInstance(i: Instance): Promise<void> {
  await i.hub.stop();
  i.server.closeAllConnections();
  await new Promise<void>((resolve) => i.server.close(() => resolve()));
}

interface Opened {
  ws: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
}

function open(url: string, headers: Record<string, string>): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.once('open', () => resolve({ ws, closed }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

async function status(p: Promise<Opened>): Promise<string> {
  try {
    const o = await p;
    o.ws.close();
    return 'opened';
  } catch (err) {
    return (err as Error).message;
  }
}

async function loginCookie(a: TestAccount): Promise<string> {
  const r = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'correct horse battery' });
  const set = (r.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const c = set.find((s) => s.startsWith('ld_session='));
  if (!c) throw new Error(`login: ${r.status}`);
  return c.split(';')[0]!;
}

describe('WebSocket limits on the remote desktop stream (EXT-2)', () => {
  let I: Instance;
  let Closed: Instance;

  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
    I = await instance({ softPerSecond: 5, hardPerSecond: 20, maxPerSession: 1, maxPerUser: 2 });
    // No upgrade may be in flight from any address: every socket is refused before any lookup.
    Closed = await instance({ maxPendingPerAddress: 0 });
  });
  afterAll(async () => {
    await closeInstance(I);
    await closeInstance(Closed);
    await endpointsModule.lifecycle.stop();
  });

  it('limits upgrades in flight, viewers per session, message size and message rate', async () => {
    const a = await newAccount('ws-guard');
    const { epId } = await onlineEndpoint(a);
    const cookie = await loginCookie(a);
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'WebSocket limits test' });
    expect(start.status).toBe(200);
    const session: string = start.body.session.id;
    const url = (base: string) => `${base.replace(/^http/, 'ws')}/api/v1/endpoints/${epId}/remote-desktop/stream?session=${session}`;
    const headers = { Cookie: cookie, Origin: ORIGIN };

    // Connection count: in-flight upgrades per address, then viewers per session.
    expect(await status(open(url(Closed.base), headers))).toBe('HTTP 429');
    const first = await open(url(I.base), headers);
    expect(await status(open(url(I.base), headers))).toBe('HTTP 429');

    // Message size: above the viewer server's maxPayload the socket ends with 1009.
    first.ws.send('x'.repeat((6 << 20) + 1));
    expect((await first.closed).code).toBe(1009);

    // The slot is free again once that viewer is gone; a flood ends the socket with 1008.
    const second = await open(url(I.base), headers);
    for (let n = 0; n < 50; n++) second.ws.send(JSON.stringify({ t: 'ack', seq: n }));
    expect((await second.closed).code).toBe(1008);
  });
});
