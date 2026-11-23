import type {
  CheckKind,
  CheckRole,
  CheckState,
  Confidence,
  DeviceImpactStatus,
  ImpactFailure,
  ImpactGraph,
  ImpactGraphEdge,
  ImpactGraphNode,
  ImpactPathStep,
  ImpactResult,
  ImpactedCheck,
  ImpactedCollector,
  ImpactedDevice,
  ImpactedEndpoint,
  SiteImpact,
  SpofEntry,
  SpofReport,
  Topology,
} from '@nigafiy/shared-types';
import { cidrContains, isIPv4, isPublicAddress } from '../../common/net.ts';

/**
 * The digital twin: a dependency graph built from stored evidence only, and pure algorithms on it.
 *
 *   - the topology graph (internet → gateway → segment → devices; switch ports from forwarding tables;
 *     switch ↔ switch from LLDP), with each edge's observed / inferred basis and confidence;
 *   - Wi-Fi clients the site's router listed (client → router device, observed);
 *   - collectors placed on the device whose address they reported (observed), or only in a segment;
 *   - monitoring checks tied to their target (linked device, address match, gateway or internet role);
 *   - managed computers tied to their linked device.
 *
 * A device whose place in the layer-2 fabric was not observed hangs off its segment through an
 * "unknown attachment" edge. A failure inside that segment's fabric makes such devices
 * "attachment unknown": they are listed, never assumed safe.
 */

export const ROOT = 'internet';

export interface CollectorFact {
  id: string;
  name: string;
  connection_state: string;
  interfaces: { name: string; addresses: string[] }[];
}

export interface CheckFact {
  id: string;
  name: string;
  kind: CheckKind;
  role: CheckRole;
  target: string;
  device_id: string | null;
  last_resolved_target: string | null;
  state: CheckState;
}

export interface EndpointFact {
  id: string;
  name: string;
  device_id: string | null;
}

export interface WirelessFact {
  router_name: string;
  router_device_id: string;
  client_device_id: string;
  connection: string;
  interface: string | null;
  last_seen_at: Date | string;
  active: boolean | null;
}

export interface TwinInput {
  siteId: string;
  siteName: string;
  topology: Topology;
  collectors: CollectorFact[];
  checks: CheckFact[];
  endpoints: EndpointFact[];
  wireless: WirelessFact[];
  now?: Date;
}

export interface Twin {
  siteId: string;
  siteName: string;
  nodes: Map<string, ImpactGraphNode>;
  edges: Map<string, ImpactGraphEdge>;
  adj: Map<string, ImpactGraphEdge[]>;
  checks: CheckFact[];
  endpoints: EndpointFact[];
  limitations: string[];
}

export class ImpactInputError extends Error {}

const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };
const BY_RANK: Confidence[] = ['low', 'low', 'medium', 'high'];
const minConf = (list: Confidence[]): Confidence => (list.length ? BY_RANK[Math.min(...list.map((c) => RANK[c]))]! : 'high');
const maxConf = (list: Confidence[]): Confidence => (list.length ? BY_RANK[Math.max(...list.map((c) => RANK[c]))]! : 'low');

/** Observed edges keep their confidence; an inferred edge is never more than medium. */
export const normalizeConfidence = (basis: 'observed' | 'inferred', c: Confidence): Confidence => (basis === 'observed' ? c : c === 'high' ? 'medium' : c);

const segOf = (nodeId: string) => (nodeId.startsWith('seg:') ? nodeId.slice(4) : null);

// ───────────────────────────── building ─────────────────────────────

