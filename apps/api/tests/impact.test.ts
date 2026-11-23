import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Topology, TopologyEdge, TopologyNode } from '@nigafiy/shared-types';
import { ImpactInputError, articulation, buildTwin, findSpofs, simulate } from '../src/modules/impact/graph.ts';
import { CSRF, app, newAccount, setRole } from './helpers.ts';

/**
 * Digital twin: impact simulation and single points of failure over an evidence graph. The graph
 * below is built by hand (no database) so every expected answer can be checked by reading it:
 *
 *   internet ─uplink─ gw ─Gi0/24─ S1 ─Gi0/1─ S2 ─Gi0/2─ P1 (critical; service check; managed computer)
 *                      │           ├─Gi0/5─ P2 (runs the only collector)
 *                      │           └─Gi0/6─ N1 ─Gi0/7─ S2      (N1 is plugged into both switches)
 *                     seg ─ PR   (printer: only known to be in the segment, attachment unknown)
 */

const SEG = '192.168.1.0/24';
const node = (id: string, kind: TopologyNode['kind'], label: string, extra: Partial<TopologyNode> = {}): TopologyNode => ({
  id,
  kind,
  label,
  device_id: id.startsWith('dev:') ? id.slice(4) : id === 'gw:1' ? 'GW' : null,
  ip: null,
  mac: null,
  vendor: null,
  device_type: null,
  status: 'online',
  is_critical: false,
  runs_collector: false,
  segment: kind === 'internet' ? null : SEG,
  last_seen_at: null,
  ...extra,
});
const edge = (id: string, source: string, target: string, relation: TopologyEdge['relation'], port?: string, basis: TopologyEdge['basis'] = 'observed'): TopologyEdge => ({
  id,
  source,
  target,
  relation,
  ...(port ? { port } : {}),
  basis,
  confidence: 'high',
  evidence: `${relation} ${source} → ${target}`,
  evidence_source: 'test fixture',
  last_verified_at: null,
});

function fixture() {
  const topology: Topology = {
    site_id: 'site-1',
    generated_at: new Date().toISOString(),
    nodes: [
      node('internet', 'internet', 'Internet'),
      node('gw:1', 'gateway', 'Router', { ip: '192.168.1.1' }),
      node(`seg:${SEG}`, 'segment', SEG),
      node('dev:S1', 'device', 'Core switch', { ip: '192.168.1.2', is_switch: true }),
      node('dev:S2', 'device', 'Access switch', { ip: '192.168.1.3', is_switch: true }),
      node('dev:P1', 'device', 'Payroll PC', { ip: '192.168.1.10', is_critical: true }),
      node('dev:P2', 'device', 'Monitor box', { ip: '192.168.1.11' }),
      node('dev:N1', 'device', 'NAS', { ip: '192.168.1.12' }),
      node('dev:PR', 'device', 'Printer', { ip: '192.168.1.13' }),
    ],
    edges: [
      edge('up', 'gw:1', 'internet', 'uplink'),
      edge('gwof', `seg:${SEG}`, 'gw:1', 'gateway_of'),
      edge('gw-s1', 'gw:1', 'dev:S1', 'connected_to', 'Gi0/24'),
      edge('s1-s2', 'dev:S1', 'dev:S2', 'switch_link', 'Gi0/1'),
      edge('p1', 'dev:P1', 'dev:S2', 'connected_to', 'Gi0/2'),
      edge('p2', 'dev:P2', 'dev:S1', 'connected_to', 'Gi0/5'),
      edge('n1a', 'dev:N1', 'dev:S1', 'connected_to', 'Gi0/6'),
      edge('n1b', 'dev:N1', 'dev:S2', 'connected_to', 'Gi0/7'),
      edge('m-pr', 'dev:PR', `seg:${SEG}`, 'member_of', undefined, 'inferred'),
      edge('m-p1', 'dev:P1', `seg:${SEG}`, 'member_of', undefined, 'inferred'), // dropped: P1's port is known
    ],
    limitations: [],
  };
  return buildTwin({
    siteId: 'site-1',
    siteName: 'HQ',
    topology,
    collectors: [{ id: 'c1', name: 'edge', connection_state: 'online', interfaces: [{ name: 'eth0', addresses: ['192.168.1.11/24'] }] }],
    checks: [
      { id: 'k-net', name: 'Internet', kind: 'icmp', role: 'internet', target: '1.1.1.1', device_id: null, last_resolved_target: null, state: 'ok' },
      { id: 'k-p1', name: 'Payroll web', kind: 'tcp', role: 'service', target: '192.168.1.10', device_id: 'P1', last_resolved_target: null, state: 'ok' },
    ],
    endpoints: [{ id: 'ep-p1', name: 'Payroll PC agent', device_id: 'P1' }],
    wireless: [],
  });
}

