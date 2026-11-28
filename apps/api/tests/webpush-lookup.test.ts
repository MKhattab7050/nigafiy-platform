import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinnedLookup } from '../src/modules/notifications/webpush.ts';

// Audit item 6 (2026-11-27): the push transport pins the address it already checked through a
// custom `lookup`. Node 20+ asks that lookup with { all: true } (autoSelectFamily) and wants a
// list; the old one answered a single string and every push failed on Node 24. Real sockets here.

let server: net.Server;
let port: number;

beforeAll(async () => {
  server = net.createServer((s) => s.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connect(autoSelectFamily: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    // The name never reaches DNS: the pinned lookup answers it.
    const s = net.connect({ host: 'push.example.invalid', port, autoSelectFamily, lookup: pinnedLookup({ address: '127.0.0.1', family: 4 }) as never });
    s.once('connect', () => {
      const addr = s.remoteAddress ?? '';
      s.destroy();
      resolve(addr);
    });
    s.once('error', reject);
  });
}

describe('web push pinned lookup', () => {
  it('connects with autoSelectFamily (the Node 20+ default, asks for all addresses)', async () => {
    expect(await connect(true)).toBe('127.0.0.1');
  });

  it('connects the classic way too (one address)', async () => {
    expect(await connect(false)).toBe('127.0.0.1');
  });

  it('answers both shapes', () => {
    const lookup = pinnedLookup({ address: '203.0.113.7', family: 4 });
    const got: unknown[] = [];
    lookup('x', { all: true }, (_e, a) => got.push(a));
    lookup('x', {}, (_e, a, f) => got.push([a, f]));
    lookup('x', 4, (_e, a, f) => got.push([a, f]));
    expect(got).toEqual([[{ address: '203.0.113.7', family: 4 }], ['203.0.113.7', 4], ['203.0.113.7', 4]]);
  });
});
