// IPv4 and IPv6 subnet arithmetic for the IPAM page and the subnet calculator. Pure functions, no
// I/O and no imports, so `node --test` runs the unit tests (subnet-calc.test.ts) directly.
//
// Addresses are bigint values (32 or 128 bits): an IPv6 subnet can hold 2^64 addresses or more,
// beyond what a JavaScript number counts exactly. Nothing here enumerates a subnet.

export type Family = 4 | 6;

const WIDTH: Record<Family, number> = { 4: 32, 6: 128 };

// ── IPv4 as a 32-bit number (the IPv4 address map works in plain numbers) ──

export function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export const maskOf = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

// ── both families as bigint ─────────────────────────────────────────────────

/** The 128-bit value of an IPv6 address (RFC 4291 text forms, embedded IPv4 included), or null. No zone index. */
export function ipv6ToBig(text: string): bigint | null {
  let s = text.trim().toLowerCase();
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s) || s.length > 45) return null;
  if (s.includes('.')) {
    // An embedded IPv4 address (::ffff:192.0.2.1) is the last two groups written in dotted form.
    const lastColon = s.lastIndexOf(':');
    const v4 = ipToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  const given = head.length + rest.length;
  // "::" stands for at least one zero group (RFC 5952 4.2.2 allows writing one, RFC 4291 parses it).
  if (halves.length === 2 ? given > 7 : given !== 8) return null;
  const groups = [...head, ...Array<number>(8 - given).fill(0), ...rest];
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return n;
}

/** An IPv4 or IPv6 address as its family and value, or null. */
export function parseIp(text: string): { family: Family; value: bigint } | null {
  const t = text.trim();
  if (t.includes(':')) {
    const v = ipv6ToBig(t);
    return v === null ? null : { family: 6, value: v };
  }
  const v4 = ipToInt(t);
  return v4 === null ? null : { family: 4, value: BigInt(v4) };
}

/** Canonical text: dotted quad, or RFC 5952 for IPv6 (lower case, longest zero run as "::", IPv4-mapped as ::ffff:a.b.c.d). */
export function formatIp(value: bigint, family: Family): string {
  if (family === 4) return intToIp(Number(value & 0xffffffffn));
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `::ffff:${intToIp(Number(value & 0xffffffffn))}`;
  let best = -1;
  let bestLen = 1; // a single zero group is not shortened (RFC 5952 4.2.2)
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** Canonical text of an address, or the input unchanged when it is not one. */
export const canonicalIp = (text: string): string => {
  const p = parseIp(text);
  return p ? formatIp(p.value, p.family) : text.trim();
};

/** Address order: IPv4 before IPv6, then numeric. Unparseable text sorts last. */
export function compareIp(a: string, b: string): number {
  const x = parseIp(a);
  const y = parseIp(b);
  if (!x || !y) return Number(!x) - Number(!y);
  return x.family - y.family || (x.value < y.value ? -1 : x.value > y.value ? 1 : 0);
}

const maskBig = (family: Family, prefix: number): bigint => {
  const w = BigInt(WIDTH[family]);
  return ((1n << w) - 1n) ^ ((1n << (w - BigInt(prefix))) - 1n);
};

export type Ipv4Kind = 'private' | 'loopback' | 'link_local' | 'cgnat' | 'multicast' | 'public';
export type Ipv6Kind = 'unspecified' | 'loopback' | 'ipv4_mapped' | 'link_local' | 'unique_local' | 'multicast' | 'documentation' | 'global' | 'reserved';

export interface Subnet {
  family: Family;
  address: string;
  prefix: number;
  /** 32 or 128. */
  bits: number;
  network: bigint;
  /** The last address of the prefix. */
  end: bigint;
  /** IPv4 only; IPv6 has no broadcast address. Null as well for IPv4 /31 and /32. */
  broadcast: bigint | null;
  /** First and last address a host can use. */
  first: bigint;
  last: bigint;
  usable: bigint;
  total: bigint;
  netmask: string;
  /** IPv4 only (the inverse mask used in router ACLs). */
  wildcard: string | null;
  kind: Ipv4Kind | Ipv6Kind;
}

function ipv4Kind(network: number): Ipv4Kind {
  const a = network >>> 24;
  const b = (network >>> 16) & 255;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a >= 224 && a <= 239) return 'multicast';
  return 'public';
}

