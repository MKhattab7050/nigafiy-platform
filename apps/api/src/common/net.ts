import { createRequire } from 'node:module';
import ipaddr from 'ipaddr.js';
import { env } from '../config/env.ts';

const require = createRequire(import.meta.url);
// IEEE OUI registry (MA-L assignments), shipped as data by the `oui-data` package.
const OUI: Record<string, string> = require('oui-data');

export const MAX_SCOPE_HOSTS_PREFIX = 20; // largest authorizable IPv4 scope: /20 (4096 addresses)
/** Largest authorizable IPv6 scope: a /48 (one site). An IPv6 LAN is normally a /64. */
export const MAX_SCOPE_IPV6_PREFIX = 48;
/**
 * The shortest IPv6 prefix whose addresses may be probed one by one: a /120 (256 addresses, like an
 * IPv4 /24). A /64 holds 2^64 addresses and can never be swept; IPv6 discovery reads the collector
 * host's neighbour table and sends one echo request to the link's all-nodes group (ff02::1) instead.
 */
export const IPV6_SWEEP_MIN_PREFIX = 120;

export function isIPv4(value: string): boolean {
  return ipaddr.IPv4.isValidFourPartDecimal(value);
}

/** A plain IPv6 address (no interface zone, no brackets, not an IPv4 dotted quad). */
export function isIPv6(value: string): boolean {
  return value.length <= 45 && value.includes(':') && /^[0-9A-Fa-f:.]+$/.test(value) && ipaddr.IPv6.isValid(value);
}

