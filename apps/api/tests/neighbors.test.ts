import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

const HOSTS = [
  { ip: '192.168.6.1', mac: '00:0c:29:66:00:01', hostname: 'gw.lan' },
  { ip: '192.168.6.2', mac: '00:0c:29:66:00:02', hostname: 'sw-core' },
  { ip: '192.168.6.3', mac: '00:0c:29:66:00:03', hostname: 'sw-access' },
  { ip: '192.168.6.4', mac: '00:0c:29:66:00:04', hostname: 'sw-floor2' },
  { ip: '192.168.6.40', mac: '48:a9:8a:01:02:03', hostname: 'hap-office' },
];

const port = (i: number) => ({
  if_index: i, name: `Gi0/${i}`, descr: `GigabitEthernet0/${i}`, admin_up: true, oper_up: true, speed_mbps: 1000,
  in_errors: 0, out_errors: 0, in_discards: 0, out_discards: 0, in_octets: 1000, out_octets: 2000,
});

const poll = (targetId: string, sysName: string, lldp: Record<string, unknown>[]) => ({
  type: 'snmp_poll',
  ts: new Date().toISOString(),
  target_id: targetId,
  ok: true,
  sys_name: sysName,
  ports: [port(1), port(7), port(8)],
  fdb: [],
  lldp,
});

const announcement = (over: Record<string, unknown> = {}) => ({
  mac: '48:a9:8a:01:02:03',
  source_ip: '192.168.6.40',
  identity: 'hAP-office',
  platform: 'MikroTik',
  version: '7.15.3 (stable)',
  board: 'RB962UiGS-5HacT2HnT',
  interface_name: 'bridge',
  ipv4: '192.168.6.40',
  ipv6: 'fe80::4aa9:8aff:fe01:203',
  uptime_seconds: 93784,
  first_seen_at: new Date(Date.now() - 600_000).toISOString(),
  last_seen_at: new Date().toISOString(),
  ...over,
});