export function buildTwin(input: TwinInput): Twin {
  const now = input.now ?? new Date();
  const t = input.topology;
  const nodes = new Map<string, ImpactGraphNode>();
  const edges = new Map<string, ImpactGraphEdge>();
  const limitations: string[] = [];

  for (const n of t.nodes) {
    nodes.set(n.id, {
      id: n.id,
      kind: n.kind === 'device' && n.is_switch ? 'switch' : n.kind,
      label: n.label,
      device_id: n.device_id,
      collector_id: null,
      ip: n.ip,
      segment: n.kind === 'segment' ? segOf(n.id) : n.segment,
      status: n.status,
      is_critical: n.is_critical,
    });
  }
  const add = (e: ImpactGraphEdge) => {
    if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target || edges.has(e.id)) return;
    edges.set(e.id, e);
  };

  // A device has an observed physical attachment when a switch saw it on an access port or a router listed it as a Wi-Fi client.
  // The topology already carries the router Wi-Fi edges (same id); the client tables are applied here as well
  // so a twin built from an older topology still has them.
  const attached = new Set(t.edges.filter((e) => e.relation === 'connected_to' || e.relation === 'wireless_client').map((e) => e.source));
  const wifi: ImpactGraphEdge[] = [];
  for (const w of input.wireless) {
    const client = `dev:${w.client_device_id}`;
    const router = [...nodes.values()].find((n) => n.device_id === w.router_device_id);
    if (!/^wifi/i.test(w.connection) || !router || !nodes.has(client) || client === router.id || attached.has(client)) continue;
    const seen = new Date(w.last_seen_at);
    const fresh = now.getTime() - seen.getTime() < 3_600_000 && w.active !== false;
    const band = w.connection.replace(/^wifi_?/i, '');
    wifi.push({
      id: `e:wifi:${client}`,
      source: client,
      target: router.id,
      relation: 'wireless_client',
      basis: 'observed',
      confidence: fresh ? 'high' : 'medium',
      evidence: `Router "${w.router_name}" listed it as a Wi-Fi client${band ? ` (${band})` : ''}${w.interface ? ` on ${w.interface}` : ''}${fresh ? '' : '; that list is more than an hour old'}.`,
      evidence_source: 'Router client table',
      unknown_attachment: false,
      segment: nodes.get(client)!.segment,
      last_verified_at: seen.toISOString(),
    });
    attached.add(client);
  }

  for (const e of t.edges) {
    if (e.relation === 'member_of' && attached.has(e.source)) continue; // its physical link is known instead
    const segment =
      e.relation === 'member_of' || e.relation === 'gateway_of'
        ? segOf(e.relation === 'member_of' ? e.target : e.source) ?? 'none'
        : e.relation === 'connected_to'
          ? (nodes.get(e.target)?.segment ?? null)
          : e.relation === 'switch_link' || e.relation === 'wireless_client'
            ? (nodes.get(e.source)?.segment ?? null)
            : null;
    add({
      id: e.id,
      source: e.source,
      target: e.target,
      relation: e.relation,
      ...(e.port ? { port: e.port } : {}),
      basis: e.basis,
      confidence: normalizeConfidence(e.basis, e.confidence),
      evidence: e.evidence,
      evidence_source: e.evidence_source,
      unknown_attachment: e.relation === 'member_of',
      segment,
      last_verified_at: e.last_verified_at,
    });
  }
  for (const e of wifi) add(e);

  // Collectors: on the device whose address they report, else only somewhere in a segment.
  const segments = [...nodes.values()].filter((n) => n.kind === 'segment' && n.segment && n.segment !== 'none');
  for (const c of input.collectors) {
    const id = `col:${c.id}`;
    nodes.set(id, { id, kind: 'collector', label: c.name, device_id: null, collector_id: c.id, ip: null, segment: null, status: null, is_critical: false });
    const addrs = c.interfaces.flatMap((i) => i.addresses.map((a) => ({ ip: a.split('/')[0]!, ifname: i.name })));
    const host = addrs.map((a) => ({ a, n: [...nodes.values()].find((n) => (n.kind === 'device' || n.kind === 'switch' || n.kind === 'gateway') && n.ip === a.ip) })).find((x) => x.n);
    if (host?.n) {
      nodes.get(id)!.ip = host.a.ip;
      nodes.get(id)!.segment = host.n.segment;
      add({
        id: `e:${id}:host`,
        source: id,
        target: host.n.id,
        relation: 'runs_on',
        basis: 'observed',
        confidence: 'high',
        evidence: `Collector "${c.name}" reported ${host.a.ip} on its interface ${host.a.ifname}; ${host.n.label} has that address.`,
        evidence_source: 'Collector heartbeat (interfaces)',
        unknown_attachment: false,
        segment: host.n.segment,
        last_verified_at: null,
      });
      continue;
    }
    const inSeg = addrs.map((a) => ({ a, s: segments.find((s) => cidrContains(s.segment!, a.ip)) })).find((x) => x.s);
    if (inSeg?.s) {
      nodes.get(id)!.ip = inSeg.a.ip;
      nodes.get(id)!.segment = inSeg.s.segment;
      add({
        id: `e:${id}:segment`,
        source: id,
        target: inSeg.s.id,
        relation: 'collector_in',
        basis: 'inferred',
        confidence: 'medium',
        evidence: `Collector "${c.name}" has address ${inSeg.a.ip} inside ${inSeg.s.segment}, but its host is not in the device inventory, so where it is plugged in is unknown.`,
        evidence_source: 'Collector heartbeat (interfaces)',
        unknown_attachment: true,
        segment: inSeg.s.segment,
        last_verified_at: null,
      });
    } else {
      limitations.push(`Collector "${c.name}" reported no address inside an authorized segment, so its place in the network is unknown.`);
    }
  }

  // Ports that carry a known link, per switch.
  for (const e of edges.values()) {
    const sw = e.relation === 'connected_to' ? e.target : e.relation === 'switch_link' ? e.source : null;
    if (!sw || !e.port) continue;
    const n = nodes.get(sw)!;
    n.ports = [...new Set([...(n.ports ?? []), e.port])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  const adj = new Map<string, ImpactGraphEdge[]>([...nodes.keys()].map((k) => [k, []]));
  for (const e of edges.values()) {
    adj.get(e.source)!.push(e);
    adj.get(e.target)!.push(e);
  }

  const unknown = [...edges.values()].filter((e) => e.relation === 'member_of').length;
  if (unknown) limitations.push(`${unknown} device(s) have no observed switch port or Wi-Fi association: they are known to be in their segment only. When something in that segment's fabric fails they are listed as "attachment unknown", never as safe.`);
  limitations.push('Unmanaged switches, switches not read over SNMP and access points that are not a configured router are invisible: a device behind one is treated as attached to its segment with an unknown attachment.');
  limitations.push('Each site is its own graph: no links between sites are known, so a failure only impacts its own site.');
  limitations.push(...t.limitations);

  return { siteId: input.siteId, siteName: input.siteName, nodes, edges, adj, checks: input.checks, endpoints: input.endpoints, limitations };
}

export function twinGraph(twin: Twin, generatedAt = new Date()): ImpactGraph {
  return { site_id: twin.siteId, generated_at: generatedAt.toISOString(), nodes: [...twin.nodes.values()], edges: [...twin.edges.values()], limitations: twin.limitations };
}

// ───────────────────────────── graph algorithms ─────────────────────────────

const other = (e: { source: string; target: string }, from: string) => (e.source === from ? e.target : e.source);

interface Reach {
  cost: number;
  via: ImpactGraphEdge | null;
}

/**
 * 0-1 breadth-first search from `sources`. Blocked nodes and edges are skipped. An edge costs 1 when
 * `uncertain(edge)` holds, so a node with cost 0 is reached without relying on anything uncertain.
 */
export function reach(
  twin: Pick<Twin, 'adj'>,
  sources: string[],
  blockedNodes: ReadonlySet<string>,
  blockedEdges: ReadonlySet<string>,
  uncertain: (e: ImpactGraphEdge) => boolean = () => false,
): Map<string, Reach> {
  const out = new Map<string, Reach>();
  const deque: string[] = [];
  for (const s of sources) {
    if (blockedNodes.has(s) || !twin.adj.has(s) || out.has(s)) continue;
    out.set(s, { cost: 0, via: null });
    deque.push(s);
  }
  // A plain array used as a deque: front pushes for cost-0 edges are rare enough to stay cheap at this size.
  let head = 0;
  const front: string[] = [];
  while (front.length || head < deque.length) {
    const n = front.length ? front.pop()! : deque[head++]!;
    const base = out.get(n)!.cost;
    for (const e of twin.adj.get(n) ?? []) {
      if (blockedEdges.has(e.id)) continue;
      const m = other(e, n);
      if (blockedNodes.has(m)) continue;
      const w = uncertain(e) ? 1 : 0;
      const prev = out.get(m);
      if (prev && prev.cost <= base + w) continue;
      out.set(m, { cost: base + w, via: e });
      if (w === 0) front.push(m);
      else deque.push(m);
    }
  }
  return out;
}

/**
 * Widest paths (best weakest-link confidence, then fewest hops) from `sources`: one BFS per confidence
 * level, using only edges at least that confident.
 */
export function widest(twin: Pick<Twin, 'adj'>, sources: string[], blockedNodes: ReadonlySet<string> = new Set()): Map<string, Reach> {
  const out = new Map<string, Reach>();
  for (const level of [3, 2, 1]) {
    const seen = new Map<string, ImpactGraphEdge | null>();
    const queue: string[] = [];
    for (const s of sources) {
      if (blockedNodes.has(s) || !twin.adj.has(s)) continue;
      seen.set(s, null);
      queue.push(s);
    }
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i]!;
      for (const e of twin.adj.get(n) ?? []) {
        if (RANK[e.confidence] < level) continue;
        const m = other(e, n);
        if (seen.has(m) || blockedNodes.has(m)) continue;
        seen.set(m, e);
        queue.push(m);
      }
    }
    for (const [n, via] of seen) if (!out.has(n)) out.set(n, { cost: 3 - level, via });
  }
  return out;
}

