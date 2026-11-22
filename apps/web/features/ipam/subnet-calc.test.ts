// Unit tests of the subnet calculator arithmetic (IPv4 and IPv6). Run with `pnpm --filter
// @lan-detective/web test:unit` (node --test with Node's built-in TypeScript support).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalIp, compareIp, formatCount, formatIp, ipv6ToBig, parseIp, parseSubnet, splitSubnet } from './subnet-calc.ts';

describe('IPv4', () => {
  it('computes a /24', () => {
    const s = parseSubnet('192.168.7.130/24')!;
    assert.equal(formatIp(s.network, 4), '192.168.7.0');
    assert.equal(formatIp(s.first, 4), '192.168.7.1');
    assert.equal(formatIp(s.last, 4), '192.168.7.254');
    assert.equal(formatIp(s.broadcast!, 4), '192.168.7.255');
    assert.equal(s.usable, 254n);
    assert.equal(s.total, 256n);
    assert.equal(s.netmask, '255.255.255.0');
    assert.equal(s.wildcard, '0.0.0.255');
    assert.equal(s.kind, 'private');
  });

  it('accepts a dotted mask and a bare address', () => {
    assert.equal(parseSubnet('10.0.0.1 255.255.252.0')!.prefix, 22);
    assert.equal(parseSubnet('10.0.0.1')!.prefix, 32);
    assert.equal(parseSubnet('10.0.0.1 255.0.255.0'), null); // not contiguous
  });

  it('treats /31 and /32 as all usable, with no broadcast', () => {
    const p2p = parseSubnet('10.0.0.5/31')!;
    assert.equal(p2p.usable, 2n);
    assert.equal(p2p.broadcast, null);
    assert.equal(parseSubnet('10.0.0.5/32')!.usable, 1n);
  });

  it('classifies address spaces', () => {
    assert.equal(parseSubnet('100.64.0.0/10')!.kind, 'cgnat');
    assert.equal(parseSubnet('169.254.0.0/16')!.kind, 'link_local');
    assert.equal(parseSubnet('8.8.8.0/24')!.kind, 'public');
  });

  it('refuses invalid input', () => {
    for (const bad of ['256.1.1.1/24', '10.0.0.0/33', '10.0.0', 'abc', '10.0.0.0/2x']) assert.equal(parseSubnet(bad), null, bad);
  });

  it('splits a subnet', () => {
    const split = splitSubnet(parseSubnet('192.168.0.0/22')!, 24);
    assert.equal(split.count, 4n);
    assert.deepEqual(
      split.items.map((x) => formatIp(x.network, 4)),
      ['192.168.0.0', '192.168.1.0', '192.168.2.0', '192.168.3.0'],
    );
    assert.equal(splitSubnet(parseSubnet('10.0.0.0/8')!, 24, 64).items.length, 64);
    assert.equal(splitSubnet(parseSubnet('10.0.0.0/8')!, 24).count, 65536n);
  });
});