export function isIP(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

/** Canonical text of an address (RFC 5952 for IPv6, the form PostgreSQL's host() returns). */
export function canonicalIp(value: string): string {
  return ipaddr.parse(value).toString();
}

export interface ScopeValidation {
  ok: boolean;
  cidr?: string;
  reason?: string;
  /** Machine-readable reason, so the web app can show it in Arabic too. */
  code?: 'invalid_cidr' | 'too_large' | 'not_private' | 'ipv6_too_large' | 'ipv6_not_lan' | 'ipv6_mapped';
}

export type DiscoveryMethod = 'sweep' | 'neighbor';

/** How a scope is discovered: every address probed (IPv4, IPv6 /120 or longer) or neighbour table + multicast echo (larger IPv6). */
export function discoveryMethod(cidr: string): DiscoveryMethod {
  const [addr, prefix] = ipaddr.parseCIDR(cidr);
  return addr.kind() === 'ipv6' && prefix < IPV6_SWEEP_MIN_PREFIX ? 'neighbor' : 'sweep';
}

/**
 * A scope is only accepted when it is
 *  - IPv4: an RFC 1918 private range (or loopback in dev/test) no larger than /20;
 *  - IPv6: a LAN prefix (unique-local fc00::/7, link-local fe80::/10 or global unicast) no larger
 *    than /48 (::1/128 in dev/test). Tunnelling and translation (6to4, Teredo, NAT64), documentation,
 *    multicast and the other special-purpose ranges are refused.
 * This is a hard guard against pointing a collector at address space the customer cannot own. The
 * collector applies the same rules again (collectors/lan-collector/internal/scope).
 */
export function validateScope(input: string): ScopeValidation {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  let prefix: number;
  const raw = input.trim();
  try {
    if (raw.includes('%')) throw new Error('zone');
    [addr, prefix] = ipaddr.parseCIDR(raw);
  } catch {
    return { ok: false, code: 'invalid_cidr', reason: 'Not a valid CIDR range (examples: 192.168.1.0/24, fd12:3456:789a:1::/64)' };
  }
  if (addr.kind() === 'ipv6') return validateScope6(addr as ipaddr.IPv6, prefix);
  if (prefix < MAX_SCOPE_HOSTS_PREFIX) return { ok: false, code: 'too_large', reason: `Scope is too large: the maximum size is /${MAX_SCOPE_HOSTS_PREFIX} (4096 addresses)` };
  const v4 = addr as ipaddr.IPv4;
  const network = ipaddr.IPv4.networkAddressFromCIDR(`${v4.toString()}/${prefix}`);
  const range = network.range();
  const allowed = range === 'private' || (range === 'loopback' && env.ALLOW_LOOPBACK_SCOPES);
  if (!allowed) return { ok: false, code: 'not_private', reason: 'Only private (RFC 1918) address ranges can be monitored: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16' };
  return { ok: true, cidr: `${network.toString()}/${prefix}` };
}

/**
 * IPv6 address classes, defined by explicit prefixes so the collector can apply exactly the same
 * table (collectors/lan-collector/internal/scope/ipv6.go):
 *   loopback ::1, link_local fe80::/10 (RFC 4291), unique_local fc00::/7 (RFC 4193),
 *   global: global unicast 2000::/3 (RFC 3587) minus the special-purpose blocks inside it,
 *   other: everything else (unspecified, multicast, IPv4-mapped / translated, special purpose).
 */
export type IPv6Class = 'loopback' | 'link_local' | 'unique_local' | 'global' | 'other';

const V6_SPECIAL_IN_GLOBAL: [ipaddr.IPv6, number][] = [
  '2001::/23', // IETF protocol assignments (RFC 2928): Teredo 2001::/32, benchmarking, ORCHID, AMT…
  '2001:db8::/32', // documentation (RFC 3849)
  '2002::/16', // 6to4 relays (RFC 3056)
  '2620:4f:8000::/48', // AS112 (RFC 7534)
  '3fff::/20', // documentation (RFC 9637)
].map((c) => ipaddr.IPv6.parseCIDR(c));

export function ipv6Class(addr: ipaddr.IPv6): IPv6Class {
  if (addr.isIPv4MappedAddress()) return 'other';
  const first = addr.parts[0]!;
  if (addr.parts.every((p, i) => p === (i === 7 ? 1 : 0))) return 'loopback';
  if ((first & 0xffc0) === 0xfe80) return 'link_local';
  if ((first & 0xfe00) === 0xfc00) return 'unique_local';
  if ((first & 0xe000) === 0x2000) return V6_SPECIAL_IN_GLOBAL.some((r) => addr.match(r)) ? 'other' : 'global';
  return 'other';
}

/** Where an observed address lives: an IPv4 address, or the IPv6 class (link-local addresses are only meaningful on one link). */
export type AddressScope = 'ipv4' | 'link_local' | 'unique_local' | 'global' | 'other';
export function addressScope(ip: string): AddressScope {
  const a = ipaddr.parse(ip);
  if (a.kind() === 'ipv4') return 'ipv4';
  const c = ipv6Class(a as ipaddr.IPv6);
  return c === 'loopback' ? 'other' : c;
}

/** Orders addresses: IPv4 before IPv6, then numerically. */
export function compareIp(a: string, b: string): number {
  const x = ipaddr.parse(a).toByteArray();
  const y = ipaddr.parse(b).toByteArray();
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

function validateScope6(addr: ipaddr.IPv6, prefix: number): ScopeValidation {
  if (addr.isIPv4MappedAddress()) return { ok: false, code: 'ipv6_mapped', reason: 'IPv4-mapped IPv6 ranges are not scopes: authorize the IPv4 range instead' };
  const network = ipaddr.IPv6.networkAddressFromCIDR(`${addr.toString()}/${prefix}`);
  const cidr = `${network.toString()}/${prefix}`;
  const cls = ipv6Class(network);
  if (cls === 'loopback' && prefix === 128 && env.ALLOW_LOOPBACK_SCOPES) return { ok: true, cidr };
  if (prefix < MAX_SCOPE_IPV6_PREFIX) {
    return { ok: false, code: 'ipv6_too_large', reason: `IPv6 scope is too large: the maximum size is /${MAX_SCOPE_IPV6_PREFIX} (one site); a LAN is normally a /64` };
  }
  // Every class boundary is a /23 or shorter except AS112 (/48), so a /48-or-longer prefix lies inside
  // exactly one class: the class of its network address.
  if (cls !== 'unique_local' && cls !== 'link_local' && cls !== 'global') {
    return {
      ok: false,
      code: 'ipv6_not_lan',
      reason: 'Only IPv6 LAN prefixes can be monitored: unique-local (fc00::/7), link-local (fe80::/10) or global unicast (2000::/3); tunnelling, translation, documentation, multicast and other special-purpose ranges are refused',
    };
  }
  return { ok: true, cidr };
}

/** Whether ip lies inside cidr. Family-aware: an IPv4 address is never inside an IPv6 range, and vice versa. */
export function cidrContains(cidr: string, ip: string): boolean {
  try {
    const range = ipaddr.parseCIDR(cidr);
    const addr = ipaddr.parse(ip);
    if (addr.kind() !== range[0].kind()) return false;
    return addr.match(range);
  } catch {
    return false;
  }
}

/**
 * How an address may be used as an active probe target (toolbox, monitoring and watch checks). The
 * collector applies the same classes (internal/tools/scope.go, internal/watch/guard.go):
 *  - refused:  never a target: unspecified, broadcast, multicast, reserved, IPv4-mapped, tunnelling /
 *              translation prefixes, and IPv6 link-local (it only means something on one interface,
 *              so a probe could reach another machine than the one intended);
 *  - local:    private kind (RFC 1918, CGNAT, IPv4 link-local, IPv6 unique-local): must be inside a scope;
 *  - loopback: only with ALLOW_LOOPBACK_SCOPES, inside a scope;
 *  - global:   public / global unicast. Inside a scope it is a LAN address; outside every scope it is
 *              treated as a public internet address.
 */
export type TargetClass = { kind: 'refused'; reason: string } | { kind: 'local' | 'loopback' | 'global'; family: 4 | 6 };

export function classifyTarget(ip: string): TargetClass {
  if (isIPv4(ip)) {
    const range = ipaddr.IPv4.parse(ip).range();
    if (['unspecified', 'broadcast', 'multicast', 'reserved'].includes(range)) return { kind: 'refused', reason: 'unspecified, broadcast, multicast or reserved' };
    if (range === 'loopback') return { kind: 'loopback', family: 4 };
    if (range === 'private' || range === 'linkLocal' || range === 'carrierGradeNat') return { kind: 'local', family: 4 };
    return { kind: 'global', family: 4 };
  }
  if (!isIPv6(ip)) return { kind: 'refused', reason: 'not an IP address' };
  switch (ipv6Class(ipaddr.IPv6.parse(ip))) {
    case 'loopback':
      return { kind: 'loopback', family: 6 };
    case 'unique_local':
      return { kind: 'local', family: 6 };
    case 'global':
      return { kind: 'global', family: 6 };
    case 'link_local':
      return { kind: 'refused', reason: "an IPv6 link-local address (fe80::/10) only has a meaning on one interface: use the device's unique-local or global address" };
    default:
      return { kind: 'refused', reason: 'unspecified, multicast, IPv4-mapped, tunnelling / translation, documentation or other special-purpose IPv6 address' };
  }
}

export function normalizeMac(mac: string): string {
  return mac.toLowerCase().replaceAll('-', ':');
}

/** Locally administered bit set → not a manufacturer-assigned address (typically OS MAC randomization or a VM). */
export function isLocallyAdministeredMac(mac: string): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0;
}

/** Vendor from the IEEE OUI registry, or null. Never guessed. */
export function vendorForMac(mac: string): string | null {
  if (isLocallyAdministeredMac(mac)) return null;
  const entry = OUI[mac.replaceAll(':', '').slice(0, 6).toUpperCase()];
  if (!entry) return null;
  return entry.split('\n')[0]?.trim() || null;
}

/** For outbound webhooks: is this address something on our own/internal network? */
export function isPublicAddress(address: string): boolean {
  try {
    let addr = ipaddr.parse(address);
    if (addr.kind() === 'ipv6') {
      const v6 = addr as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) {
        addr = v6.toIPv4Address();
      } else {
        const bytes = v6.toByteArray();
        const isV4Translated =
          bytes.slice(0, 8).every((b) => b === 0) &&
          bytes[8] === 0xff &&
          bytes[9] === 0xff &&
          bytes[10] === 0x00 &&
          bytes[11] === 0x00;
        const isNat64 =
          bytes[0] === 0x00 &&
          bytes[1] === 0x64 &&
          bytes[2] === 0xff &&
          bytes[3] === 0x9b &&
          bytes.slice(4, 12).every((b) => b === 0);
        if (isV4Translated || isNat64) {
          addr = new ipaddr.IPv4(bytes.slice(12));
        }
      }
    }
    return addr.range() === 'unicast';
  } catch {
    return false;
  }
}
