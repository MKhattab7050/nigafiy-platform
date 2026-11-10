import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { rate } from '../src/modules/ports/ingest.ts';
import { locate, portRole } from '../src/modules/ports/locate.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

const COMMUNITY = 'very-secret-community-91';
const HOSTS = [
  { ip: '192.168.5.1', mac: '00:0c:29:55:00:01', hostname: 'gw.lan' },
  { ip: '192.168.5.2', mac: '00:0c:29:55:00:02', hostname: 'sw-core' },
  { ip: '192.168.5.10', mac: '00:0c:29:55:00:10', hostname: 'nas' },
  { ip: '192.168.5.11', mac: '00:0c:29:55:00:11', hostname: 'printer' },
  { ip: '192.168.5.20', mac: '00:0c:29:55:00:20', hostname: 'laptop' },
];

const port = (i: number, extra: Record<string, unknown> = {}) => ({
  if_index: i,
  name: `Gi0/${i}`,
  descr: `GigabitEthernet0/${i}`,
  admin_up: true,
  oper_up: true,
  speed_mbps: 1000,
  in_errors: 0,
  out_errors: 0,
  in_discards: 0,
  out_discards: 0,
  in_octets: 1000,
  out_octets: 2000,
  ...extra,
});

function poll(targetId: string, minutesAgo: number, over: Record<string, unknown> = {}) {
  return {
    type: 'snmp_poll',
    ts: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    target_id: targetId,
    ok: true,
    sys_name: 'sw-core',
    sys_descr: 'Test switch',
    ports: [port(1), port(2), port(3, { oper_up: false }), port(8, { alias: 'Uplink' })],
    fdb: [
      { mac: '00:0c:29:55:00:10', if_index: 1, vlan: 0 }, // nas alone on port 1
      { mac: '00:0c:29:55:00:11', if_index: 2, vlan: 10 }, // printer + an unknown address on port 2
      { mac: '00:0c:29:55:00:99', if_index: 2, vlan: 10 },
      // port 8: many addresses, among them the laptop
      ...['20', '31', '32', '33', '34', '35'].map((x) => ({ mac: `00:0c:29:55:00:${x}`, if_index: 8, vlan: 0 })),
    ],
    lldp: [],
    ...over,
  };
}

async function office() {
  const a = await newAccount('ports');
  const scopeId = await addScope(a, '192.168.5.0/24');
  const c = await newCollector(a);
  await heartbeat(c, { gateway_ip: '192.168.5.1' });
  await telemetry(c, [sweep(scopeId, HOSTS, 30)]);
  const list = (await a.agent.get('/api/v1/devices?sort=ip')).body.items as Record<string, any>[];
  const byIp = (ip: string) => list.find((d) => d.current_ip === ip)!;
  const add = (body: Record<string, unknown>) => a.agent.post('/api/v1/switches').set(CSRF).send({ site_id: a.siteId, ...body });
  return { a, c, scopeId, byIp, add };
}

describe('port roles and location', () => {
  it('classifies ports from what was observed', () => {
    expect(portRole({ oper_up: true, mac_count: 1, neighbors: [] })).toBe('edge');
    expect(portRole({ oper_up: true, mac_count: 3, neighbors: [] })).toBe('shared');
    expect(portRole({ oper_up: true, mac_count: 30, neighbors: [] })).toBe('trunk');
    expect(portRole({ oper_up: true, mac_count: 30, neighbors: [{ sys_name: 'sw2' }] })).toBe('uplink');
    expect(portRole({ oper_up: true, mac_count: 0, neighbors: [] })).toBe('idle');
    expect(portRole({ oper_up: false, mac_count: 0, neighbors: [] })).toBe('down');
  });

  it('reports the port closest to the device', () => {
    const s = (over: Record<string, unknown>) => ({
      target_id: 't', switch_name: 'sw', switch_host: '10.0.0.2', if_index: 1, port_name: 'Gi0/1', port_alias: null, vlan: 0, mac_count: 1,
      neighbors: [], oper_up: true, speed_mbps: 1000, last_seen_at: new Date().toISOString(), ...over,
    });
    // Seen on the core's uplink (40 addresses) and alone on an access switch port: the access port wins.
    const loc = locate([s({ switch_name: 'core', port_name: 'Gi1/24', mac_count: 40, neighbors: [{ sys_name: 'access-1' }] }), s({ switch_name: 'access-1', port_name: 'Gi0/7' })])!;
    expect(loc).toMatchObject({ switch_name: 'access-1', port_name: 'Gi0/7', kind: 'direct', confidence: 'high' });
    expect(locate([s({ mac_count: 3 })])).toMatchObject({ kind: 'shared', confidence: 'medium' });
    expect(locate([s({ mac_count: 25 })])).toMatchObject({ kind: 'behind', confidence: 'low', role: 'trunk' });
    expect(locate([])).toBeNull();
  });
});