async function office() {
  const a = await newAccount('neighbors');
  const scopeId = await addScope(a, '192.168.6.0/24');
  const c = await newCollector(a);
  await heartbeat(c, { gateway_ip: '192.168.6.1' });
  await telemetry(c, [sweep(scopeId, HOSTS, 1)]);
  const add = async (host: string) => {
    const r = await a.agent.post('/api/v1/switches').set(CSRF).send({ site_id: a.siteId, host, credentials: { version: '2c', community: 'ro-community-x' } });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  return { a, c, add };
}

describe('CDP and MikroTik neighbour tables', () => {
  it('stores each neighbour with its protocol and links switches by name, address or chassis MAC', async () => {
    const { a, c, add } = await office();
    const core = await add('192.168.6.2');
    const access = await add('192.168.6.3');
    const floor2 = await add('192.168.6.4');

    // An unknown protocol is refused by the strict schema (the whole batch).
    const bad = await telemetry(c, [poll(core, 'sw-core', [{ if_index: 8, sys_name: 'x', protocol: 'edp' }])]);
    expect(bad.status).toBe(400);

    const res = await telemetry(c, [
      poll(core, 'sw-core', [
        // CDP device IDs carry a domain and often a serial; the address alone would also match.
        { if_index: 8, sys_name: 'sw-access.example.lan(FOC1234X0YZ)', port_id: 'GigabitEthernet1/0/48', protocol: 'cdp', address: '192.168.6.3', platform: 'cisco WS-C2960X-48FPD-L', version: 'Cisco IOS Software, C2960X' },
        // The MikroTik table identifies by MAC; this one is the floor-2 switch.
        { if_index: 7, sys_name: 'floor2', chassis_id: '00:0c:29:66:00:04', protocol: 'mikrotik', address: '192.168.6.99', platform: 'MikroTik', version: '7.14' },
        { if_index: 1, sys_name: 'SEP001122334455', port_id: 'Port 1', protocol: 'cdp', address: '192.168.6.77', platform: 'Cisco IP Phone 8841' },
      ]),
      poll(access, 'sw-access', []),
      poll(floor2, 'sw-floor2', []),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rejected).toEqual([]);

    const nb = (await a.agent.get(`/api/v1/neighbors?site_id=${a.siteId}`)).body;
    const byPort = Object.fromEntries(nb.switch_neighbors.map((n: any) => [n.port_name, n]));
    expect(byPort['Gi0/8']).toMatchObject({ protocol: 'cdp', address: '192.168.6.3', platform: 'cisco WS-C2960X-48FPD-L', port_id: 'GigabitEthernet1/0/48', switch_name: 'sw-core' });
    expect(byPort['Gi0/7']).toMatchObject({ protocol: 'mikrotik', chassis_id: '00:0c:29:66:00:04' });
    expect(byPort['Gi0/1']).toMatchObject({ protocol: 'cdp', sys_name: 'SEP001122334455' });

    // The switch detail keeps the fields per port.
    const detail = (await a.agent.get(`/api/v1/switches/${core}`)).body;
    expect(detail.ports.find((p: any) => p.if_index === 8).neighbors[0]).toMatchObject({ protocol: 'cdp', address: '192.168.6.3' });

    const topo = (await a.agent.get(`/api/v1/topology?site_id=${a.siteId}`)).body;
    const links = topo.edges.filter((e: any) => e.relation === 'switch_link');
    expect(links).toHaveLength(2);
    const cdp = links.find((e: any) => e.evidence_source.includes('CDP'));
    expect(cdp).toMatchObject({ basis: 'observed', port: 'Gi0/8' });
    expect(cdp.evidence).toContain('CDP neighbour on port Gi0/8');
    expect(cdp.evidence).toContain('by name');
    const mt = links.find((e: any) => e.evidence_source.includes('MikroTik'));
    expect(mt.evidence).toContain('by chassis MAC 00:0c:29:66:00:04');
    // The phone is not a read switch: no link is invented for it.
    expect(links.some((e: any) => e.evidence.includes('SEP001122334455'))).toBe(false);
  });
});

describe('MikroTik MNDP listener', () => {
  it('delivers the site switch, records listener status, stores in-scope announcements and shows them', async () => {
    const { a, c } = await office();
    const hb = (await heartbeat(c)).body;
    expect(hb.config.mndp).toEqual({ enabled: true });

    const status = { state: 'bind_failed', listen: ':5678', error: 'UDP port 5678 is already in use on the collector host', since: new Date().toISOString(), received: 0, malformed: 0, out_of_scope: 0, neighbors: 0 };
    expect((await heartbeat(c, { mndp_status: status })).status).toBe(200);
    expect((await heartbeat(c, { mndp_status: { ...status, state: 'exploded' } })).status).toBe(400);
    let nb = (await a.agent.get(`/api/v1/neighbors?site_id=${a.siteId}`)).body;
    expect(nb.listeners).toHaveLength(1);
    expect(nb.listeners[0].status).toMatchObject({ state: 'bind_failed', error: status.error });

    await heartbeat(c, { mndp_status: { ...status, state: 'listening', error: undefined, received: 3, out_of_scope: 1, neighbors: 1 } });
    const ok = await telemetry(c, [
      { type: 'mndp_neighbors', ts: new Date().toISOString(), neighbors: [announcement(), announcement({ mac: '48:a9:8a:0f:0f:0f', source_ip: '10.9.9.9', ipv4: '10.9.9.9', identity: 'elsewhere' })] },
    ]);
    expect(ok.status).toBe(200);
    expect(ok.body.rejected).toEqual([]);
    nb = (await a.agent.get(`/api/v1/neighbors?site_id=${a.siteId}`)).body;
    expect(nb.mndp).toHaveLength(1); // the out-of-scope source is dropped by the API too
    expect(nb.mndp[0]).toMatchObject({ identity: 'hAP-office', board: 'RB962UiGS-5HacT2HnT', ipv4: '192.168.6.40', ipv6: 'fe80::4aa9:8aff:fe01:203', uptime_seconds: 93784, interface_name: 'bridge', collector_name: 'edge-1' });
    expect(nb.mndp[0].device_id).toBeTruthy(); // matched to the discovered device by MAC
    expect(nb.listeners[0].status).toMatchObject({ state: 'listening', received: 3 });

    // Re-announcing updates the row instead of adding one, and keeps the first-seen time.
    const first = nb.mndp[0].first_seen_at;
    await telemetry(c, [{ type: 'mndp_neighbors', ts: new Date().toISOString(), neighbors: [announcement({ identity: 'hAP-office-renamed', first_seen_at: new Date().toISOString() })] }]);
    nb = (await a.agent.get(`/api/v1/neighbors?site_id=${a.siteId}`)).body;
    expect(nb.mndp).toHaveLength(1);
    expect(nb.mndp[0]).toMatchObject({ identity: 'hAP-office-renamed', first_seen_at: first });

    // Topology: the device carries what it announced, as observed evidence.
    const topo = (await a.agent.get(`/api/v1/topology?site_id=${a.siteId}`)).body;
    const node = topo.nodes.find((n: any) => n.ip === '192.168.6.40');
    expect(node.mndp).toMatchObject({ identity: 'hAP-office-renamed', board: 'RB962UiGS-5HacT2HnT', heard_by: 'edge-1' });
    expect(node.mndp.evidence).toContain('heard by collector "edge-1"');

    // Only out-of-scope sources: the item is rejected.
    const out = await telemetry(c, [{ type: 'mndp_neighbors', ts: new Date().toISOString(), neighbors: [announcement({ source_ip: '10.9.9.9' })] }]);
    expect(out.body.rejected).toHaveLength(1);
  });

  it('lets only an administrator turn the listener off, audited, which clears stored announcements', async () => {
    const { a, c } = await office();
    await telemetry(c, [{ type: 'mndp_neighbors', ts: new Date().toISOString(), neighbors: [announcement()] }]);
    const put = (enabled: boolean) => a.agent.put('/api/v1/neighbors/settings').set(CSRF).send({ site_id: a.siteId, mndp_listen: enabled });

    expect((await a.agent.put('/api/v1/neighbors/settings').set(CSRF).send({ site_id: a.siteId, mndp_listen: 'no' })).status).toBe(400);
    await setRole(a.email, a.organizationId, 'technician');
    expect((await put(false)).status).toBe(403);
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get(`/api/v1/neighbors?site_id=${a.siteId}`)).status).toBe(200); // viewers can read
    expect((await put(false)).status).toBe(403);
    await setRole(a.email, a.organizationId, 'admin');
    expect((await put(false)).status).toBe(200);

    const nb = (await a.agent.get(`/api/v1/neighbors?site_id=${a.siteId}`)).body;
    expect(nb.mndp_listen).toBe(false);
    expect(nb.mndp).toEqual([]);
    expect((await heartbeat(c)).body.config.mndp).toEqual({ enabled: false });
    const late = await telemetry(c, [{ type: 'mndp_neighbors', ts: new Date().toISOString(), neighbors: [announcement()] }]);
    expect(late.body.rejected).toHaveLength(1);
    const audits = (await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'site.mndp_listen'`, [a.organizationId])).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ before: true, after: false, cleared_neighbors: true });

    // Another organization sees nothing of this site.
    const other = await newAccount('neighbors-other');
    expect((await other.agent.get(`/api/v1/neighbors?site_id=${a.siteId}`)).status).toBe(404);
    expect((await other.agent.put('/api/v1/neighbors/settings').set(CSRF).send({ site_id: a.siteId, mndp_listen: true })).status).toBe(404);
  });
});