/** Walks `via` pointers from `node` back to a source; the edges in that order. */
export function pathTo(map: Map<string, Reach>, node: string): ImpactGraphEdge[] {
  const out: ImpactGraphEdge[] = [];
  let cur = node;
  const guard = new Set<string>();
  while (!guard.has(cur)) {
    guard.add(cur);
    const r = map.get(cur);
    if (!r?.via) break;
    out.push(r.via);
    cur = other(r.via, cur);
  }
  return out;
}

/**
 * Articulation points and bridges of the undirected graph, restricted to the component of `root`
 * (iterative Tarjan, so a long chain cannot overflow the stack). Parallel edges are handled by
 * tracking the edge used to enter a node, not the parent node.
 */
export function articulation(nodes: Iterable<string>, edges: Iterable<{ id: string; source: string; target: string }>, root: string): { points: Set<string>; bridges: Set<string> } {
  const adj = new Map<string, { id: string; to: string }[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target) || e.source === e.target) continue;
    adj.get(e.source)!.push({ id: e.id, to: e.target });
    adj.get(e.target)!.push({ id: e.id, to: e.source });
  }
  const points = new Set<string>();
  const bridges = new Set<string>();
  if (!adj.has(root)) return { points, bridges };
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  let time = 0;
  const stack: { node: string; parentEdge: string | null; i: number; children: number }[] = [{ node: root, parentEdge: null, i: 0, children: 0 }];
  disc.set(root, time);
  low.set(root, time++);
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    const list = adj.get(top.node)!;
    if (top.i < list.length) {
      const { id, to } = list[top.i++]!;
      if (id === top.parentEdge) continue;
      if (disc.has(to)) {
        low.set(top.node, Math.min(low.get(top.node)!, disc.get(to)!));
      } else {
        disc.set(to, time);
        low.set(to, time++);
        top.children++;
        stack.push({ node: to, parentEdge: id, i: 0, children: 0 });
      }
      continue;
    }
    stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) {
      if (top.children > 1) points.add(top.node); // the root is a cut vertex only with two or more DFS children
      continue;
    }
    low.set(parent.node, Math.min(low.get(parent.node)!, low.get(top.node)!));
    if (low.get(top.node)! > disc.get(parent.node)!) bridges.add(top.parentEdge!);
    if (parent.parentEdge !== null && low.get(top.node)! >= disc.get(parent.node)!) points.add(parent.node);
  }
  return { points, bridges };
}

