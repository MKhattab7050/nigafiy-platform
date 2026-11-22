import ipaddr from 'ipaddr.js';
import type { Confidence, ScopeSuggestion, ScopeSuggestionSource, ScopeSuggestions } from '@lan-detective/shared-types';
import { notFound } from '../../common/http.ts';
import { MAX_SCOPE_HOSTS_PREFIX, MAX_SCOPE_IPV6_PREFIX, validateScope } from '../../common/net.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';

/**
 * Scope suggestions: the private IPv4 networks (and IPv6 LAN prefixes) the site's collectors are attached to (from the
 * interfaces and default gateway they report in heartbeats) that no authorized scope covers yet.
 *
 * This only SUGGESTS. Authorizing a range is consent to scan it and stays the explicit
 * POST /sites/:id/scopes with authorization_confirmed — nothing here ever creates a scope.
 *
 *   interface network as reported, /20…/30   → not inferred, high confidence
 *   interface network larger than /20         → narrowed to the /24 around the collector's own address (inferred, medium)
 *   default gateway outside every suggestion  → the /24 around the gateway (inferred, low): the size is not reported
 */
export const NARROWED_PREFIX = 24;
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export interface CollectorNetworkFacts {
  id: string;
  name: string;
  gateway_ip: string | null;
  interfaces: { name: string; addresses: string[] }[] | null;
}

interface Candidate {
  cidr: string;
  reported_cidr: string | null;
  inferred: boolean;
  confidence: Confidence;
  evidence: string[];
  sources: ScopeSuggestionSource[];
}

const networkOf = (ip: string, prefix: number) => `${ipaddr.IPv4.networkAddressFromCIDR(`${ip}/${prefix}`).toString()}/${prefix}`;
const contains = (outer: string, inner: string) => {
  const [oa, op] = ipaddr.IPv4.parseCIDR(outer);
  const [ia, ip] = ipaddr.IPv4.parseCIDR(inner);
  return op <= ip && ia.match(oa, op);
};

/**
 * IPv6: the on-link prefix of a unique-local or global address of the collector (normally a /64).
 *   prefix /48…/64 as reported → not inferred, high confidence
 *   prefix larger than /48     → the /64 around the collector's own address (inferred, medium)
 *   longer than /64 (a DHCPv6 /128 host address) or link-local → nothing: the link's prefix is not reported
 */
function ipv6Candidate(col: CollectorNetworkFacts, iface: string, address: string, ip: ipaddr.IPv6, prefix: number): Candidate | null {
  const range = ip.range();
  const global = range === 'unicast' && (ip.parts[0]! & 0xe000) === 0x2000;
  if ((range !== 'uniqueLocal' && !global) || prefix > 64) return null;
  const source: ScopeSuggestionSource = { kind: 'interface', collector_id: col.id, collector_name: col.name, interface: iface, reported: address };
  const seen = `Collector "${col.name}" has address ${address} on interface ${iface}`;
  const net = (p: number) => `${ipaddr.IPv6.networkAddressFromCIDR(`${ip.toString()}/${p}`).toString()}/${p}`;
  if (prefix >= MAX_SCOPE_IPV6_PREFIX) return { cidr: net(prefix), reported_cidr: null, inferred: false, confidence: 'high', evidence: [seen], sources: [source] };
  return {
    cidr: net(64),
    reported_cidr: net(prefix),
    inferred: true,
    confidence: 'medium',
    evidence: [seen, `${net(prefix)} is larger than the largest IPv6 range that can be authorized (/${MAX_SCOPE_IPV6_PREFIX}); suggesting the /64 around the collector's own address`],
    sources: [source],
  };
}

