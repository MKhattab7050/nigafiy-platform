import type { DeviceStatus } from '@nigafiy/shared-types';
import type { DiscoveryRunItem } from '../../../common/collector-protocol.ts';
import { addressScope, cidrContains, compareIp, normalizeMac } from '../../../common/net.ts';
import type { Fingerprint } from '../../devices/index.ts';

/** A device of the site as loaded (and locked) for matching against one sweep. */
export interface DeviceRow {
  id: string;
  mac: string | null;
  ip: string | null;
  status: DeviceStatus;
  hostname: string | null;
  display_name: string | null;
  is_critical: boolean;
  trust: 'unreviewed' | 'known' | 'unwanted';
  alerts_muted: boolean;
  discovery_sources: string[];
  last_seen_at: Date;
}

/** One observed identity: a MAC address, or (when no MAC was observable) a single IP address. */
export interface Identity {
  mac: string | null;
  /** Addresses inside the scope, the preferred one first (see preferIp). */
  ips: string[];
  /**
   * IPv6 link-local addresses (fe80::/10) the collector saw with this MAC on the scope's link, outside
   * the scope itself. Evidence about the device only: never its identity and never its current address.
   */
  linkLocal: string[];
  /** How each address (ips and linkLocal) was observed. */
  addressSources: Map<string, Set<string>>;
  hostname: string | null;
  sources: Set<string>;
  fingerprint: Fingerprint;
}

const SCOPE_RANK: Record<string, number> = { ipv4: 0, global: 1, unique_local: 2, link_local: 3, other: 4 };

/** Order of preference for a device's current address: IPv4, then global, unique-local, link-local IPv6; numeric within each. */
export const preferIp = (a: string, b: string): number => SCOPE_RANK[addressScope(a)]! - SCOPE_RANK[addressScope(b)]! || compareIp(a, b);

export const deviceLabel = (d: { display_name?: string | null; hostname?: string | null; ip?: string | null; mac?: string | null }): string =>
  d.display_name || d.hostname || d.ip || d.mac || 'Device';

/**
 * Group the hosts of a sweep into identities. Hosts outside the authorized scope are dropped and
 * counted — except, for an IPv6 scope, link-local addresses reported with a MAC, which are kept as
 * evidence about the device with that MAC. For an IP reported twice, the observation with a MAC wins. Pure.
 */
export function groupObservations(cidr: string, hosts: DiscoveryRunItem['hosts']): { responded: number; rejectedHosts: number; identities: Map<string, Identity> } {
  const v6 = cidr.includes(':');
  const byIp = new Map<string, (typeof hosts)[number]>();
  const linkLocal = new Map<string, (typeof hosts)[number]>();
  let rejectedHosts = 0;
  for (const host of hosts) {
    if (!cidrContains(cidr, host.ip)) {
      if (v6 && host.mac && addressScope(host.ip) === 'link_local') {
        linkLocal.set(host.ip, host);
        continue;
      }
      rejectedHosts++;
      continue;
    }
    const existing = byIp.get(host.ip);
    if (!existing || (!existing.mac && host.mac)) byIp.set(host.ip, host);
  }
  const identities = new Map<string, Identity>();
  const blank = (mac: string | null): Identity => ({ mac, ips: [], linkLocal: [], addressSources: new Map(), hostname: null, sources: new Set<string>(), fingerprint: {} });
  for (const host of byIp.values()) {
    let mac = host.mac ? normalizeMac(host.mac) : null;
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') mac = null;
    const key = mac ?? `ip:${host.ip}`;
    const identity = identities.get(key) ?? blank(mac);
    if (host.names) identity.fingerprint.names = [...(identity.fingerprint.names ?? []), ...host.names];
    if (host.services) identity.fingerprint.services = [...(identity.fingerprint.services ?? []), ...host.services];
    if (host.hints) identity.fingerprint.hints = { ...identity.fingerprint.hints, ...host.hints };
    if (host.ssdp) identity.fingerprint.ssdp = host.ssdp;
    identity.ips.push(host.ip);
    identity.addressSources.set(host.ip, new Set(host.sources));
    identity.hostname ??= host.hostname ?? null;
    for (const s of host.sources) identity.sources.add(s);
    identities.set(key, identity);
  }
  // Link-local addresses join the identity with the same MAC, or form a MAC-only identity that is
  // only ever attached to an existing device (process-run.ts), never created as one.
  for (const host of linkLocal.values()) {
    const mac = normalizeMac(host.mac!);
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') continue;
    const identity = identities.get(mac) ?? blank(mac);
    identity.linkLocal.push(host.ip);
    identity.addressSources.set(host.ip, new Set(host.sources));
    identities.set(mac, identity);
  }
  for (const identity of identities.values()) {
    identity.ips.sort(preferIp);
    identity.linkLocal.sort(compareIp);
  }
  return { responded: byIp.size, rejectedHosts, identities };
}