describe('impact graph (pure)', () => {
  it('articulation points and bridges, with parallel edges counted as redundancy', () => {
    // r - a - b - c, plus a triangle a-d-e-a, plus two parallel edges b=f.
    const nodes = ['r', 'a', 'b', 'c', 'd', 'e', 'f'];
    const edges = [
      { id: '1', source: 'r', target: 'a' },
      { id: '2', source: 'a', target: 'b' },
      { id: '3', source: 'b', target: 'c' },
      { id: '4', source: 'a', target: 'd' },
      { id: '5', source: 'd', target: 'e' },
      { id: '6', source: 'e', target: 'a' },
      { id: '7', source: 'b', target: 'f' },
      { id: '8', source: 'f', target: 'b' },
    ];
    const { points, bridges } = articulation(nodes, edges, 'r');
    expect([...points].sort()).toEqual(['a', 'b']);
    expect([...bridges].sort()).toEqual(['1', '2', '3']); // 7/8 are parallel, the triangle is a cycle
  });

  it('builds the twin: known ports replace "member of segment", the collector sits on the host it reported', () => {
    const twin = fixture();
    expect(twin.edges.has('m-p1')).toBe(false);
    expect(twin.edges.get('m-pr')).toMatchObject({ unknown_attachment: true, confidence: 'medium' }); // inferred high → at most medium
    expect(twin.edges.get('e:col:c1:host')).toMatchObject({ relation: 'runs_on', target: 'dev:P2', basis: 'observed' });
    expect(twin.nodes.get('dev:S1')).toMatchObject({ kind: 'switch', ports: ['Gi0/1', 'Gi0/5', 'Gi0/6', 'Gi0/24'] });
    expect(twin.limitations.join(' ')).toMatch(/1 device\(s\) have no observed switch port/);
  });

  it('failing the access switch cuts off only what has no other path, flags unknown attachments, and follows checks and agents', () => {
    const res = simulate(fixture(), [{ type: 'device', id: 'S2' }]);
    const by = Object.fromEntries(res.devices.map((d) => [d.node_id, d]));
    expect(by['dev:S2']).toMatchObject({ status: 'failed' });
    expect(by['dev:P1']).toMatchObject({ status: 'cut_off', confidence: 'high', is_critical: true });
    expect(by['dev:P1']!.path.at(-1)).toMatchObject({ edge_id: 'p1', to: 'dev:S2' });
    expect(by['dev:N1']).toBeUndefined(); // still reaches the core through the core switch
    expect(by['dev:PR']).toMatchObject({ status: 'attachment_unknown', confidence: 'low' }); // never assumed safe
    expect(res.checks).toEqual([expect.objectContaining({ check_id: 'k-p1', status: 'down' })]);
    expect(res.endpoints).toEqual([expect.objectContaining({ endpoint_id: 'ep-p1', status: 'unreachable' })]);
    expect(res.sites[0]).toMatchObject({ dark: false, internet: 'kept', monitoring: 'kept' });
    expect(res.summary).toMatchObject({ devices_failed: 1, devices_cut_off: 1, devices_attachment_unknown: 1, checks_down: 1, endpoints_unreachable: 1, sites_dark: 0 });
  });

  it('a port failure is absorbed by a redundant path; failing the redundancy too cuts the branch off', () => {
    const twin = fixture();
    const one = simulate(twin, [{ type: 'port', id: 'dev:S1', port: 'Gi0/1' }]);
    expect(one.devices.filter((d) => d.status === 'cut_off' || d.status === 'internet_lost')).toEqual([]);
    expect(one.highlight.edges).toEqual(['s1-s2']);
    const both = simulate(twin, [{ type: 'port', id: 'dev:S1', port: 'Gi0/1' }, { type: 'device', id: 'N1' }]);
    expect(both.devices.filter((d) => d.status === 'cut_off').map((d) => d.node_id).sort()).toEqual(['dev:P1', 'dev:S2']);
  });

  it('losing the uplink keeps the LAN but loses the internet and darkens the site', () => {
    const res = simulate(fixture(), [{ type: 'link', id: 'up' }]);
    const lost = res.devices.filter((d) => d.status === 'internet_lost').map((d) => d.node_id).sort();
    // The printer too: whatever its real port, its segment's gateway is the only way out.
    expect(lost).toEqual(['dev:N1', 'dev:P1', 'dev:P2', 'dev:PR', 'dev:S1', 'dev:S2', 'gw:1']);
    expect(res.checks).toEqual([expect.objectContaining({ check_id: 'k-net', status: 'down' })]);
    expect(res.collectors).toEqual([expect.objectContaining({ collector_id: 'c1', status: 'internet_lost' })]);
    expect(res.sites[0]).toMatchObject({ dark: true, internet: 'lost', monitoring: 'kept' });
  });

  it('the only collector failing blinds monitoring: every check goes down', () => {
    const res = simulate(fixture(), [{ type: 'collector', id: 'c1' }]);
    expect(res.sites[0]).toMatchObject({ monitoring: 'blind', dark: true });
    expect(res.checks.map((k) => k.status)).toEqual(['down', 'down']);
    expect(res.devices).toEqual([]);
  });

  it('rejects unknown elements instead of guessing', () => {
    const twin = fixture();
    expect(() => simulate(twin, [{ type: 'node', id: 'dev:nope' }])).toThrow(ImpactInputError);
    expect(() => simulate(twin, [{ type: 'port', id: 'dev:S1', port: 'Gi9/9' }])).toThrow(/No link is known on port/);
    expect(() => simulate(twin, [{ type: 'link', id: 'nope' }])).toThrow(ImpactInputError);
  });

  it('single points of failure: router, uplink, both switches, the collector and its host — not the dual-homed NAS', () => {
    const report = findSpofs(fixture());
    const labels = report.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Router', 'Internet uplink of Router', 'Core switch', 'Access switch', 'Monitor box', 'edge']));
    expect(labels).not.toContain('NAS');
    expect(labels).not.toContain('Printer');
    expect(labels).not.toContain('Payroll PC');
    // Largest blast radius first.
    const radii = report.items.map((i) => i.blast_radius);
    expect([...radii].sort((a, b) => b - a)).toEqual(radii);

    const access = report.items.find((i) => i.label === 'Access switch')!;
    expect(access).toMatchObject({ target: { type: 'node', id: 'dev:S2' }, devices_impacted: 1, critical_devices_impacted: 1, checks_down: 1, endpoints_unreachable: 1, blast_radius: 3, attachment_unknown: 1, site_dark: false, confidence: 'high' });
    expect(access.evidence.join(' ')).toMatch(/Every known path of 1 device\(s\) runs through it/);
    const collector = report.items.find((i) => i.label === 'edge')!;
    expect(collector).toMatchObject({ target: { type: 'collector', id: 'c1' }, site_dark: true });
    const uplink = report.items.find((i) => i.kind === 'link')!;
    expect(uplink).toMatchObject({ edge_id: 'up', site_dark: true });
    expect(report.limitations[0]).toMatch(/articulation points/);
  });
});