// ───────────────────────────── simulation ─────────────────────────────

interface Resolved {
  failures: { failure: ImpactFailure; label: string }[];
  nodes: Set<string>;
  edges: Set<string>;
  /** Segments whose layer-2 fabric contains a failure: unknown attachments there become uncertain. */
  fabric: Set<string>;
  /** Something upstream (gateway, uplink, internet, segment) failed. */
  upstream: boolean;
  site: boolean;
}

function resolveFailures(twin: Twin, failures: ImpactFailure[]): Resolved {
  const r: Resolved = { failures: [], nodes: new Set(), edges: new Set(), fabric: new Set(), upstream: false, site: false };
  const node = (id: string) => {
    const n = twin.nodes.get(id);
    if (!n) throw new ImpactInputError(`Unknown node "${id}" at this site`);
    return n;
  };
  const failNode = (id: string) => {
    const n = node(id);
    r.nodes.add(id);
    if (n.kind === 'internet' || n.kind === 'gateway') r.upstream = true;
    if (n.kind === 'segment') {
      r.upstream = true;
      r.fabric.add(n.segment ?? 'none');
    }
    // Anything others are plugged into or associated with is part of the fabric.
    if (n.kind === 'switch' || (twin.adj.get(id) ?? []).some((e) => e.target === id && (e.relation === 'connected_to' || e.relation === 'wireless_client'))) r.fabric.add(n.segment ?? 'none');
    return n;
  };
  for (const f of failures) {
    switch (f.type) {
      case 'node':
        r.failures.push({ failure: f, label: failNode(f.id).label });
        break;
      case 'device':
        r.failures.push({ failure: f, label: failNode(`dev:${f.id}`).label });
        break;
      case 'collector':
        r.failures.push({ failure: f, label: `Collector ${failNode(`col:${f.id}`).label}` });
        break;
      case 'port': {
        const sw = node(f.id);
        const hit = (twin.adj.get(f.id) ?? []).filter((e) => e.port === f.port && ((e.relation === 'connected_to' && e.target === f.id) || (e.relation === 'switch_link' && e.source === f.id)));
        if (!hit.length) throw new ImpactInputError(`No link is known on port "${f.port}" of ${sw.label}`);
        for (const e of hit) r.edges.add(e.id);
        r.fabric.add(sw.segment ?? 'none');
        r.failures.push({ failure: f, label: `${f.port} on ${sw.label}` });
        break;
      }
      case 'link': {
        const e = twin.edges.get(f.id);
        if (!e) throw new ImpactInputError(`Unknown link "${f.id}" at this site`);
        r.edges.add(e.id);
        if (e.relation === 'uplink' || e.relation === 'gateway_of') r.upstream = true;
        if (e.relation === 'connected_to' || e.relation === 'switch_link' || e.relation === 'wireless_client') {
          for (const id of [e.source, e.target]) r.fabric.add(twin.nodes.get(id)!.segment ?? 'none');
        }
        const label = e.relation === 'uplink' ? `Internet uplink of ${twin.nodes.get(e.source)!.label}` : `Link ${twin.nodes.get(e.source)!.label} – ${twin.nodes.get(e.target)!.label}`;
        r.failures.push({ failure: f, label });
        break;
      }
      case 'site':
        r.site = true;
        r.upstream = true;
        for (const n of twin.nodes.values()) if (n.kind !== 'internet') r.nodes.add(n.id);
        r.failures.push({ failure: f, label: `Whole site ${twin.siteName}` });
        break;
    }
  }
  return r;
}

