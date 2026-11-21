import type { DeviceStatus } from '@lan-detective/shared-types';
import type { DiscoveryRunItem } from '../../../common/collector-protocol.ts';
import { cidrContains, normalizeMac } from '../../../common/net.ts';
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
  ips: string[];
  hostname: string | null;
  sources: Set<string>;
  fingerprint: Fingerprint;
}

export const ipToInt = (ip: string): number => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
export const deviceLabel = (d: { display_name?: string | null; hostname?: string | null; ip?: string | null; mac?: string | null }): string =>
  d.display_name || d.hostname || d.ip || d.mac || 'Device';

/**
 * Group the hosts of a sweep into identities. Hosts outside the authorized scope are dropped and
 * counted; for an IP reported twice, the observation with a MAC wins. Pure.
 */
export function groupObservations(cidr: string, hosts: DiscoveryRunItem['hosts']): { responded: number; rejectedHosts: number; identities: Map<string, Identity> } {
  const byIp = new Map<string, (typeof hosts)[number]>();
  let rejectedHosts = 0;
  for (const host of hosts) {
    if (!cidrContains(cidr, host.ip)) {
      rejectedHosts++;
      continue;
    }
    const existing = byIp.get(host.ip);
    if (!existing || (!existing.mac && host.mac)) byIp.set(host.ip, host);
  }
  const identities = new Map<string, Identity>();
  for (const host of byIp.values()) {
    let mac = host.mac ? normalizeMac(host.mac) : null;
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') mac = null;
    const key = mac ?? `ip:${host.ip}`;
    const identity = identities.get(key) ?? { mac, ips: [], hostname: null, sources: new Set<string>(), fingerprint: {} };
    if (host.names) identity.fingerprint.names = [...(identity.fingerprint.names ?? []), ...host.names];
    if (host.services) identity.fingerprint.services = [...(identity.fingerprint.services ?? []), ...host.services];
    if (host.hints) identity.fingerprint.hints = { ...identity.fingerprint.hints, ...host.hints };
    if (host.ssdp) identity.fingerprint.ssdp = host.ssdp;
    identity.ips.push(host.ip);
    identity.hostname ??= host.hostname ?? null;
    for (const s of host.sources) identity.sources.add(s);
    identities.set(key, identity);
  }
  return { responded: byIp.size, rejectedHosts, identities };
}
