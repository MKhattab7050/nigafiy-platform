import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.ts';
import { type CliRunner, setCliRunner } from '../src/modules/outside-access/detect.ts';
import { addressesFrom, isTailscaleIpv4, phoneServerAddresses, resetPhoneAddressCache } from '../src/modules/outside-access/phone-addresses.ts';

// Owner 2026-11-27: the phone app works away from home through Tailscale. The server hands the phone
// this PC's Tailscale address(es) on the HTTPS listener.

const savedPort = env.HTTPS_PORT;
afterEach(() => {
  setCliRunner(null);
  resetPhoneAddressCache();
  (env as { HTTPS_PORT?: number }).HTTPS_PORT = savedPort;
});

function fakeTailscale(state: 'Running' | 'NeedsLogin' | 'missing', ips = ['100.101.102.103', 'fd7a:115c:a1e0::1']) {
  let calls = 0;
  const runner: CliRunner = async (file, args) => {
    calls++;
    if (file !== 'tailscale' || state === 'missing') return { code: -1, stdout: '', stderr: 'ENOENT' };
    if (args[0] === 'version') return { code: 0, stdout: '1.76.1\n', stderr: '' };
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ BackendState: state, Self: { DNSName: 'pc.tail1.ts.net.', TailscaleIPs: ips } }), stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  };
  setCliRunner(runner);
  return { calls: () => calls };
}

describe('phone server addresses (Tailscale)', () => {
  it('knows the Tailscale range', () => {
    expect(isTailscaleIpv4('100.64.0.1')).toBe(true);
    expect(isTailscaleIpv4('100.127.255.254')).toBe(true);
    expect(isTailscaleIpv4('100.63.0.1')).toBe(false);
    expect(isTailscaleIpv4('100.128.0.1')).toBe(false);
    expect(isTailscaleIpv4('192.168.1.5')).toBe(false);
    expect(isTailscaleIpv4('100.300.0.1')).toBe(false);
    expect(isTailscaleIpv4('fd7a:115c:a1e0::1')).toBe(false);
  });

  it('gives https://<tailscale ip>:<HTTPS_PORT> only when Tailscale runs and HTTPS is on', () => {
    expect(addressesFrom({ state: 'Running', ips: ['100.101.102.103', 'fd7a::1'] }, 47143)).toEqual(['https://100.101.102.103:47143']);
    expect(addressesFrom({ state: 'NeedsLogin', ips: ['100.101.102.103'] }, 47143)).toEqual([]);
    expect(addressesFrom({ state: 'Running', ips: ['100.101.102.103'] }, undefined)).toEqual([]);
  });

  it('reads the CLI in the background, then serves the cached answer', async () => {
    (env as { HTTPS_PORT?: number }).HTTPS_PORT = 47143;
    const t = fakeTailscale('Running');
    // First call does not wait for the CLI.
    expect(await phoneServerAddresses({ now: 1000 })).toEqual([]);
    expect(await phoneServerAddresses({ now: 1000, wait: true })).toEqual(['https://100.101.102.103:47143']);
    const after = t.calls();
    expect(await phoneServerAddresses({ now: 2000 })).toEqual(['https://100.101.102.103:47143']);
    expect(t.calls()).toBe(after);
  });

  it('nothing without Tailscale or before it is signed in', async () => {
    (env as { HTTPS_PORT?: number }).HTTPS_PORT = 47143;
    fakeTailscale('missing');
    expect(await phoneServerAddresses({ wait: true })).toEqual([]);
    resetPhoneAddressCache();
    fakeTailscale('NeedsLogin');
    expect(await phoneServerAddresses({ wait: true })).toEqual([]);
  });
});