/** Pure: candidate networks from what the collectors report (before removing what scopes already cover). */
export function scopeCandidates(collectors: CollectorNetworkFacts[]): Candidate[] {
  const out = new Map<string, Candidate>();
  const tooLarge: { collector: string; cidr: string }[] = [];
  const add = (c: Candidate) => {
    const prev = out.get(c.cidr);
    if (!prev) return void out.set(c.cidr, c);
    prev.sources.push(...c.sources);
    prev.evidence.push(...c.evidence.filter((e) => !prev.evidence.includes(e)));
    if (RANK[c.confidence] > RANK[prev.confidence]) prev.confidence = c.confidence;
    prev.inferred = prev.inferred && c.inferred;
    if (!c.inferred) prev.reported_cidr = null;
  };

  for (const col of collectors) {
    for (const iface of col.interfaces ?? []) {
      for (const address of iface.addresses) {
        let ip: ipaddr.IPv4;
        let prefix: number;
        try {
          const [a, p] = ipaddr.parseCIDR(address);
          if (a.kind() === 'ipv6') {
            const c = ipv6Candidate(col, iface.name, address, a as ipaddr.IPv6, p);
            if (c) add(c);
            continue;
          }
          ip = a as ipaddr.IPv4;
          prefix = p;
        } catch {
          continue; // no prefix, or not an address
        }
        if (prefix > 30 || ip.range() !== 'private') continue; // point-to-point / host routes; only RFC 1918
        const reported = networkOf(ip.toString(), prefix);
        const source: ScopeSuggestionSource = { kind: 'interface', collector_id: col.id, collector_name: col.name, interface: iface.name, reported: address };
        const seen = `Collector "${col.name}" has address ${address} on interface ${iface.name}`;
        if (prefix >= MAX_SCOPE_HOSTS_PREFIX) {
          add({ cidr: reported, reported_cidr: null, inferred: false, confidence: 'high', evidence: [seen], sources: [source] });
        } else {
          tooLarge.push({ collector: col.id, cidr: reported });
          add({
            cidr: networkOf(ip.toString(), NARROWED_PREFIX),
            reported_cidr: reported,
            inferred: true,
            confidence: 'medium',
            evidence: [
              seen,
              `${reported} has ${(2 ** (32 - prefix)).toLocaleString('en-US')} addresses, more than the largest range that can be authorized (/${MAX_SCOPE_HOSTS_PREFIX}); suggesting the /${NARROWED_PREFIX} around the collector's own address`,
            ],
            sources: [source],
          });
        }
      }
    }
  }
  for (const col of collectors) {
    const gw = col.gateway_ip;
    if (!gw || !ipaddr.IPv4.isValidFourPartDecimal(gw) || ipaddr.IPv4.parse(gw).range() !== 'private') continue;
    const cidr = networkOf(gw, NARROWED_PREFIX);
    const source: ScopeSuggestionSource = { kind: 'gateway', collector_id: col.id, collector_name: col.name, interface: null, reported: gw };
    const covering = [...out.values()].find((c) => contains(c.cidr, `${gw}/32`));
    if (covering) {
      covering.sources.push(source);
      continue;
    }
    // On an interface network that was too large to suggest whole: the /24 around the gateway, size known.
    const wide = tooLarge.find((w) => w.collector === col.id && contains(w.cidr, `${gw}/32`));
    add(
      wide
        ? {
            cidr,
            reported_cidr: wide.cidr,
            inferred: true,
            confidence: 'medium',
            evidence: [`Collector "${col.name}" uses ${gw} as its default gateway`, `${wide.cidr} is too large to authorize; suggesting the /${NARROWED_PREFIX} around the gateway`],
            sources: [source],
          }
        : {
            cidr,
            reported_cidr: null,
            inferred: true,
            confidence: 'low',
            evidence: [`Collector "${col.name}" uses ${gw} as its default gateway`, `The size of that network is not reported; a /${NARROWED_PREFIX} is assumed`],
            sources: [source],
          },
    );
  }

  // A suggestion inside another one would overlap it once that one is authorized: fold it in.
  const all = [...out.values()];
  return all.filter((c) => {
    const outer = all.find((o) => o !== c && o.cidr !== c.cidr && contains(o.cidr, c.cidr));
    if (!outer) return true;
    outer.sources.push(...c.sources);
    return false;
  });
}

export function suggestScopes(organizationId: string, siteId: string): Promise<ScopeSuggestions> {
  return withTenant(organizationId, async (db: Db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    const collectors = (
      await db.query<CollectorNetworkFacts>(
        `SELECT id, name, host(gateway_ip) AS gateway_ip, interfaces FROM collectors WHERE site_id = $1 AND status = 'active' ORDER BY name, id`,
        [siteId],
      )
    ).rows;
    const candidates = scopeCandidates(collectors).filter((c) => validateScope(c.cidr).ok);
    if (!candidates.length) return { site_id: siteId, items: [] };
    // Any scope of the site (enabled or not) that overlaps: authorizing the suggestion would be refused as an overlap.
    const free = new Set(
      (
        await db.query<{ cidr: string }>(
          `SELECT c::text AS cidr FROM unnest($2::cidr[]) AS c WHERE NOT EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = $1 AND s.cidr && c)`,
          [siteId, candidates.map((c) => c.cidr)],
        )
      ).rows.map((r) => r.cidr),
    );
    const items: ScopeSuggestion[] = candidates
      .filter((c) => free.has(c.cidr))
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.cidr.localeCompare(b.cidr))
      .map((c) => ({ ...c, narrowed: c.reported_cidr !== null }));
    return { site_id: siteId, items };
  });
}