const step = (twin: Twin, e: ImpactGraphEdge, from: string, uncertain: boolean): ImpactPathStep => {
  const to = other(e, from);
  return {
    edge_id: e.id,
    from,
    to,
    from_label: twin.nodes.get(from)?.label ?? from,
    to_label: twin.nodes.get(to)?.label ?? to,
    relation: e.relation,
    basis: e.basis,
    confidence: e.confidence,
    evidence: e.evidence,
    evidence_source: e.evidence_source,
    uncertain,
  };
};

/** The edges of `path` (from `start`) up to and including the first one that is failed or leads into a failed node. */
function untilFailure(path: ImpactGraphEdge[], start: string, r: Resolved): { edges: { e: ImpactGraphEdge; from: string }[]; hit: boolean } {
  const out: { e: ImpactGraphEdge; from: string }[] = [];
  let cur = start;
  for (const e of path) {
    out.push({ e, from: cur });
    const next = other(e, cur);
    if (r.edges.has(e.id) || r.nodes.has(next)) return { edges: out, hit: true };
    cur = next;
  }
  return { edges: out, hit: false };
}

export function simulate(twin: Twin, failures: ImpactFailure[], now = new Date()): ImpactResult {
  const r = resolveFailures(twin, failures);
  const isUncertain = (e: ImpactGraphEdge) => e.unknown_attachment && r.fabric.has(e.segment ?? 'none');

  const pre = widest(twin, [ROOT]);
  const post = reach(twin, [ROOT], r.nodes, r.edges, isUncertain);

  const collectors = [...twin.nodes.values()].filter((n) => n.kind === 'collector');
  // A collector runs checks while it and the device it runs on are up.
  const alive = (c: ImpactGraphNode) =>
    !r.nodes.has(c.id) && (twin.adj.get(c.id) ?? []).filter((e) => e.relation === 'runs_on').every((e) => !r.edges.has(e.id) && !r.nodes.has(other(e, c.id)));
  const runners = collectors.filter(alive).map((c) => c.id);
  const gateways = [...twin.nodes.values()].filter((n) => n.kind === 'gateway' && !r.nodes.has(n.id)).map((n) => n.id);
  const lanBlocked = new Set([...r.nodes, ROOT]);
  const core = reach(twin, [...runners, ...gateways], lanBlocked, r.edges, isUncertain);
  const disturbed = r.upstream || r.fabric.size > 0;

  // ── devices, switches, gateways ──
  const devices: ImpactedDevice[] = [];
  const statusOf = new Map<string, { status: DeviceImpactStatus; confidence: Confidence }>();
  for (const n of twin.nodes.values()) {
    if (n.kind === 'internet' || n.kind === 'segment' || n.kind === 'collector') continue;
    const base = { node_id: n.id, device_id: n.device_id, label: n.label, ip: n.ip, kind: n.kind, is_critical: n.is_critical };
    let item: ImpactedDevice | null = null;
    if (r.nodes.has(n.id)) {
      item = { ...base, status: 'failed', confidence: 'high', reason: r.site ? 'Part of the failed site.' : 'Selected as failed.', path: [] };
    } else {
      const p = post.get(n.id);
      if (p && p.cost > 0) {
        const path = pathTo(post, n.id);
        let cur = n.id;
        const steps = path.map((e) => {
          const s = step(twin, e, cur, isUncertain(e));
          cur = s.to;
          return s;
        });
        const via = steps.find((s) => s.uncertain);
        item = {
          ...base,
          status: 'attachment_unknown',
          confidence: 'low',
          reason: `Still reachable only through an unobserved attachment to ${via?.to_label ?? 'its segment'}; the failed element may be on its real path.`,
          path: steps,
        };
      } else if (!p) {
        if (!pre.has(n.id)) {
          if (disturbed && (r.upstream || r.fabric.has(n.segment ?? 'none'))) {
            item = { ...base, status: 'attachment_unknown', confidence: 'low', reason: 'No path to the internet is known for it (no collector sees its segment), so the impact cannot be computed.', path: [] };
          }
        } else {
          const { edges } = untilFailure(pathTo(pre, n.id), n.id, r);
          const steps = edges.map(({ e, from }) => step(twin, e, from, false));
          const confidence = minConf(edges.map(({ e }) => e.confidence));
          const lan = core.get(n.id);
          if (lan) {
            item = {
              ...base,
              status: 'internet_lost',
              confidence: lan.cost > 0 ? 'low' : confidence,
              reason: `Loses its path to the internet${lan.cost > 0 ? '; it may still reach the site core through an unobserved attachment' : ' but still reaches the site core (gateway / collector)'}.`,
              path: steps,
            };
          } else {
            const into = steps[steps.length - 1];
            item = { ...base, status: 'cut_off', confidence, reason: `Every known path runs through ${into ? into.to_label : 'the failed element'}.`, path: steps };
          }
        }
      }
    }
    if (item) {
      devices.push(item);
      statusOf.set(n.id, { status: item.status, confidence: item.confidence });
    }
  }

  // ── collectors ──
  const collectorItems: ImpactedCollector[] = [];
  for (const c of collectors) {
    if (r.nodes.has(c.id)) collectorItems.push({ collector_id: c.collector_id!, name: c.label, status: 'failed', reason: 'Selected as failed.' });
    else if (!alive(c)) collectorItems.push({ collector_id: c.collector_id!, name: c.label, status: 'cut_off', reason: 'The device it runs on fails.' });
    else if (!post.has(c.id)) collectorItems.push({ collector_id: c.collector_id!, name: c.label, status: 'internet_lost', reason: 'Keeps measuring the LAN and buffers results, but loses its path to the internet.' });
  }

  // ── checks ──
  const preRunnersLan = widest(twin, collectors.map((c) => c.id), new Set([ROOT]));
  const preRunnersAll = widest(twin, collectors.map((c) => c.id));
  const postRunnersLan = reach(twin, runners, lanBlocked, r.edges, isUncertain);
  const postRunnersAll = reach(twin, runners, r.nodes, r.edges, isUncertain);
  const checks: ImpactedCheck[] = [];
  for (const k of twin.checks) {
    if (!collectors.length) break; // nothing runs checks at this site today
    const bound = bindCheck(twin, k);
    const base = { check_id: k.id, name: k.name, role: k.role, kind: k.kind, target: k.target, target_binding: bound?.text ?? null };
    if (!runners.length) {
      checks.push({ ...base, status: 'down', confidence: 'high', reason: 'No collector of this site is left to run it.', path: [] });
      continue;
    }
    if (!bound) {
      if (disturbed) checks.push({ ...base, status: 'may_go_down', confidence: 'low', reason: 'Its target is not in the device inventory, so what it depends on is unknown.', path: [] });
      continue;
    }
    if (r.nodes.has(bound.node)) {
      checks.push({ ...base, status: 'down', confidence: bound.confidence, reason: `Its target ${twin.nodes.get(bound.node)!.label} fails.`, path: [] });
      continue;
    }
    const internet = bound.node === ROOT;
    const got = (internet ? postRunnersAll : postRunnersLan).get(bound.node);
    if (got && got.cost === 0) continue;
    const preMap = internet ? preRunnersAll : preRunnersLan;
    const prePath = pathTo(preMap, bound.node);
    // Walk from the collector end so the path reads collector → target.
    const ordered = [...prePath].reverse();
    let cur = endOf(prePath, bound.node);
    const steps = ordered.map((e) => {
      const s = step(twin, e, cur, isUncertain(e));
      cur = s.to;
      return s;
    });
    if (got) {
      checks.push({ ...base, status: 'may_go_down', confidence: 'low', reason: 'Its target is still reachable only through an unobserved attachment.', path: steps });
    } else {
      const conf = minConf([bound.confidence, ...prePath.map((e) => e.confidence)]);
      const failedOn = steps.find((s) => r.edges.has(s.edge_id) || r.nodes.has(s.to));
      checks.push({
        ...base,
        status: 'down',
        confidence: conf,
        reason: internet
          ? 'No collector keeps a path to the internet.'
          : `No collector keeps a path to ${twin.nodes.get(bound.node)!.label}${failedOn ? ` (the path ran through ${failedOn.to_label})` : ''}.`,
        path: steps,
      });
    }
  }

  // ── managed computers ──
  const endpoints: ImpactedEndpoint[] = [];
  for (const ep of twin.endpoints) {
    const base = { endpoint_id: ep.id, name: ep.name, device_id: ep.device_id };
    if (!ep.device_id || !twin.nodes.has(`dev:${ep.device_id}`)) {
      if (disturbed) endpoints.push({ ...base, status: 'attachment_unknown', confidence: 'low', reason: 'Not linked to a discovered device, so where it is connected is unknown.' });
      continue;
    }
    const s = statusOf.get(`dev:${ep.device_id}`);
    if (!s) continue;
    if (s.status === 'failed' || s.status === 'cut_off') endpoints.push({ ...base, status: 'unreachable', confidence: s.confidence, reason: s.status === 'failed' ? 'Its device fails.' : 'Its device is cut off.' });
    else if (s.status === 'internet_lost')
      endpoints.push({ ...base, status: 'internet_lost', confidence: s.confidence, reason: 'Its device loses the internet: the agent reaches the server only if the server is inside this site.' });
    else endpoints.push({ ...base, status: 'attachment_unknown', confidence: 'low', reason: 'Its device may be affected (unobserved attachment).' });
  }

  // ── the site ──
  const reasons: string[] = [];
  const monitoring: SiteImpact['monitoring'] = !collectors.length ? 'none' : runners.length ? 'kept' : 'blind';
  if (monitoring === 'blind') reasons.push('No collector is left running: the site becomes invisible to monitoring.');
  // The site keeps the internet while a gateway that is still up keeps its uplink.
  const gwNodes = [...twin.nodes.values()].filter((n) => n.kind === 'gateway');
  const gwCosts = gwNodes.filter((g) => !r.nodes.has(g.id)).map((g) => post.get(g.id)?.cost).filter((c): c is number => c !== undefined);
  let internetState: SiteImpact['internet'] = 'unknown';
  if (r.site) internetState = 'lost';
  else if (gwCosts.includes(0)) internetState = 'kept';
  else if (!gwCosts.length && gwNodes.some((g) => pre.has(g.id))) internetState = 'lost';
  if (internetState === 'lost') reasons.push('No path from the site to the internet remains.');
  const dark = monitoring === 'blind' || internetState === 'lost';
  const sites: SiteImpact[] = [{ site_id: twin.siteId, name: twin.siteName, dark, internet: internetState, monitoring, reasons }];

  const count = (s: DeviceImpactStatus) => devices.filter((d) => d.status === s).length;
  const order: Record<DeviceImpactStatus, number> = { failed: 0, cut_off: 1, internet_lost: 2, attachment_unknown: 3 };
  devices.sort((a, b) => order[a.status] - order[b.status] || Number(b.is_critical) - Number(a.is_critical) || RANK[b.confidence] - RANK[a.confidence] || a.label.localeCompare(b.label));
  checks.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'down' ? -1 : 1));

  const limitations = [...twin.limitations];
  if (!collectors.length) limitations.unshift('No collector is enrolled at this site: checks and the site core cannot be evaluated.');
  return {
    site_id: twin.siteId,
    generated_at: now.toISOString(),
    failures: r.failures,
    devices,
    checks,
    endpoints,
    collectors: collectorItems,
    sites,
    summary: {
      devices_failed: count('failed'),
      devices_cut_off: count('cut_off'),
      devices_internet_lost: count('internet_lost'),
      devices_attachment_unknown: count('attachment_unknown'),
      checks_down: checks.filter((c) => c.status === 'down').length,
      checks_may_go_down: checks.filter((c) => c.status === 'may_go_down').length,
      endpoints_unreachable: endpoints.filter((e) => e.status === 'unreachable').length,
      endpoints_attachment_unknown: endpoints.filter((e) => e.status === 'attachment_unknown').length,
      sites_dark: sites.filter((s) => s.dark).length,
    },
    highlight: {
      failed: [...r.nodes].filter((id) => twin.nodes.get(id)?.kind !== 'collector'),
      impacted: devices.filter((d) => d.status === 'cut_off' || d.status === 'internet_lost').map((d) => d.node_id),
      uncertain: devices.filter((d) => d.status === 'attachment_unknown').map((d) => d.node_id),
      edges: [...r.edges],
    },
    limitations,
  };
}

