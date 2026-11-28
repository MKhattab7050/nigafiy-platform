import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.ts';
import { type CliRunner, setCliRunner } from '../src/modules/outside-access/detect.ts';
import { addressesFrom, isPrivateLanIpv4, isTailscaleIpv4, lanAddressesFrom, phoneServerAddresses, resetPhoneAddressCache, setLocalAddressSource } from '../src/modules/outside-access/phone-addresses.ts';

// Owner 2026-11-27: the phone app works away from home through Tailscale. The server hands the phone
// this PC's Tailscale address(es) on the HTTPS listener.

const savedPort = env.HTTPS_PORT;
const noLan = () => ({ ips: [], hostname: '' });
afterEach(() => {
  setCliRunner(null);
  setLocalAddressSource(null);
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
    setLocalAddressSource(noLan);
    const t = fakeTailscale('Running');
    // First call does not wait for the CLI.
    // Not known yet just after the server started: null, so the heartbeat leaves the field out.
    expect(await phoneServerAddresses({ now: 1000 })).toBeNull();
    expect(await phoneServerAddresses({ now: 1000, wait: true })).toEqual(['https://100.101.102.103:47143']);
    const after = t.calls();
    expect(await phoneServerAddresses({ now: 2000 })).toEqual(['https://100.101.102.103:47143']);
    expect(t.calls()).toBe(after);
  });

  it('nothing without Tailscale or before it is signed in', async () => {
    (env as { HTTPS_PORT?: number }).HTTPS_PORT = 47143;
    setLocalAddressSource(noLan);
    fakeTailscale('missing');
    expect(await phoneServerAddresses({ wait: true })).toEqual([]);
    resetPhoneAddressCache();
    fakeTailscale('NeedsLogin');
    expect(await phoneServerAddresses({ wait: true })).toEqual([]);
  });
});

// 1.0.10 at home: the router gave the server PC a new address (.147 → .138) and the PC's own agent,
// which knew only the old one, stayed offline. Every agent now also gets this PC's home network
// addresses and its computer name.
describe('server addresses on the home network', () => {
  it('knows the private ranges', () => {
    for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.1', '192.168.1.138']) expect(isPrivateLanIpv4(ip)).toBe(true);
    for (const ip of ['172.32.0.1', '169.254.1.1', '100.95.99.101', '8.8.8.8', '192.169.1.1', '192.168.1.300', 'fe80::1']) expect(isPrivateLanIpv4(ip)).toBe(false);
  });

  it('lists the private IPv4s then the computer name, on the HTTPS port', () => {
    const local = { ips: ['192.168.1.138', '169.254.183.209', '100.95.99.101', '192.168.1.138', '10.0.0.7'], hostname: 'DESKTOP-U1QD285' };
    expect(lanAddressesFrom(local, 47143)).toEqual(['https://192.168.1.138:47143', 'https://10.0.0.7:47143', 'https://DESKTOP-U1QD285:47143']);
    expect(lanAddressesFrom(local, undefined)).toEqual([]);
    // A name that is not a plain host name is left out.
    expect(lanAddressesFrom({ ips: [], hostname: 'bad name/x' }, 47143)).toEqual([]);
  });

  it('Tailscale first (phones away from home), then the home network', async () => {
    (env as { HTTPS_PORT?: number }).HTTPS_PORT = 47143;
    setLocalAddressSource(() => ({ ips: ['192.168.1.138'], hostname: 'pc1' }));
    fakeTailscale('Running');
    expect(await phoneServerAddresses({ wait: true })).toEqual(['https://100.101.102.103:47143', 'https://192.168.1.138:47143', 'https://pc1:47143']);
    resetPhoneAddressCache();
    fakeTailscale('missing');
    expect(await phoneServerAddresses({ wait: true })).toEqual(['https://192.168.1.138:47143', 'https://pc1:47143']);
  });
});
