import { gunzipSync } from 'node:zlib';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GZIP_MIN_BYTES, gzipJson } from '../src/common/gzip-json.ts';

// Phase 2 of docs/roadmap/2026-11-28-wan-speed.md: the device page's 342 KB JSON went plain over
// a phone's relayed 4G link every 4 s.
describe('gzipJson', () => {
  const big = { items: Array.from({ length: 400 }, (_, i) => ({ i, name: `process-${i}` })) };
  let base = '';
  let close = () => {};
  beforeAll(async () => {
    const app = express();
    app.use(gzipJson());
    app.get('/big', (_req, res) => void res.json(big));
    app.get('/small', (_req, res) => void res.json({ ok: true }));
    app.get('/text', (_req, res) => void res.type('text/plain').send('x'.repeat(GZIP_MIN_BYTES * 4)));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => srv.close();
  });
  afterAll(() => close());

  const raw = async (path: string, enc?: string) => {
    const { request } = await import('node:http');
    return new Promise<{ headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
      const req = request(`${base}${path}`, { headers: enc ? { 'Accept-Encoding': enc } : {} }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(parts) }));
      });
      req.on('error', reject);
      req.end();
    });
  };

  it('gzips a large JSON answer when the client accepts gzip', async () => {
    const r = await raw('/big', 'gzip, deflate, br');
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(String(r.headers.vary)).toMatch(/Accept-Encoding/i);
    const plain = Buffer.byteLength(JSON.stringify(big));
    expect(r.body.length).toBeLessThan(plain / 3);
    expect(JSON.parse(gunzipSync(r.body).toString())).toEqual(big);
  });

  it('leaves small answers, other types and clients without gzip alone', async () => {
    expect((await raw('/small', 'gzip')).headers['content-encoding']).toBeUndefined();
    expect((await raw('/text', 'gzip')).headers['content-encoding']).toBeUndefined();
    const r = await raw('/big');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(r.body.toString())).toEqual(big);
  });
});