/** The source end of a path returned by pathTo(map, target): the node reached by walking from target. */
function endOf(path: ImpactGraphEdge[], target: string): string {
  let cur = target;
  for (const e of path) cur = other(e, cur);
  return cur;
}

/** Ties a check's target to a graph node, with how sure that tie is. */
export function bindCheck(twin: Pick<Twin, 'nodes'>, k: CheckFact): { node: string; confidence: Confidence; text: string } | null {
  const nodes = [...twin.nodes.values()];
  if (k.device_id && twin.nodes.has(`dev:${k.device_id}`)) {
    return { node: `dev:${k.device_id}`, confidence: 'high', text: `Linked to ${twin.nodes.get(`dev:${k.device_id}`)!.label}` };
  }
  if (k.role === 'internet') return { node: ROOT, confidence: 'high', text: 'Internet check: needs the uplink' };
  if (k.role === 'gateway') {
    const ip = k.last_resolved_target ?? (isIPv4(k.target) ? k.target : null);
    const gw = nodes.find((n) => n.kind === 'gateway' && n.ip === ip) ?? nodes.find((n) => n.kind === 'gateway');
    return gw ? { node: gw.id, confidence: 'high', text: `Gateway check: follows the default gateway ${gw.label}` } : null;
  }
  if (isIPv4(k.target)) {
    const dev = nodes.find((n) => n.ip === k.target && (n.kind === 'device' || n.kind === 'switch' || n.kind === 'gateway'));
    if (dev) return { node: dev.id, confidence: 'medium', text: `Target ${k.target} is the current address of ${dev.label}` };
    if (isPublicAddress(k.target)) return { node: ROOT, confidence: 'high', text: `Target ${k.target} is a public address, reached through the uplink` };
    return null;
  }
  if (k.role === 'dns') return { node: ROOT, confidence: 'medium', text: 'Resolves a name: public names need the resolver and the uplink' };
  return null;
}

