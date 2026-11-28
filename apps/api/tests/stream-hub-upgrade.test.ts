import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StreamHub } from '../src/modules/endpoints/remote-desktop/stream-hub.ts';

// Audit item 2 (2026-11-27): the 'upgrade' listener runs outside Express, so a request line
// `new URL` cannot read used to throw out of it and end the API. It is answered with 400 now.

let server: http.Server;
let hub: StreamHub;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end('alive'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  hub = new StreamHub({ peerUrl: `http://127.0.0.1:${port}` });
  hub.attach(server);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function rawUpgrade(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => (out += d.toString('utf8')));
    s.on('close', () => resolve(out));
    s.on('error', reject);
    s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  });
}

describe('stream hub upgrade', () => {
  it('answers an address it cannot read with 400 and keeps serving', async () => {
    const reply = await rawUpgrade('//[x');
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect(reply).toContain('bad_request');
    const again = await fetch(`http://127.0.0.1:${port}/`);
    expect(await again.text()).toBe('alive');
  });

  it('still answers an unknown path with 404', async () => {
    expect(await rawUpgrade('/nothing-here')).toMatch(/^HTTP\/1\.1 404 /);
  });
});