/** The class of an IPv6 network by its first address (the same table as the API's common/net.ts). */
export function ipv6Kind(network: bigint, prefix: number): Ipv6Kind {
  const inNet = (base: string, len: number) => prefix >= len && (network & maskBig(6, len)) === ipv6ToBig(base)!;
  if (prefix === 128 && network === 0n) return 'unspecified';
  if (prefix === 128 && network === 1n) return 'loopback';
  if (inNet('::ffff:0:0', 96)) return 'ipv4_mapped';
  if (inNet('fe80::', 10)) return 'link_local';
  if (inNet('fc00::', 7)) return 'unique_local';
  if (inNet('ff00::', 8)) return 'multicast';
  if (inNet('2001:db8::', 32) || inNet('3fff::', 20)) return 'documentation';
  if (inNet('2000::', 3) && !inNet('2001::', 23) && !inNet('2002::', 16) && !inNet('2620:4f:8000::', 48)) return 'global';
  return 'reserved';
}

/**
 * The subnet of `addr` with the given prefix. IPv4: the network and broadcast addresses are set aside
 * (except /31 point-to-point and /32). IPv6: no broadcast; the all-zeros address is the subnet-router
 * anycast address (RFC 4291) and is set aside, except on /127 (RFC 6164) and /128.
 */
export function subnetOf(addr: bigint, prefix: number, family: Family = 4): Subnet {
  const bits = WIDTH[family];
  const mask = maskBig(family, prefix);
  const network = addr & mask;
  const total = 1n << BigInt(bits - prefix);
  const end = network + total - 1n;
  const p2p = prefix >= bits - 1;
  const first = p2p ? network : network + 1n;
  const last = p2p || family === 6 ? end : end - 1n;
  return {
    family,
    address: formatIp(addr, family),
    prefix,
    bits,
    network,
    end,
    broadcast: family === 4 && !p2p ? end : null,
    first,
    last,
    usable: last - first + 1n,
    total,
    netmask: formatIp(mask, family),
    wildcard: family === 4 ? formatIp(~mask & 0xffffffffn, 4) : null,
    kind: family === 4 ? ipv4Kind(Number(network)) : ipv6Kind(network, prefix),
  };
}

/** A dotted netmask → prefix length, or null when the mask is not contiguous. */
function prefixOfMask(mask: number): number | null {
  for (let p = 0; p <= 32; p++) if (maskOf(p) === mask) return p;
  return null;
}

/**
 * Accepts "192.168.1.10/24", "192.168.1.10 255.255.255.0", "2001:db8:1::5/64" or a bare address
 * (treated as /32 or /128). A zone index ("fe80::1%eth0") is not an address and is refused.
 */
export function parseSubnet(input: string): Subnet | null {
  const text = input.trim();
  const m = /^(\S+?)(?:\s*\/\s*(\d{1,3})|\s+(\S+))?$/.exec(text);
  if (!m) return null;
  const addr = parseIp(m[1]!);
  if (!addr) return null;
  const width = WIDTH[addr.family];
  let prefix = width;
  if (m[2] !== undefined) prefix = Number(m[2]);
  else if (m[3] !== undefined) {
    if (addr.family === 6) return null; // IPv6 has no dotted masks
    const mask = ipToInt(m[3]);
    const p = mask === null ? null : prefixOfMask(mask);
    if (p === null) return null;
    prefix = p;
  }
  if (prefix > width) return null;
  return subnetOf(addr.value, prefix, addr.family);
}

/** The subnets obtained by splitting `s` into blocks of `newPrefix` (at most `limit` returned; count is exact). */
export function splitSubnet(s: Subnet, newPrefix: number, limit = 64): { count: bigint; items: Subnet[] } {
  if (newPrefix <= s.prefix || newPrefix > s.bits) return { count: 0n, items: [] };
  const count = 1n << BigInt(newPrefix - s.prefix);
  const size = 1n << BigInt(s.bits - newPrefix);
  const items: Subnet[] = [];
  const shown = count < BigInt(limit) ? Number(count) : limit;
  for (let i = 0; i < shown; i++) items.push(subnetOf(s.network + BigInt(i) * size, newPrefix, s.family));
  return { count, items };
}

/** A count for display: grouped digits, and 2^n for the exact powers of two too long to read. */
export function formatCount(n: bigint): { digits: string; power: number | null } {
  const digits = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const power = n > 0n && (n & (n - 1n)) === 0n && n >= 1n << 32n ? n.toString(2).length - 1 : null;
  return { digits, power };
}