// ───────────────────────────── single points of failure ─────────────────────────────

const MAX_CANDIDATES = 300;

export function findSpofs(twin: Twin, now = new Date()): SpofReport {
  const { points, bridges } = articulation(twin.nodes.keys(), twin.edges.values(), ROOT);
  const candidates: { target: ImpactFailure; node: string | null; edge: string | null }[] = [];
  for (const id of points) {
    const n = twin.nodes.get(id)!;
    if (n.kind === 'segment' || n.kind === 'internet') continue; // a segment is a logical grouping, not equipment
    candidates.push({ target: n.kind === 'collector' ? { type: 'collector', id: n.collector_id! } : { type: 'node', id }, node: id, edge: null });
  }
  for (const id of bridges) {
    const e = twin.edges.get(id)!;
    if (e.relation === 'uplink') candidates.push({ target: { type: 'link', id }, node: null, edge: id });
  }
  // The only collector of a site blinds monitoring when it fails, although no device depends on it.
  const cols = [...twin.nodes.values()].filter((n) => n.kind === 'collector');
  if (cols.length === 1) candidates.push({ target: { type: 'collector', id: cols[0]!.collector_id! }, node: cols[0]!.id, edge: null });

  const items: SpofEntry[] = [];
  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    const res = simulate(twin, [c.target], now);
    const impacted = res.devices.filter((d) => d.status === 'cut_off' || d.status === 'internet_lost');
    const down = res.checks.filter((k) => k.status === 'down');
    const unreachable = res.endpoints.filter((e) => e.status === 'unreachable');
    const site = res.sites[0]!;
    const blast = impacted.length + down.length + unreachable.length;
    if (!blast && !site.dark) continue;
    const label = c.edge ? res.failures[0]!.label : twin.nodes.get(c.node!)!.label;
    const evidence: string[] = [];
    const cut = impacted.filter((d) => d.status === 'cut_off').length;
    const lost = impacted.length - cut;
    if (impacted.length) evidence.push(`Every known path of ${impacted.length} device(s) runs through it${cut && lost ? ` (${cut} cut off, ${lost} lose the internet)` : cut ? ' (cut off)' : ' (they lose the internet)'}; no alternative path is known.`);
    const example = impacted.find((d) => d.path.length);
    const into = example?.path[example.path.length - 1];
    if (into) evidence.push(`Example: ${example!.label} — ${into.evidence}`);
    if (down.length) evidence.push(`${down.length} monitoring check(s) would go down: ${down.slice(0, 3).map((k) => k.name).join(', ')}${down.length > 3 ? '…' : ''}.`);
    if (unreachable.length) evidence.push(`${unreachable.length} managed computer(s) would become unreachable.`);
    if (site.dark) evidence.push(...site.reasons);
    const unknown = res.devices.filter((d) => d.status === 'attachment_unknown').length;
    if (unknown) evidence.push(`${unknown} more device(s) may depend on it: their attachment was not observed.`);
    items.push({
      target: c.target,
      node_id: c.node,
      edge_id: c.edge,
      label,
      kind: c.edge ? 'link' : twin.nodes.get(c.node!)!.kind,
      blast_radius: blast,
      devices_impacted: impacted.length,
      critical_devices_impacted: impacted.filter((d) => d.is_critical).length,
      checks_down: down.length,
      endpoints_unreachable: unreachable.length,
      site_dark: site.dark,
      attachment_unknown: unknown,
      confidence: maxConf([...impacted.map((d) => d.confidence), ...down.map((k) => k.confidence)]),
      evidence,
    });
  }
  items.sort((a, b) => b.blast_radius - a.blast_radius || b.critical_devices_impacted - a.critical_devices_impacted || Number(b.site_dark) - Number(a.site_dark) || a.label.localeCompare(b.label));
  const limitations = [
    'Single points of failure are articulation points of the evidence graph rooted at the internet: equipment whose loss disconnects something. Redundant links that were never observed cannot be credited.',
    ...twin.limitations,
  ];
  if (candidates.length > MAX_CANDIDATES) limitations.unshift(`Only the first ${MAX_CANDIDATES} of ${candidates.length} candidates were evaluated.`);
  return { site_id: twin.siteId, generated_at: now.toISOString(), items, limitations };
}
