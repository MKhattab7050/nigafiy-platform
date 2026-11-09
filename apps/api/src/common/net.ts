import { createRequire } from 'node:module';
import ipaddr from 'ipaddr.js';
import { env } from '../config/env.ts';

const require = createRequire(import.meta.url);
// IEEE OUI registry (MA-L assignments), shipped as data by the `oui-data` package.
const OUI: Record<string, string> = require('oui-data');

export const MAX_SCOPE_HOSTS_PREFIX = 20; // largest authorizable IPv4 scope: /20 (4096 addresses)

export function isIPv4(value: string): boolean {
  return ipaddr.IPv4.isValidFourPartDecimal(value);
}

export interface ScopeValidation {
  ok: boolean;
  cidr?: string;
  reason?: string;
}

/**
 * A scope is only accepted when it is an RFC 1918 private IPv4 range (or loopback in dev/test)
 * and no larger than /20. This is a hard guard against pointing a collector at address space the
 * customer cannot own.
 */
export function validateScope(input: string): ScopeValidation {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  let prefix: number;
  try {
    [addr, prefix] = ipaddr.parseCIDR(input.trim());
  } catch {
    return { ok: false, reason: 'Not a valid CIDR range (example: 192.168.1.0/24)' };
  }
  if (addr.kind() !== 'ipv4') return { ok: false, reason: 'Only IPv4 scopes are supported at this time' };
  if (prefix < MAX_SCOPE_HOSTS_PREFIX) return { ok: false, reason: `Scope is too large: the maximum size is /${MAX_SCOPE_HOSTS_PREFIX} (4096 addresses)` };
  const v4 = addr as ipaddr.IPv4;
  const network = ipaddr.IPv4.networkAddressFromCIDR(`${v4.toString()}/${prefix}`);
  const range = network.range();
  const allowed = range === 'private' || (range === 'loopback' && env.ALLOW_LOOPBACK_SCOPES);
  if (!allowed) return { ok: false, reason: 'Only private (RFC 1918) address ranges can be monitored: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16' };
  return { ok: true, cidr: `${network.toString()}/${prefix}` };
}

export function cidrContains(cidr: string, ip: string): boolean {
  try {
    return ipaddr.IPv4.parse(ip).match(ipaddr.IPv4.parseCIDR(cidr));
  } catch {
    return false;
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
    if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
    return addr.range() === 'unicast';
  } catch {
    return false;
  }
}