describe('IPv6', () => {
  it('parses every text form to the same value', () => {
    const v = ipv6ToBig('2001:db8::1');
    assert.equal(v, 0x20010db8000000000000000000000001n);
    assert.equal(ipv6ToBig('2001:0DB8:0000:0000:0000:0000:0000:0001'), v);
    assert.equal(ipv6ToBig('2001:db8:0:0::0:1'), v);
    assert.equal(ipv6ToBig('::'), 0n);
    assert.equal(ipv6ToBig('::1'), 1n);
    assert.equal(ipv6ToBig('::ffff:192.0.2.1'), 0xffffc0000201n);
    assert.equal(ipv6ToBig('64:ff9b::192.0.2.1'), 0x0064ff9b0000000000000000c0000201n);
  });

  it('refuses malformed addresses and zone indexes', () => {
    for (const bad of ['2001:db8::1::2', '2001:db8:1:2:3:4:5:6:7', '12345::', 'fe80::1%eth0', 'g::1', '1:2:3:4:5:6:7', ':1:2:3:4:5:6:7', '::1.2.3', '::256.0.0.1']) {
      assert.equal(ipv6ToBig(bad), null, bad);
    }
  });

  it('formats as RFC 5952', () => {
    const f = (t: string) => formatIp(ipv6ToBig(t)!, 6);
    assert.equal(f('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
    assert.equal(f('2001:db8:0:1:0:0:0:1'), '2001:db8:0:1::1'); // the longest zero run
    assert.equal(f('2001:db8:0:0:1:0:0:1'), '2001:db8::1:0:0:1'); // first of two equal runs
    assert.equal(f('2001:db8:0:1:1:1:1:1'), '2001:db8:0:1:1:1:1:1'); // one zero group is not shortened
    assert.equal(f('::'), '::');
    assert.equal(f('::ffff:c000:201'), '::ffff:192.0.2.1');
    assert.equal(f('FE80::ABCD'), 'fe80::abcd');
    assert.equal(canonicalIp(' 2001:DB8::0:5 '), '2001:db8::5');
  });

  it('computes a /64 without enumerating it', () => {
    const s = parseSubnet('2001:db8:1:2:a:b:c:d/64')!;
    assert.equal(s.family, 6);
    assert.equal(formatIp(s.network, 6), '2001:db8:1:2::');
    assert.equal(formatIp(s.end, 6), '2001:db8:1:2:ffff:ffff:ffff:ffff');
    assert.equal(formatIp(s.first, 6), '2001:db8:1:2::1'); // the subnet-router anycast address is set aside
    assert.equal(s.broadcast, null);
    assert.equal(s.wildcard, null);
    assert.equal(s.total, 1n << 64n);
    assert.equal(s.usable, (1n << 64n) - 1n);
    assert.equal(s.netmask, 'ffff:ffff:ffff:ffff::');
    assert.equal(s.kind, 'documentation');
  });

  it('treats /127 and /128 as all usable', () => {
    assert.equal(parseSubnet('2001:db8::/127')!.usable, 2n);
    assert.equal(parseSubnet('2001:db8::5')!.prefix, 128);
    assert.equal(parseSubnet('2001:db8::5/128')!.usable, 1n);
  });

  it('classifies address spaces', () => {
    const kind = (t: string) => parseSubnet(t)!.kind;
    assert.equal(kind('fd12:3456:789a::/48'), 'unique_local');
    assert.equal(kind('fe80::/64'), 'link_local');
    assert.equal(kind('ff02::1'), 'multicast');
    assert.equal(kind('2a00:1450::/32'), 'global');
    assert.equal(kind('2002::/16'), 'reserved'); // 6to4, not a LAN prefix
    assert.equal(kind('3fff::/20'), 'documentation');
    assert.equal(kind('::1'), 'loopback');
    assert.equal(kind('::ffff:10.0.0.0/104'), 'ipv4_mapped');
    assert.equal(kind('fc00::/6'), 'reserved'); // wider than fc00::/7: not entirely unique-local
  });

  it('refuses a dotted mask and a prefix beyond 128', () => {
    assert.equal(parseSubnet('2001:db8::1 255.255.255.0'), null);
    assert.equal(parseSubnet('2001:db8::/129'), null);
  });

  it('splits a /48 into /64s with an exact count', () => {
    const split = splitSubnet(parseSubnet('fd00:1:2::/48')!, 64, 3);
    assert.equal(split.count, 65536n);
    assert.deepEqual(
      split.items.map((x) => `${formatIp(x.network, 6)}/${x.prefix}`),
      ['fd00:1:2::/64', 'fd00:1:2:1::/64', 'fd00:1:2:2::/64'],
    );
    const huge = splitSubnet(parseSubnet('2001:db8::/32')!, 128, 2);
    assert.equal(huge.count, 1n << 96n);
    assert.equal(huge.items.length, 2);
  });

  it('formats large counts', () => {
    assert.deepEqual(formatCount(256n), { digits: '256', power: null });
    assert.deepEqual(formatCount(1n << 64n), { digits: '18,446,744,073,709,551,616', power: 64 });
  });
});

describe('both families', () => {
  it('sorts IPv4 before IPv6, numerically within each', () => {
    const list = ['2001:db8::10', '10.0.0.9', '2001:db8::9', '10.0.0.10', 'fd00::1'];
    assert.deepEqual([...list].sort(compareIp), ['10.0.0.9', '10.0.0.10', '2001:db8::9', '2001:db8::10', 'fd00::1']);
  });

  it('parses either family', () => {
    assert.deepEqual(parseIp('10.1.2.3'), { family: 4, value: 0x0a010203n });
    assert.deepEqual(parseIp('fd00::1'), { family: 6, value: 0xfd000000000000000000000000000001n });
    assert.equal(parseIp('fd00::1/64'), null);
  });
});