describe('Port Detective API', () => {
  it('stores credentials encrypted, never returns them, and gives them only to the site collector', async () => {
    const { a, c, add } = await office();
    expect((await add({ host: '10.9.9.9', credentials: { version: '2c', community: COMMUNITY } })).status).toBe(422); // outside the authorized range
    expect((await add({ host: '192.168.5.2', credentials: { version: '3', username: 'u', priv_protocol: 'aes', priv_password: 'longenough' } })).status).toBe(400);
    const created = await add({ host: '192.168.5.2', credentials: { version: '2c', community: COMMUNITY } });
    expect(created.status).toBe(201);
    expect(created.body.poll_queued).toBe(true);
    expect((await add({ host: '192.168.5.2', credentials: { version: '2c', community: 'x' } })).status).toBe(409);

    const list = await a.agent.get('/api/v1/switches');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ host: '192.168.5.2', version: '2c', last_status: 'never', in_scope: true });
    expect(list.body.items[0].device_id).toBeTruthy(); // linked to the discovered device with that address
    const detail = await a.agent.get(`/api/v1/switches/${created.body.id}`);
    for (const text of [JSON.stringify(list.body), JSON.stringify(detail.body), JSON.stringify(created.body)]) {
      expect(text).not.toContain(COMMUNITY);
      expect(text).not.toContain('secret_enc');
    }
    const stored = await systemPool.query(`SELECT secret_enc FROM snmp_targets WHERE id = $1`, [created.body.id]);
    expect(stored.rows[0].secret_enc).toMatch(/^v1:/);
    expect(stored.rows[0].secret_enc).not.toContain(COMMUNITY);
    const audits = await systemPool.query(`SELECT metadata::text AS m FROM audit_logs WHERE organization_id = $1`, [a.organizationId]).catch(() => ({ rows: [] }));
    expect(JSON.stringify(audits.rows)).not.toContain(COMMUNITY);

    // The collector of the site receives what it needs to read the switch, and a "read now" command.
    const hb = (await heartbeat(c)).body;
    expect(hb.config.snmp.targets).toEqual([{ id: created.body.id, host: '192.168.5.2', port: 161, version: '2c', interval_seconds: 300, community: COMMUNITY }]);
    expect(hb.commands.map((x: any) => x.kind)).toContain('poll_snmp');

    // Another site's collector gets nothing; other organizations cannot see or change it.
    const other = await newAccount('ports-other');
    await addScope(other, '192.168.5.0/24');
    const otherCollector = await newCollector(other);
    expect((await heartbeat(otherCollector)).body.config.snmp.targets).toEqual([]);
    expect((await other.agent.get('/api/v1/switches')).body.items).toEqual([]);
    expect((await other.agent.get(`/api/v1/switches/${created.body.id}`)).status).toBe(404);
    expect((await other.agent.delete(`/api/v1/switches/${created.body.id}`).set(CSRF)).status).toBe(404);
    expect((await telemetry(otherCollector, [poll(created.body.id, 0)])).body.rejected).toHaveLength(1);

    await setRole(a.email, a.organizationId, 'technician');
    expect((await add({ host: '192.168.5.1', credentials: { version: '2c', community: 'x' } })).status).toBe(403);
    expect((await a.agent.delete(`/api/v1/switches/${created.body.id}`).set(CSRF)).status).toBe(403);
  });

  it('maps devices to ports, follows moves and tracks errors', async () => {
    const { a, c, byIp, add } = await office();
    const sw = (await add({ host: '192.168.5.2', name: 'Core switch', credentials: { version: '2c', community: COMMUNITY } })).body.id as string;
    expect((await telemetry(c, [poll(sw, 10)])).body).toMatchObject({ accepted: 1, rejected: [] });

    const detail = (await a.agent.get(`/api/v1/switches/${sw}`)).body;
    expect(detail).toMatchObject({ name: 'Core switch', last_status: 'ok', port_count: 4, ports_up: 3, address_count: 9, sys_name: 'sw-core' });
    const p = (i: number) => detail.ports.find((x: any) => x.if_index === i);
    expect(p(1)).toMatchObject({ role: 'edge', mac_count: 1, errors_delta: null });
    expect(p(1).devices.map((d: any) => d.label)).toEqual(['nas']);
    expect(p(2)).toMatchObject({ role: 'shared', mac_count: 2, unknown_addresses: ['00:0c:29:55:00:99'] });
    expect(p(2).devices[0]).toMatchObject({ label: 'printer', vlan: 10 });
    expect(p(3)).toMatchObject({ role: 'down', mac_count: 0 });
    expect(p(8)).toMatchObject({ role: 'trunk', mac_count: 6 });

    const where = async (ip: string) => (await a.agent.get(`/api/v1/devices/${byIp(ip).id}/port`)).body;
    expect((await where('192.168.5.10')).location).toMatchObject({ switch_name: 'Core switch', port_name: 'Gi0/1', kind: 'direct', confidence: 'high' });
    expect((await where('192.168.5.11')).location).toMatchObject({ port_name: 'Gi0/2', kind: 'shared', confidence: 'medium', vlan: 10 });
    expect((await where('192.168.5.20')).location).toMatchObject({ port_name: 'Gi0/8', kind: 'behind', confidence: 'low' });
    expect(await where('192.168.5.1')).toMatchObject({ location: null, reason: 'not_seen', switches_read: 1 });

    const found = (await a.agent.get('/api/v1/ports/find?q=nas')).body.items;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ device: { label: 'nas' }, location: { port_name: 'Gi0/1' } });

    // Second read: the NAS was re-plugged into port 3, port 2 collected 7 errors, LLDP heard a neighbour on port 8.
    const second = poll(sw, 5, {
      ports: [port(1, { oper_up: false }), port(2, { in_errors: 5, out_errors: 2 }), port(3), port(8, { alias: 'Uplink' })],
      lldp: [{ if_index: 8, sys_name: 'sw-access-2', port_id: 'Gi1/0/24' }],
    });
    second.fdb = second.fdb.map((e) => (e.mac === '00:0c:29:55:00:10' ? { ...e, if_index: 3 } : e));
    await telemetry(c, [second]);
    const after = (await a.agent.get(`/api/v1/switches/${sw}`)).body;
    const q = (i: number) => after.ports.find((x: any) => x.if_index === i);
    expect(q(2)).toMatchObject({ errors_delta: 7, delta_seconds: 300 });
    expect(q(1)).toMatchObject({ role: 'down', oper_up: false });
    expect(q(1).oper_changed_at).toBeTruthy();
    expect(q(8)).toMatchObject({ role: 'uplink', neighbors: [{ sys_name: 'sw-access-2', port_id: 'Gi1/0/24' }] });
    expect((await where('192.168.5.10')).location).toMatchObject({ port_name: 'Gi0/3', kind: 'direct' });
    const moves = (await a.agent.get('/api/v1/events?type=device_port_changed&limit=10')).body.items;
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ severity: 'info', details: { from_port: 'Gi0/1', to_port: 'Gi0/3' } });

    // The switch stops answering, then comes back.
    await telemetry(c, [{ type: 'snmp_poll', ts: new Date(Date.now() - 2 * 60_000).toISOString(), target_id: sw, ok: false, error: 'no answer' }]);
    const down = (await a.agent.get('/api/v1/switches')).body.items[0];
    expect(down).toMatchObject({ last_status: 'error', last_error: 'no answer', port_count: 4 }); // last known ports are kept
    expect((await a.agent.get('/api/v1/events?type=switch_unreadable&limit=10')).body.items).toHaveLength(1);
    await telemetry(c, [poll(sw, 0)]);
    expect((await a.agent.get('/api/v1/events?type=switch_readable&limit=10')).body.items).toHaveLength(1);

    // Removing the switch removes what was read from it.
    expect((await a.agent.delete(`/api/v1/switches/${sw}`).set(CSRF)).status).toBe(204);
    expect(await where('192.168.5.10')).toMatchObject({ location: null, reason: 'no_switches' });
  });

  it('derives traffic rates from counters and keeps a history, without inventing values', async () => {
    expect(rate(375_000_000, '0', 300, 1000)).toBe(10_000_000); // 375 MB in 5 minutes = 10 Mb/s
    expect(rate(100, '200', 300, 1000)).toBeNull(); // counter went backwards: the switch restarted
    expect(rate(375_000_000, '0', 7200, 1000)).toBeNull(); // two hours between reads: an average would mislead
    expect(rate(1e12, '0', 300, 100)).toBeNull(); // more than a 100 Mb/s port can carry: counter glitch

    const { a, c, add } = await office();
    const sw = (await add({ host: '192.168.5.2', credentials: { version: '2c', community: COMMUNITY } })).body.id as string;
    const read = (minutesAgo: number, inOctets: number, outOctets: number, extra: Record<string, unknown> = {}) =>
      telemetry(c, [poll(sw, minutesAgo, { ports: [port(1, { in_octets: inOctets, out_octets: outOctets, ...extra }), port(3, { oper_up: false })], fdb: [] })]);

    await read(15, 0, 0);
    let detail = (await a.agent.get(`/api/v1/switches/${sw}`)).body;
    expect(detail.ports[0]).toMatchObject({ in_bps: null, out_bps: null }); // one read is not enough for a rate
    const history = async (range = '6h') => (await a.agent.get(`/api/v1/switches/${sw}/ports/1/history?range=${range}`)).body;
    expect((await history()).points).toEqual([]);

    await read(10, 375_000_000, 37_500_000);
    await read(5, 750_000_000, 75_000_000, { in_errors: 4 });
    detail = (await a.agent.get(`/api/v1/switches/${sw}`)).body;
    expect(detail.ports[0].in_bps).toBeCloseTo(10_000_000, -3);
    expect(detail.ports[0].out_bps).toBeCloseTo(1_000_000, -3);

    await read(0, 1000, 500); // the switch restarted: counters start again from zero
    detail = (await a.agent.get(`/api/v1/switches/${sw}`)).body;
    expect(detail.ports[0]).toMatchObject({ in_bps: null, out_bps: null });

    const h = await history();
    expect(h).toMatchObject({ name: 'Gi0/1', speed_mbps: 1000, bucket_seconds: 300 });
    const known = h.points.filter((x: any) => x.in_bps !== null);
    expect(known).toHaveLength(2);
    expect(known[0].in_bps).toBeCloseTo(10_000_000, -3);
    expect(h.points.reduce((n: number, x: any) => n + x.errors, 0)).toBe(4);
    expect(h.points.some((x: any) => x.in_bps === null)).toBe(true); // the restart is a gap, not a zero
    // A port that stayed down has no history; unknown ports and other organizations get 404.
    expect((await a.agent.get(`/api/v1/switches/${sw}/ports/3/history`)).body.points).toEqual([]);
    expect((await a.agent.get(`/api/v1/switches/${sw}/ports/99/history`)).status).toBe(404);
    const other = await newAccount('ports-hist-other');
    expect((await other.agent.get(`/api/v1/switches/${sw}/ports/1/history`)).status).toBe(404);
  });

  it('draws switch ports on the topology only where a switch proved them', async () => {
    const { a, c, byIp, add } = await office();
    const before = (await a.agent.get(`/api/v1/topology?site_id=${a.siteId}`)).body;
    expect(before.edges.some((e: any) => e.relation === 'connected_to')).toBe(false);
    expect(before.limitations[0]).toContain('no managed switch has been read');

    const sw = (await add({ host: '192.168.5.2', name: 'Core switch', credentials: { version: '2c', community: COMMUNITY } })).body.id as string;
    await telemetry(c, [poll(sw, 1)]);
    const t = (await a.agent.get(`/api/v1/topology?site_id=${a.siteId}`)).body;
    const node = (ip: string) => t.nodes.find((n: any) => n.device_id === byIp(ip).id);
    const link = (ip: string) => t.edges.find((e: any) => e.relation === 'connected_to' && e.source === node(ip).id);
    expect(node('192.168.5.2')).toMatchObject({ is_switch: true });
    expect(link('192.168.5.10')).toMatchObject({ target: node('192.168.5.2').id, port: 'Gi0/1', basis: 'observed', confidence: 'high', evidence_source: 'Switch forwarding table (SNMP)' });
    expect(node('192.168.5.10').attached_to).toBe('Gi0/1 · Core switch');
    expect(link('192.168.5.11')).toMatchObject({ port: 'Gi0/2', confidence: 'medium' }); // shared port
    expect(link('192.168.5.20')).toBeUndefined(); // seen only behind a port with many addresses: not drawn
    expect(link('192.168.5.1')).toBeUndefined(); // never seen by the switch
    expect(t.limitations[0]).toContain('2 device(s) seen on access ports');
    expect(t.limitations[0]).toContain('1 device(s) were seen only behind a trunk');
  });
});
