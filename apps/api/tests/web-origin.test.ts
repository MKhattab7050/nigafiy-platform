import { describe, expect, it } from 'vitest';
import { env, isWebOrigin } from '../src/config/env.ts';

const base = { ...env, WEB_ORIGIN: 'http://localhost:3100', WEB_EXTRA_ORIGINS: ['http://box.lan:3100'] };
const own = () => new Set(['192.168.1.147']);

describe('isWebOrigin', () => {
  it('accepts WEB_ORIGIN and the extra origins', () => {
    expect(isWebOrigin('http://localhost:3100', base, own)).toBe(true);
    expect(isWebOrigin('http://box.lan:3100', base, own)).toBe(true);
  });
  it("accepts the web app's port on this machine's own LAN address", () => {
    expect(isWebOrigin('http://192.168.1.147:3100', base, own)).toBe(true);
  });
  it('accepts the other loopback names for this machine on the same scheme and port', () => {
    expect(isWebOrigin('http://127.0.0.1:3100', base, own)).toBe(true);
    expect(isWebOrigin('http://[::1]:3100', base, own)).toBe(true);
    const installed = { ...base, WEB_ORIGIN: 'http://127.0.0.1:47130' };
    expect(isWebOrigin('http://localhost:47130', installed, own)).toBe(true);
    expect(isWebOrigin('http://localhost:3100', installed, own)).toBe(false);
    expect(isWebOrigin('https://localhost:47130', installed, own)).toBe(false);
  });
  it('does not treat loopback names as aliases when WEB_ORIGIN is not on loopback', () => {
    const lan = { ...base, WEB_ORIGIN: 'http://box.lan:3100', WEB_EXTRA_ORIGINS: [] };
    expect(isWebOrigin('http://localhost:3100', lan, own)).toBe(false);
  });
  it('refuses other hosts, other ports, other schemes and malformed origins', () => {
    expect(isWebOrigin('http://192.168.1.50:3100', base, own)).toBe(false);
    expect(isWebOrigin('http://192.168.1.147:4100', base, own)).toBe(false);
    expect(isWebOrigin('https://192.168.1.147:3100', base, own)).toBe(false);
    expect(isWebOrigin('http://192.168.1.147:3100/x', base, own)).toBe(false);
    expect(isWebOrigin('null', base, own)).toBe(false);
    expect(isWebOrigin(undefined, base, own)).toBe(false);
  });
});