describe('impact API', () => {
  it('serves graph, SPOF and simulation for a site of the caller only, to every role, and validates input', async () => {
    const a = await newAccount('impact-api');
    const other = await newAccount('impact-api-other');
    await setRole(a.email, a.organizationId, 'viewer');

    const graph = await a.agent.get(`/api/v1/impact/graph?site_id=${a.siteId}`);
    expect(graph.status).toBe(200);
    expect(graph.body).toMatchObject({ site_id: a.siteId, nodes: expect.any(Array), edges: expect.any(Array), limitations: expect.any(Array) });
    const spof = await a.agent.get(`/api/v1/impact/spof?site_id=${a.siteId}`);
    expect(spof.status).toBe(200);
    expect(spof.body).toMatchObject({ site_id: a.siteId, items: [] }); // nothing observed yet: nothing claimed
    expect(spof.body.limitations.length).toBeGreaterThan(0);

    const sim = await a.agent.post('/api/v1/impact/simulate').set(CSRF).send({ site_id: a.siteId, failures: [{ type: 'site' }] });
    expect(sim.status).toBe(200);
    expect(sim.body.failures[0].label).toBe('Whole site HQ');
    const bad = await a.agent.post('/api/v1/impact/simulate').set(CSRF).send({ site_id: a.siteId, failures: [{ type: 'node', id: 'dev:missing' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_failure');
    expect((await a.agent.post('/api/v1/impact/simulate').set(CSRF).send({ site_id: a.siteId, failures: [] })).status).toBe(400);
    expect((await a.agent.get('/api/v1/impact/spof')).status).toBe(400);

    // Another organization's site and device are not found; nothing without a session.
    expect((await a.agent.get(`/api/v1/impact/spof?site_id=${other.siteId}`)).status).toBe(404);
    expect((await a.agent.get(`/api/v1/impact/graph?site_id=${other.siteId}`)).status).toBe(404);
    expect((await a.agent.get(`/api/v1/impact/devices/${randomUUID()}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/impact/spof?site_id=${a.siteId}`)).status).toBe(401);
  });
});
