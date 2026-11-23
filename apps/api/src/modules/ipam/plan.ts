import ipaddr from 'ipaddr.js';
import type { IpamAddress, IpamConflict, IpamRecord } from '@nigafiy/shared-types';

// Pure address arithmetic (IPv4 and IPv6) and the allocation view of one subnet. No database
// access here, so the rules (what counts as used, what is a conflict) are unit-testable.
//
// An IPv6 subnet holds up to 2^64 (or more) addresses: nothing here ever enumerates a subnet. The
// plan lists only the addresses that were observed, documented or are infrastructure, keyed by their
// 128-bit value (bigint); counts are exact bigint arithmetic; next-free suggestions walk forward from
// the first host address, skipping only listed addresses and the DHCP pool, so the walk is bounded by
// the number of listed addresses.

export function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export interface SubnetMath {
  prefix: number;
  network: number;
  broadcast: number;
  /** First and last address a host can use. */
  first: number;
  last: number;
  usable: number;
}

/** IPv4 only (kept for IPv4 callers); rangeOf covers both families. */
export function subnetMath(cidr: string): SubnetMath {
  const [addr, bits] = cidr.split('/');
  const prefix = Number(bits);
  const size = 2 ** (32 - prefix);
  const network = Math.floor(ipToInt(addr!) / size) * size;
  const broadcast = network + size - 1;
  // /31 (point-to-point) and /32 have no network / broadcast address to set aside.
  const p2p = prefix >= 31;
  const first = p2p ? network : network + 1;
  const last = p2p ? broadcast : broadcast - 1;
  return { prefix, network, broadcast, first, last, usable: last - first + 1 };
}

export type Family = 4 | 6;

/** The 32- or 128-bit value of an address. */
export function ipToBig(ip: string): bigint {
  let n = 0n;
  for (const b of ipaddr.parse(ip).toByteArray()) n = (n << 8n) | BigInt(b);
  return n;
}

/** Canonical text of a 32-bit (family 4) or 128-bit (family 6) value. */
export function bigToIp(n: bigint, family: Family): string {
  const bytes: number[] = [];
  for (let i = family === 4 ? 3 : 15; i >= 0; i--) bytes.push(Number((n >> BigInt(i * 8)) & 255n));
  return ipaddr.fromByteArray(bytes).toString();
}

export const familyOf = (ip: string): Family => (ip.includes(':') ? 6 : 4);

export interface Range {
  family: Family;
  prefix: number;
  network: bigint;
  /** The last address of the prefix (the IPv4 broadcast address). */
  end: bigint;
  /** IPv4 only; IPv6 has no broadcast address. */
  broadcast: bigint | null;
  /** First and last address a host can use. */
  first: bigint;
  last: bigint;
  usable: bigint;
  netmask: string;
}

/**
 * The address range of a subnet. IPv4: the network and broadcast addresses are set aside (except
 * /31 point-to-point and /32). IPv6: no broadcast; the all-zeros address is the subnet-router anycast
 * address (RFC 4291) and is set aside, except on /127 point-to-point links (RFC 6164) and /128.
 */
export function rangeOf(cidr: string): Range {
  const [addr, bits] = cidr.split('/');
  const family = familyOf(addr!);
  const width = family === 4 ? 32 : 128;
  const prefix = Number(bits);
  const hostBits = BigInt(width - prefix);
  const size = 1n << hostBits;
  const network = (ipToBig(addr!) >> hostBits) << hostBits;
  const end = network + size - 1n;
  const p2p = prefix >= width - 1;
  const first = p2p ? network : network + 1n;
  const last = p2p || family === 6 ? end : end - 1n;
  const mask = ((1n << BigInt(width)) - 1n) ^ (size - 1n);
  return { family, prefix, network, end, broadcast: family === 4 ? end : null, first, last, usable: last - first + 1n, netmask: bigToIp(mask, family) };
}

export interface ObservedDevice {
  id: string;
  ip: string;
  label: string;
  mac: string | null;
  device_type: string;
  status: 'online' | 'offline' | 'unknown';
  last_seen_at: string;
}

export interface PlanInput {
  cidr: string;
  devices: ObservedDevice[];
  records: IpamRecord[];
  /** Documented gateway, else the default gateway reported by a collector inside this subnet. */
  gateway: { ip: string; source: 'documented' | 'observed' } | null;
  collectorIps: string[];
  dhcp: { start: string; end: string } | null;
}

export interface PlanCounts {
  /** Approximate for large IPv6 subnets (a JavaScript number); the *_exact strings are exact. */
  usable: number;
  online: number;
  offline: number;
  documented_only: number;
  free: number;
  usable_exact: string;
  free_exact: string;
}

export interface Plan {
  family: Family;
  addresses: IpamAddress[];
  conflicts: IpamConflict[];
  counts: PlanCounts;
  next_free: string[];
}

