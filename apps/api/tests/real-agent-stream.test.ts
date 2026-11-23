import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readEnv } from '../src/config/env-compat.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { StreamHub, frameMeta } from '../src/modules/endpoints/remote-desktop/stream-hub.ts';
import { CSRF, app, newAccount } from './helpers.ts';

const binPath = path.resolve(import.meta.dirname, '../../../agents/endpoint-agent/bin', process.platform === 'win32' ? 'nigafiy-agent.exe' : 'nigafiy-agent');

// The compiled Go agent on this Windows desktop, live stream end to end: real screen capture,
// real tile encoding, the real session banner (it appears top-centre for a few seconds), the real
// WebSocket hub. Input and clipboard are not sent here: they would move the mouse and replace the
// clipboard of the person using this computer (both are covered by Go tests and fleet-stream.test.ts).
//
// Twice: the agent in the foreground (desktop work in its own process), and `nigafiy-agent run`
// (the service's mode: every capture, the banner and the stream's frames go through a real session
// helper process, `nigafiy-agent session-helper`, over its stdin/stdout pipes).
describe.skipIf(process.platform !== 'win32' || !existsSync(binPath))('real Go agent: live stream over WebSocket (run `pnpm build:agent` first)', () => {
  it.each([
    { mode: 'foreground', args: [] as string[], desktopMode: 'local' },
    { mode: 'run (session helper)', args: ['run'], desktopMode: 'session_helper' },
  ])(
    '$mode: opens the session banner, connects its stream and sends real tile-encoded frames, then closes on stop',
    async ({ args, desktopMode }) => {
      await endpointsModule.lifecycle.start();
      const srv = http.createServer(app);
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const { port } = srv.address() as AddressInfo;
      const serverUrl = `http://127.0.0.1:${port}`;
      const hub = new StreamHub({ peerUrl: serverUrl });
      hub.attach(srv);
      hub.start();
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ld-agent-stream-'));
      let child: ReturnType<typeof spawn> | null = null;
      const logs: string[] = [];
      try {
        const a = await newAccount('real-stream');
        const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Real stream host', platform: 'windows' });
        const epId: string = created.body.endpoint.id;
        child = spawn(binPath, [...args, '-server', serverUrl, '-allow-insecure-http', '-token', created.body.enrollment_token, '-state-dir', stateDir, '-log-level', 'info'], { stdio: 'pipe' });
        child.stdout?.on('data', (d) => logs.push(String(d)));
        child.stderr?.on('data', (d) => logs.push(String(d)));

        const deadline = Date.now() + 25_000;
        for (;;) {
          const d = (await a.agent.get(`/api/v1/endpoints/${epId}`)).body;
          if (d.connection_state === 'online') break;
          if (Date.now() > deadline) throw new Error(`agent never came online:\n${logs.join('')}`);
          await new Promise((r) => setTimeout(r, 300));
        }

        const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Nigafiy live stream test', quality: 60, scale: 0.5 });
        expect(start.status).toBe(200);
        const session: string = start.body.session.id;

        // The agent shows the banner and connects its socket (long poll delivers rd_session_open at once).
        const until = Date.now() + 20_000;
        let fs: Record<string, unknown> | undefined;
        for (;;) {
          // One read for both, so the row (transport) and the connection state agree.
          const body = (await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`)).body;
          fs = body.fleet_session;
          if (fs?.banner_state !== 'pending' && body.stream_connected && fs?.transport === 'ws') break;
          if (Date.now() > until) throw new Error(`stream never connected: ${JSON.stringify(fs)}\n${logs.join('')}`);
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(fs?.banner_state).toBe('shown');
        expect(fs?.transport).toBe('ws');

        const login = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'correct horse battery' });
        const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ld_session='))!.split(';')[0]!;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/endpoints/${epId}/remote-desktop/stream?session=${session}`, { headers: { Cookie: cookie, Origin: 'http://localhost:3100' } });
        const frames: Buffer[] = [];
        const texts: Array<Record<string, unknown>> = [];
        let closed: number | null = null;
        ws.on('message', (data, bin) => {
          const b = data as Buffer;
          if (bin) {
            frames.push(b);
            const m = frameMeta(b);
            if (m) ws.send(JSON.stringify({ t: 'ack', seq: m.seq }));
          } else texts.push(JSON.parse(b.toString('utf8')));
        });
        ws.on('close', (code) => (closed = code));
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', reject);
        });

        const t0 = Date.now();
        while ((frames.length < 1 || !texts.some((m) => m.t === 'stats')) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 100));
        expect(frames.length).toBeGreaterThan(0);
        const first = frames[0]!;
        const meta = frameMeta(first);
        expect(meta?.full).toBe(true);
        const hlen = first.readUInt32BE(2);
        const header = JSON.parse(first.subarray(6, 6 + hlen).toString('utf8'));
        expect(header.w).toBeGreaterThan(0);
        expect(header.tiles.length).toBeGreaterThan(0);
        // Each tile is a real JPEG.
        const tile0 = first.subarray(6 + hlen, 6 + hlen + header.tiles[0].n);
        expect(tile0[0]).toBe(0xff);
        expect(tile0[1]).toBe(0xd8);
        const hello = texts.find((m) => m.t === 'hello');
        expect(hello?.encoder).toBe('jpeg');
        expect((hello?.desktop as { mode?: string } | undefined)?.mode).toBe(desktopMode);
        const stats = texts.find((m) => m.t === 'stats');
        expect(stats).toBeDefined();
        console.info(
          `[real stream, ${desktopMode}] ${header.sw}x${header.sh} → ${header.w}x${header.h}, ${header.tiles.length} tile(s), first packet ${first.length} bytes, mode ${header.mode}, frames ${frames.length}, stats ${JSON.stringify(stats)}`,
        );

        await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
        const t1 = Date.now();
        while (closed === null && Date.now() - t1 < 5_000) await new Promise((r) => setTimeout(r, 100));
        expect(closed).toBe(4000);
        const row = (await systemPool.query(`SELECT frames_relayed, bytes_relayed, end_reason FROM fleet_sessions WHERE public_id = $1`, [session])).rows[0];
        expect(Number(row.frames_relayed)).toBeGreaterThan(0);
        expect(row.end_reason).toBe('operator');
      } finally {
        if (readEnv('NIGAFIY_TEST_AGENT_LOGS')) console.info(logs.join(''));
        child?.kill();
        await hub.stop();
        srv.closeAllConnections();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        await endpointsModule.lifecycle.stop();
        try {
          rmSync(stateDir, { recursive: true, force: true });
        } catch {
          /* Windows may hold the state dir briefly */
        }
      }
    },
    90_000,
  );
});
