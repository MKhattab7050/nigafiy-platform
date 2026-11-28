// A large transfer against the compiled Windows agent, the way the web transfer engine drives it:
// 1 MiB pieces through the API, the agent killed and restarted half way, then the upload resumes
// from what the agent remembers and is checked end to end. Opt in with NIGAFIY_UI_TEST=1 after
// `pnpm build:agent`.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { CSRF, app, newAccount } from './helpers.ts';

const binPath = path.resolve(import.meta.dirname, '../../../agents/endpoint-agent/bin', 'nigafiy-agent.exe');
const MiB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe.skipIf(process.platform !== 'win32' || !existsSync(binPath) || process.env.NIGAFIY_UI_TEST !== '1')('large file transfer with the real agent', () => {
  // Queued commands wake the agent's held poll at once, as on a running server.
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it(
    'uploads 24 MiB in 1 MiB pieces, survives an agent restart mid way, walks the folder and downloads it back with per-piece checks',
    async () => {
      const srv = http.createServer(app);
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const serverUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ld-xfer-state-'));
      const work = mkdtempSync(path.join(os.tmpdir(), 'ld-xfer-fs-'));
      let child: ReturnType<typeof spawn> | null = null;
      try {
        const a = await newAccount('real-xfer');
        const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Transfer host', platform: 'windows' });
        expect(created.status).toBe(201);
        const epId: string = created.body.endpoint.id;
        const token: string = created.body.enrollment_token;

        const start = () => {
          child = spawn(binPath, ['-server', serverUrl, '-allow-insecure-http', '-token', token, '-state-dir', stateDir, '-log-level', 'warn'], { stdio: 'ignore' });
        };
        const stop = async () => {
          const c = child as ReturnType<typeof spawn> | null;
          if (!c) return;
          const gone = new Promise((r) => c.once('exit', r));
          c.kill();
          await gone;
          child = null;
        };
        const online = async () => {
          const deadline = Date.now() + 25_000;
          while (Date.now() < deadline) {
            const d = (await a.agent.get(`/api/v1/endpoints/${epId}`)).body;
            if (d.connection_state === 'online') {
              // A ping proves this process is the one answering, not a stale "online".
              const r = await fs({ op: 'roots' }).catch(() => null);
              if (r) return;
            }
            await new Promise((r) => setTimeout(r, 300));
          }
          throw new Error('agent did not come online');
        };
        let lastId = '';
        const fs = async (payload: Record<string, unknown>) => {
          const res = await a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=6000`).set(CSRF).send({ kind: 'fs_op', ...payload });
          if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
          let body = res.body;
          while (body.status !== 'completed' && body.status !== 'failed') {
            const w = await a.agent.get(`/api/v1/endpoints/${epId}/commands/${body.id}?wait_ms=20000`);
            expect(w.status).toBe(200);
            body = w.body;
          }
          if (body.status === 'failed') throw new Error(`${payload.op} failed: ${body.error_message ?? JSON.stringify(body)}`);
          lastId = body.id;
          return body.result_data;
        };

        start();
        await online();

        // 1. Upload in 1 MiB pieces; stop after 10 pieces, as if the PC rebooted.
        const data = randomBytes(24 * MiB);
        const dest = path.join(work, 'up', 'big.bin');
        mkdirSync(path.dirname(dest));
        const running = createHash('sha256');
        for (let off = 0; off < 10 * MiB; off += MiB) {
          const piece = data.subarray(off, off + MiB);
          running.update(piece);
          await fs({ op: 'upload', path: dest, offset: off, append: off > 0, data_base64: piece.toString('base64') });
        }
        await stop();
        start();
        await online();

        // 2. The restarted agent still knows where the upload stopped.
        const st = await fs({ op: 'hash', path: dest, size_only: true });
        expect(st.total_size).toBe(10 * MiB);
        expect(st.upload_next).toBe(10 * MiB);
        for (let off = 10 * MiB; off < data.length; off += MiB) {
          const piece = data.subarray(off, off + MiB);
          running.update(piece);
          const last = off + MiB >= data.length;
          await fs({ op: 'upload', path: dest, offset: off, append: true, data_base64: piece.toString('base64'), ...(last ? { expected_sha256: running.copy().digest('hex') } : {}) });
        }
        expect(sha(readFileSync(dest))).toBe(sha(data));

        // A wrong final checksum is refused, never accepted silently.
        const bad = path.join(work, 'up', 'bad.bin');
        await expect(fs({ op: 'upload', path: bad, offset: 0, data_base64: Buffer.from('abc').toString('base64'), expected_sha256: '0'.repeat(64) })).rejects.toThrow();

        // 3. A folder tree comes back whole in one walk, folders first.
        writeFileSync(path.join(work, 'up', 'note.txt'), 'hi');
        mkdirSync(path.join(work, 'up', 'sub', 'deeper'), { recursive: true });
        writeFileSync(path.join(work, 'up', 'sub', 'deeper', 'x.txt'), 'x');
        const walk = await fs({ op: 'walk', path: path.join(work, 'up') });
        expect(walk.total_files).toBe(3);
        expect(walk.total_dirs).toBe(2);
        const names = walk.entries.map((e: { path: string }) => path.relative(path.join(work, 'up'), e.path));
        expect(names.indexOf('sub')).toBeLessThan(names.indexOf(path.join('sub', 'deeper', 'x.txt')));

        // 4. Download it back in 1 MiB pieces; each carries its own checksum and the file's time.
        const t0 = Date.now();
        const parts: Buffer[] = [];
        let mod = '';
        for (let off = 0; off < data.length; off += MiB) {
          const r = await fs({ op: 'download', path: dest, offset: off, length: MiB });
          const piece = Buffer.from(r.data_base64, 'base64');
          expect(piece.length).toBe(MiB);
          expect(r.chunk_sha256).toBe(sha(piece));
          if (mod) expect(r.mod_time).toBe(mod);
          mod = r.mod_time;
          parts.push(piece);
        }
        expect(sha(Buffer.concat(parts))).toBe(sha(data));
        // A command round trip is milliseconds here, so 24 pieces one after another are quick.
        const oldMs = Date.now() - t0;
        expect(oldMs).toBeLessThan(30_000);

        // 5. The same through the binary side channel (the agent announced fs_relay in its poll):
        // the bytes never sit in a command as base64. Measured one piece at a time, as the slowest case.
        const raw = async (method: 'get' | 'post', url: string, body?: Buffer) => {
          const r0 = method === 'get' ? a.agent.get(url) : a.agent.post(url).set(CSRF).set('Content-Type', 'application/octet-stream').send(body);
          return r0.buffer(true).parse((res, cb) => {
            const bufs: Buffer[] = [];
            res.on('data', (c: Buffer) => bufs.push(c));
            res.on('end', () => cb(null, Buffer.concat(bufs)));
          });
        };
        const t1 = Date.now();
        const back: Buffer[] = [];
        for (let off = 0; off < data.length; off += MiB) {
          const r = await fs({ op: 'download', path: dest, offset: off, length: MiB, relay: true });
          expect(r.relayed).toBe(true);
          expect(r.data_base64).toBeUndefined();
          const got = await raw('get', `/api/v1/endpoints/${epId}/commands/${lastId}/data`);
          expect(got.status).toBe(200);
          const piece = got.body as Buffer;
          expect(r.chunk_sha256).toBe(sha(piece));
          back.push(piece);
        }
        const relayDownMs = Date.now() - t1;
        expect(sha(Buffer.concat(back))).toBe(sha(data));

        const dest2 = path.join(work, 'up', 'big2.bin');
        const t2 = Date.now();
        const running2 = createHash('sha256');
        for (let off = 0; off < data.length; off += MiB) {
          const p = data.subarray(off, off + MiB);
          running2.update(p);
          const last = off + MiB >= data.length;
          const stored = await raw('post', `/api/v1/endpoints/${epId}/file-data`, p);
          expect(stored.status).toBe(201);
          const { id } = JSON.parse((stored.body as Buffer).toString('utf8')) as { id: string };
          await fs({ op: 'upload', path: dest2, offset: off, append: off > 0, data_ref: id, ...(last ? { expected_sha256: running2.copy().digest('hex') } : {}) });
        }
        const relayUpMs = Date.now() - t2;
        expect(sha(readFileSync(dest2))).toBe(sha(data));

        // As the web engine reads: three pieces in flight.
        const t3 = Date.now();
        const piecesIn: Buffer[] = new Array(data.length / MiB);
        let nextOff = 0;
        const lane = async () => {
          while (nextOff < data.length) {
            const off = nextOff;
            nextOff += MiB;
            const res = await a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=6000`).set(CSRF).send({ kind: 'fs_op', op: 'download', path: dest, offset: off, length: MiB, relay: true });
            let body = res.body;
            while (body.status !== 'completed' && body.status !== 'failed') body = (await a.agent.get(`/api/v1/endpoints/${epId}/commands/${body.id}?wait_ms=20000`)).body;
            expect(body.result_data?.relayed).toBe(true);
            piecesIn[off / MiB] = (await raw('get', `/api/v1/endpoints/${epId}/commands/${body.id}/data`)).body as Buffer;
          }
        };
        await Promise.all([lane(), lane(), lane()]);
        const pipeMs = Date.now() - t3;
        expect(sha(Buffer.concat(piecesIn))).toBe(sha(data));

        const mbps = (ms: number) => Math.round(((data.length / MiB) * 1000 * 10) / ms) / 10;
        const speedLine = (
          `[transfer speed] 24 MiB, one piece at a time: base64 download ${mbps(oldMs)} MB/s, relay download ${mbps(relayDownMs)} MB/s, relay upload ${mbps(relayUpMs)} MB/s; relay download, 3 in flight: ${mbps(pipeMs)} MB/s`
        );
        console.log(speedLine);
        if (process.env.NIGAFIY_SPEED_OUT) writeFileSync(process.env.NIGAFIY_SPEED_OUT, `${speedLine}
`, { flag: 'a' });
        expect(mbps(relayDownMs)).toBeGreaterThan(mbps(oldMs));
        expect(mbps(pipeMs)).toBeGreaterThanOrEqual(20);
      } finally {
        if (child) (child as ReturnType<typeof spawn>).kill();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        try {
          rmSync(stateDir, { recursive: true, force: true });
          rmSync(work, { recursive: true, force: true });
        } catch {
          // ignore cleanup lock
        }
      }
    },
    180_000,
  );
});
