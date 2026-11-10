// IPv4 subnet arithmetic for the IPAM page and the subnet calculator. Pure functions, no I/O.

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

/** A dotted netmask → prefix length, or null when the mask is not contiguous. */
function prefixOfMask(mask: number): number | null {
  for (let p = 0; p <= 32; p++) if (maskOf(p) === mask) return p;
  return null;
}

export interface Subnet {
  address: string;
  prefix: number;
  network: number;
  broadcast: number;
  first: number;
  last: number;
  usable: number;
  total: number;
  netmask: string;
  wildcard: string;
  /** RFC 1918 private, loopback, link-local, CGNAT, multicast or public. */
  kind: 'private' | 'loopback' | 'link_local' | 'cgnat' | 'multicast' | 'public';
}

/** Accepts "192.168.1.10/24", "192.168.1.10 255.255.255.0" or a bare address (treated as /32). */
export function parseSubnet(input: string): Subnet | null {
  const text = input.trim();
  const m = /^(\S+?)(?:\s*\/\s*(\d{1,2})|\s+(\S+))?$/.exec(text);
  if (!m) return null;
  const addr = ipToInt(m[1]!);
  if (addr === null) return null;
  let prefix = 32;
  if (m[2] !== undefined) prefix = Number(m[2]);
  else if (m[3] !== undefined) {
    const mask = ipToInt(m[3]);
    const p = mask === null ? null : prefixOfMask(mask);
    if (p === null) return null;
    prefix = p;
  }
  if (prefix > 32) return null;
  return subnetOf(addr, prefix);
}

export function subnetOf(addr: number, prefix: number): Subnet {
  const mask = maskOf(prefix);
  const network = (addr & mask) >>> 0;
  const total = 2 ** (32 - prefix);
  const broadcast = network + total - 1;
  const p2p = prefix >= 31; // /31 point-to-point and /32 host: every address is usable
  const first = p2p ? network : network + 1;
  const last = p2p ? broadcast : broadcast - 1;
  const a = network >>> 24;
  const b = (network >>> 16) & 255;
  const kind: Subnet['kind'] =
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      ? 'private'
      : a === 127
        ? 'loopback'
        : a === 169 && b === 254
          ? 'link_local'
          : a === 100 && b >= 64 && b <= 127
            ? 'cgnat'
            : a >= 224 && a <= 239
              ? 'multicast'
              : 'public';
  return { address: intToIp(addr), prefix, network, broadcast, first, last, usable: last - first + 1, total, netmask: intToIp(mask), wildcard: intToIp(~mask >>> 0), kind };
}

/** The subnets obtained by splitting `s` into blocks of `newPrefix` (at most `limit` returned). */
export function splitSubnet(s: Subnet, newPrefix: number, limit = 64): { count: number; items: Subnet[] } {
  if (newPrefix <= s.prefix || newPrefix > 32) return { count: 0, items: [] };
  const count = 2 ** (newPrefix - s.prefix);
  const size = 2 ** (32 - newPrefix);
  const items: Subnet[] = [];
  for (let i = 0; i < Math.min(count, limit); i++) items.push(subnetOf(s.network + i * size, newPrefix));
  return { count, items };
}
