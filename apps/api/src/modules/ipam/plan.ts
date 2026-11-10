import type { IpamAddress, IpamConflict, IpamRecord } from '@lan-detective/shared-types';

// Pure IPv4 arithmetic and the allocation view of one subnet. No database access here, so the
// rules (what counts as used, what is a conflict) are unit-testable.

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

export interface Plan {
  addresses: IpamAddress[];
  conflicts: IpamConflict[];
  counts: { usable: number; online: number; offline: number; documented_only: number; free: number };
  next_free: string[];
}

const sameMac = (a: string | null, b: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export function buildPlan(input: PlanInput): Plan {
  const m = subnetMath(input.cidr);
  const inside = (ip: string) => {
    const n = ipToInt(ip);
    return n >= m.network && n <= m.broadcast;
  };
  const byIp = new Map<number, IpamAddress>();
  const entry = (ip: string): IpamAddress => {
    const n = ipToInt(ip);
    let e = byIp.get(n);
    if (!e) {
      e = { ip, state: 'documented', devices: [], record: null, flags: [], conflict: null };
      byIp.set(n, e);
    }
    return e;
  };

  for (const d of input.devices) if (inside(d.ip)) entry(d.ip).devices.push({ id: d.id, label: d.label, mac: d.mac, device_type: d.device_type, status: d.status, last_seen_at: d.last_seen_at });
  for (const r of input.records) if (inside(r.ip)) entry(r.ip).record = r;
  if (input.gateway && inside(input.gateway.ip)) entry(input.gateway.ip).flags.push(input.gateway.source === 'documented' ? 'gateway' : 'gateway_observed');
  for (const ip of input.collectorIps) if (inside(ip)) entry(ip).flags.push('collector');

  const dhcp = input.dhcp ? { start: ipToInt(input.dhcp.start), end: ipToInt(input.dhcp.end) } : null;
  const conflicts: IpamConflict[] = [];
  const counts = { usable: m.usable, online: 0, offline: 0, documented_only: 0, free: 0 };

  for (const [n, e] of byIp) {
    if (dhcp && n >= dhcp.start && n <= dhcp.end) e.flags.push('dhcp_pool');
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
    } else if (r?.kind === 'static' && dhcp && n >= dhcp.start && n <= dhcp.end) {
      add('static_in_dhcp_pool', [`${e.ip} is documented as a static address ("${r.label}")`, `It is inside the DHCP pool ${input.dhcp!.start} – ${input.dhcp!.end}, so the DHCP server may hand it to another device`]);
    }

    if (n < m.first || n > m.last) continue; // network / broadcast address: not part of the usable count
    if (e.state === 'online') counts.online++;
    else if (e.devices.length) counts.offline++;
    else if (e.record) counts.documented_only++;
  }
  // An address counts as taken when something was observed there or it is documented.
  const taken = [...byIp.entries()].filter(([n, e]) => n >= m.first && n <= m.last && (e.devices.length > 0 || e.record)).length;
  counts.free = m.usable - taken;

  // Suggestions for a new static address: unused, undocumented, not infrastructure, outside the DHCP pool.
  const next_free: string[] = [];
  for (let n = m.first; n <= m.last && next_free.length < 5; n++) {
    if (byIp.has(n)) continue;
    if (dhcp && n >= dhcp.start && n <= dhcp.end) continue;
    next_free.push(intToIp(n));
  }

  const addresses = [...byIp.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  conflicts.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  return { addresses, conflicts, counts, next_free };
}

/** A value safe to place in a CSV cell (quotes escaped, spreadsheet formulas neutralised). */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