const sameMac = (a: string | null, b: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** How many next-free suggestions a plan offers. */
export const NEXT_FREE_COUNT = 5;

export function buildPlan(input: PlanInput): Plan {
  const m = rangeOf(input.cidr);
  const toN = (ip: string): bigint | null => (familyOf(ip) === m.family ? ipToBig(ip) : null);
  const inside = (ip: string) => {
    const n = toN(ip);
    return n !== null && n >= m.network && n <= m.end;
  };
  const byIp = new Map<bigint, IpamAddress>();
  const entry = (ip: string): IpamAddress => {
    const n = ipToBig(ip);
    let e = byIp.get(n);
    if (!e) {
      e = { ip, state: 'documented', devices: [], record: null, flags: [], conflict: null };
      byIp.set(n, e);
    }
    return e;
  };

  for (const d of input.devices) {
    if (!inside(d.ip)) continue;
    const e = entry(d.ip);
    // One device listed once per address (a device can be reported by its current address and by its observed addresses).
    if (!e.devices.some((x) => x.id === d.id)) e.devices.push({ id: d.id, label: d.label, mac: d.mac, device_type: d.device_type, status: d.status, last_seen_at: d.last_seen_at });
  }
  for (const r of input.records) if (inside(r.ip)) entry(r.ip).record = r;
  if (input.gateway && inside(input.gateway.ip)) entry(input.gateway.ip).flags.push(input.gateway.source === 'documented' ? 'gateway' : 'gateway_observed');
  for (const ip of input.collectorIps) if (inside(ip)) entry(ip).flags.push('collector');

  const dhcpStart = input.dhcp ? toN(input.dhcp.start) : null;
  const dhcpEnd = input.dhcp ? toN(input.dhcp.end) : null;
  const dhcp = dhcpStart !== null && dhcpEnd !== null ? { start: dhcpStart, end: dhcpEnd } : null;
  const inPool = (n: bigint) => dhcp !== null && n >= dhcp.start && n <= dhcp.end;
  const conflicts: IpamConflict[] = [];
  const counts = { online: 0, offline: 0, documented_only: 0 };

  for (const [n, e] of byIp) {
    if (inPool(n)) e.flags.push('dhcp_pool');
    // Online devices first, then most recently seen: the first one is "who is there now".
    e.devices.sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online') || b.last_seen_at.localeCompare(a.last_seen_at));
    const online = e.devices.filter((d) => d.status === 'online');
    e.state = online.length ? 'online' : e.devices.length ? (e.devices.some((d) => d.status === 'offline') ? 'offline' : 'unknown') : e.record ? 'documented' : 'infrastructure';

    const add = (kind: IpamConflict['kind'], evidence: string[]) => {
      e.conflict = kind;
      conflicts.push({ ip: e.ip, kind, evidence });
    };
    const r = e.record;
    if (online.length > 1) {
      add('duplicate_ip', online.map((d) => `${d.label}${d.mac ? ` (${d.mac})` : ''} reported online at ${e.ip}, last seen ${d.last_seen_at}`));
    } else if (r?.kind === 'reserved' && online.length) {
      add('reserved_in_use', [`${e.ip} is documented as reserved ("${r.label}")`, `${online[0]!.label}${online[0]!.mac ? ` (${online[0]!.mac})` : ''} is online at this address`]);
    } else if (r?.mac && online.length && online[0]!.mac && !sameMac(r.mac, online[0]!.mac)) {
      add('assignment_mismatch', [`${e.ip} is documented for ${r.label} (${r.mac})`, `The device online at this address is ${online[0]!.label} (${online[0]!.mac})`]);
    } else if (r?.kind === 'static' && inPool(n)) {
      add('static_in_dhcp_pool', [`${e.ip} is documented as a static address ("${r.label}")`, `It is inside the DHCP pool ${input.dhcp!.start} – ${input.dhcp!.end}, so the DHCP server may hand it to another device`]);
    }

    if (n < m.first || n > m.last) continue; // network / broadcast / subnet-router anycast: not part of the usable count
    if (e.state === 'online') counts.online++;
    else if (e.devices.length) counts.offline++;
    else if (e.record) counts.documented_only++;
  }
  // An address counts as taken when something was observed there or it is documented.
  let taken = 0n;
  for (const [n, e] of byIp) if (n >= m.first && n <= m.last && (e.devices.length > 0 || e.record)) taken++;
  const free = m.usable - taken;

  // Suggestions for a new static address: unused, undocumented, not infrastructure, outside the DHCP
  // pool. Each step either yields a suggestion, skips one listed address or jumps over the pool, so
  // the walk takes at most NEXT_FREE_COUNT + byIp.size + 1 steps whatever the subnet size.
  const next_free: string[] = [];
  for (let n = m.first; n <= m.last && next_free.length < NEXT_FREE_COUNT; ) {
    if (dhcp && inPool(n)) {
      n = dhcp.end + 1n;
      continue;
    }
    if (!byIp.has(n)) next_free.push(bigToIp(n, m.family));
    n++;
  }

  const byValue = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
  const addresses = [...byIp.entries()].sort((a, b) => byValue(a[0], b[0])).map(([, e]) => e);
  conflicts.sort((a, b) => byValue(ipToBig(a.ip), ipToBig(b.ip)));
  return {
    family: m.family,
    addresses,
    conflicts,
    counts: { usable: Number(m.usable), ...counts, free: Number(free), usable_exact: m.usable.toString(), free_exact: free.toString() },
    next_free,
  };
}

/** A value safe to place in a CSV cell (quotes escaped, spreadsheet formulas neutralised). */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
