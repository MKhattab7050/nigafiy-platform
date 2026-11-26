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
  it('refuses other hosts, other ports, other schemes and malformed origins', () => {
    expect(isWebOrigin('http://192.168.1.50:3100', base, own)).toBe(false);
    expect(isWebOrigin('http://192.168.1.147:4100', base, own)).toBe(false);
    expect(isWebOrigin('https://192.168.1.147:3100', base, own)).toBe(false);
    expect(isWebOrigin('http://192.168.1.147:3100/x', base, own)).toBe(false);
    expect(isWebOrigin('null', base, own)).toBe(false);
    expect(isWebOrigin(undefined, base, own)).toBe(false);
  });
});
