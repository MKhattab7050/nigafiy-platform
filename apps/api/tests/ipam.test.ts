import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { buildPlan, csvCell, intToIp, ipToInt, subnetMath } from '../src/modules/ipam/plan.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

const HOSTS = [
  { ip: '192.168.7.1', mac: '00:0c:29:77:00:01', hostname: 'gw.lan' },
  { ip: '192.168.7.10', mac: '00:0c:29:77:00:10', hostname: 'nas' },
  { ip: '192.168.7.20', mac: '00:0c:29:77:00:20', hostname: 'printer' },
  { ip: '192.168.7.120', mac: '00:0c:29:77:01:20', hostname: 'laptop' },
];

describe('IPAM arithmetic and rules', () => {
  it('computes subnet boundaries', () => {
    expect(intToIp(ipToInt('192.168.7.255'))).toBe('192.168.7.255');
    const m = subnetMath('192.168.7.0/24');
    expect([intToIp(m.network), intToIp(m.first), intToIp(m.last), intToIp(m.broadcast), m.usable]).toEqual(['192.168.7.0', '192.168.7.1', '192.168.7.254', '192.168.7.255', 254]);
    expect(subnetMath('10.0.0.0/20').usable).toBe(4094);
    expect(subnetMath('10.0.0.4/31').usable).toBe(2); // point-to-point: both addresses usable
    expect(subnetMath('10.0.0.9/30')).toMatchObject({ network: ipToInt('10.0.0.8'), usable: 2 });
  });

  it('separates observed from documented and reports each kind of conflict with evidence', () => {
    const dev = (id: string, ip: string, mac: string, status: 'online' | 'offline' = 'online') => ({ id, ip, label: id, mac, device_type: 'unknown', status, last_seen_at: '2026-01-01T00:00:00.000Z' });
    const rec = (ip: string, kind: 'static' | 'dhcp_reservation' | 'reserved', mac: string | null = null) => ({ id: ip, site_id: 's', ip, kind, label: `doc ${ip}`, mac, notes: null, updated_at: '' });
    const plan = buildPlan({
      cidr: '10.1.1.0/28',
      devices: [dev('a', '10.1.1.2', 'aa:aa:aa:aa:aa:02'), dev('b', '10.1.1.2', 'aa:aa:aa:aa:aa:03'), dev('c', '10.1.1.4', 'aa:aa:aa:aa:aa:04'), dev('d', '10.1.1.5', 'aa:aa:aa:aa:aa:05'), dev('e', '10.1.1.6', 'aa:aa:aa:aa:aa:06', 'offline'), dev('far', '10.9.9.9', 'aa:aa:aa:aa:aa:99')],
      records: [rec('10.1.1.4', 'reserved'), rec('10.1.1.5', 'static', 'bb:bb:bb:bb:bb:05'), rec('10.1.1.6', 'static', 'bb:bb:bb:bb:bb:06'), rec('10.1.1.12', 'static'), rec('10.1.1.7', 'dhcp_reservation', 'aa:aa:aa:aa:aa:07')],
      gateway: { ip: '10.1.1.1', source: 'observed' },
      collectorIps: ['10.1.1.3'],
      dhcp: { start: '10.1.1.10', end: '10.1.1.14' },
    });
    expect(plan.conflicts.map((c) => [c.ip, c.kind])).toEqual([
      ['10.1.1.2', 'duplicate_ip'],
      ['10.1.1.4', 'reserved_in_use'],
      ['10.1.1.5', 'assignment_mismatch'],
      ['10.1.1.12', 'static_in_dhcp_pool'],
    ]);
    expect(plan.conflicts.every((c) => c.evidence.length >= 2)).toBe(true);
    // .6: the documented machine is simply off — an offline device with another MAC is not a conflict.
    expect(plan.addresses.find((a) => a.ip === '10.1.1.6')).toMatchObject({ state: 'offline', conflict: null });
    expect(plan.addresses.find((a) => a.ip === '10.1.1.7')).toMatchObject({ state: 'documented', devices: [] });
    expect(plan.addresses.find((a) => a.ip === '10.1.1.1')).toMatchObject({ state: 'infrastructure', flags: ['gateway_observed'] });
    expect(plan.addresses.find((a) => a.ip === '10.1.1.12')!.flags).toContain('dhcp_pool');
    expect(plan.addresses.some((a) => a.ip === '10.9.9.9')).toBe(false);
    // 14 usable; taken: .2 .4 .5 (online), .6 (offline), .7 .12 (documented only).
    expect(plan.counts).toEqual({ usable: 14, online: 3, offline: 1, documented_only: 2, free: 8, usable_exact: '14', free_exact: '8' });
    // Suggestions skip the gateway, the collector, everything taken and the DHCP pool.
    expect(plan.next_free).toEqual(['10.1.1.8', '10.1.1.9']);
  });

  it('neutralises spreadsheet formulas in exports', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });
});

describe('IPAM API', () => {
  async function office() {
    const a = await newAccount('ipam');
    const scopeId = await addScope(a, '192.168.7.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.7.1' });
    await telemetry(c, [sweep(scopeId, HOSTS, 1)]);
    const post = (body: Record<string, unknown>) => a.agent.post('/api/v1/ipam/addresses').set(CSRF).send({ site_id: a.siteId, ...body });
    const subnet = async () => (await a.agent.get(`/api/v1/ipam/subnets/${scopeId}`)).body;
    return { a, c, scopeId, post, subnet };
  }

  it('shows what is observed, accepts documentation and flags disagreements', async () => {
    const { a, scopeId, post, subnet } = await office();

    const list = (await a.agent.get('/api/v1/ipam/subnets')).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ cidr: '192.168.7.0/24', usable: 254, online: 4, free: 250, conflicts: 0, gateway: { ip: '192.168.7.1', source: 'observed' }, vlan_id: null });

    // Documenting the plan.
    const plan = { vlan_id: 20, gateway: '192.168.7.1', dns_servers: ['192.168.7.1', '1.1.1.1'], dhcp_start: '192.168.7.100', dhcp_end: '192.168.7.199', notes: 'Office LAN' };
    const put = (body: Record<string, unknown>) => a.agent.put(`/api/v1/ipam/subnets/${scopeId}`).set(CSRF).send(body);
    expect((await put({ ...plan, gateway: '10.0.0.1' })).status).toBe(422);
    expect((await put({ ...plan, dhcp_end: null })).status).toBe(422);
    expect((await put({ ...plan, dhcp_start: '192.168.7.200' })).status).toBe(422);
    expect((await put({ ...plan, vlan_id: 5000 })).status).toBe(400);
    const saved = await put(plan);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      vlan_id: 20,
      gateway: { ip: '192.168.7.1', source: 'documented' },
      dns_servers: ['192.168.7.1', '1.1.1.1'],
      dhcp: { start: '192.168.7.100', end: '192.168.7.199' },
      notes: 'Office LAN',
      network: '192.168.7.0',
      broadcast: '192.168.7.255',
      netmask: '255.255.255.0',
      first_host: '192.168.7.1',
      last_host: '192.168.7.254',
    });
    expect(saved.body.next_free[0]).toBe('192.168.7.2');
    expect(saved.body.addresses.find((x: any) => x.ip === '192.168.7.120').flags).toContain('dhcp_pool');

    // Documenting addresses.
    expect((await post({ ip: '10.0.0.5', kind: 'static', label: 'x' })).status).toBe(422); // not in a subnet of the site
    expect((await post({ ip: '192.168.7.255', kind: 'reserved', label: 'x' })).status).toBe(422); // broadcast
    expect((await post({ ip: '192.168.7.30', kind: 'dhcp_reservation', label: 'x' })).status).toBe(422); // needs a MAC
    expect((await post({ ip: '192.168.7.30', kind: 'reserved', label: 'x', mac: '00:0c:29:77:00:30' })).status).toBe(422);
    expect((await post({ ip: '192.168.7.30', kind: 'static', label: 'x', mac: 'nonsense' })).status).toBe(400);
    const nas = await post({ ip: '192.168.7.10', kind: 'static', label: 'NAS', mac: '00-0C-29-77-00-10', notes: 'rack 2' });
    expect(nas.status).toBe(201);
    expect(nas.body).toMatchObject({ ip: '192.168.7.10', kind: 'static', mac: '00:0c:29:77:00:10', notes: 'rack 2' });
    expect((await post({ ip: '192.168.7.10', kind: 'static', label: 'again' })).status).toBe(409);
    const printer = await post({ ip: '192.168.7.20', kind: 'dhcp_reservation', label: 'Old printer', mac: '00:0c:29:77:ff:ff' });
    const spare = await post({ ip: '192.168.7.50', kind: 'reserved', label: 'Future server' });
    expect((await post({ ip: '192.168.7.120', kind: 'static', label: 'Laptop dock' })).status).toBe(201); // static inside the DHCP pool

    let s = await subnet();
    expect(s).toMatchObject({ online: 4, documented_only: 1, free: 249, conflicts: 2 });
    expect(s.conflict_list.map((c: any) => [c.ip, c.kind])).toEqual([
      ['192.168.7.20', 'assignment_mismatch'],
      ['192.168.7.120', 'static_in_dhcp_pool'],
    ]);
    expect(s.addresses.find((x: any) => x.ip === '192.168.7.10')).toMatchObject({ state: 'online', conflict: null, record: { label: 'NAS' }, devices: [{ label: 'nas' }] });
    expect(s.addresses.find((x: any) => x.ip === '192.168.7.50')).toMatchObject({ state: 'documented', devices: [] });
    expect(s.next_free).not.toContain('192.168.7.50');

    // Correcting the record clears the mismatch; editing rules are enforced on the result.
    const patch = (id: string, body: Record<string, unknown>) => a.agent.patch(`/api/v1/ipam/addresses/${id}`).set(CSRF).send(body);
    expect((await patch(printer.body.id, { mac: null })).status).toBe(422);
    expect((await patch(printer.body.id, { mac: '00:0c:29:77:00:20', label: 'Printer' })).body).toMatchObject({ label: 'Printer', mac: '00:0c:29:77:00:20' });
    expect((await patch(spare.body.id, { kind: 'static', notes: '' })).body).toMatchObject({ kind: 'static', notes: null });
    s = await subnet();
    expect(s.conflict_list.map((c: any) => c.kind)).toEqual(['static_in_dhcp_pool']);

    // History of an address, and the export.
    const history = (await a.agent.get(`/api/v1/ipam/history?site_id=${a.siteId}&ip=192.168.7.10`)).body.items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ label: 'nas', mac: '00:0c:29:77:00:10', current: true });
    const csv = await a.agent.get(`/api/v1/ipam/subnets/${scopeId}/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('192.168.7.10,online,nas,00:0c:29:77:00:10');
    expect(csv.text).toContain('192.168.7.50,documented,');

    expect((await a.agent.delete(`/api/v1/ipam/addresses/${spare.body.id}`).set(CSRF)).status).toBe(204);
    expect((await subnet()).addresses.some((x: any) => x.ip === '192.168.7.50')).toBe(false);
    const audits = await systemPool.query<{ action: string }>(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'ipam.%'`, [a.organizationId]);
    expect(new Set(audits.rows.map((r) => r.action))).toEqual(new Set(['ipam.subnet_documented', 'ipam.address_documented', 'ipam.address_updated', 'ipam.address_removed']));
  });

  it('reports something answering at a reserved address', async () => {
    const { c, scopeId, post, subnet } = await office();
    await post({ ip: '192.168.7.60', kind: 'reserved', label: 'Keep free' });
    expect((await subnet()).conflicts).toBe(0);
    await telemetry(c, [sweep(scopeId, [...HOSTS, { ip: '192.168.7.60', mac: '00:0c:29:77:00:60', hostname: 'intruder' }], 0)]);
    const s = await subnet();
    expect(s.conflict_list).toHaveLength(1);
    expect(s.conflict_list[0]).toMatchObject({ ip: '192.168.7.60', kind: 'reserved_in_use' });
    expect(s.conflict_list[0].evidence.join(' ')).toContain('intruder');
  });

  it('raises one event when a conflict appears and one when it clears', async () => {
    const { a, c, scopeId, post } = await office();
    const events = async (type: string) => (await a.agent.get(`/api/v1/events?type=${type}&limit=20`)).body.items;
    await post({ ip: '192.168.7.60', kind: 'reserved', label: 'Keep free' });
    expect(await events('ip_conflict_detected')).toHaveLength(0);

    const withIntruder = [...HOSTS, { ip: '192.168.7.60', mac: '00:0c:29:77:00:60', hostname: 'intruder' }];
    await telemetry(c, [sweep(scopeId, withIntruder, 0)]);
    let raised = await events('ip_conflict_detected');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: 'warning', details: { ip: '192.168.7.60', kind: 'reserved_in_use' } });
    expect(raised[0].device_id).toBeTruthy();
    expect(raised[0].details.evidence.join(' ')).toContain('intruder');

    // The same situation on the next sweep is not a new event.
    await telemetry(c, [sweep(scopeId, withIntruder, 0)]);
    expect(await events('ip_conflict_detected')).toHaveLength(1);

    // A documentation-only inconsistency is informational.
    await a.agent.put(`/api/v1/ipam/subnets/${scopeId}`).set(CSRF).send({ vlan_id: null, gateway: null, dns_servers: [], dhcp_start: '192.168.7.100', dhcp_end: '192.168.7.199', notes: null });
    await post({ ip: '192.168.7.150', kind: 'static', label: 'Camera' });
    raised = await events('ip_conflict_detected');
    expect(raised).toHaveLength(2);
    expect(raised.find((e: any) => e.details.kind === 'static_in_dhcp_pool')).toMatchObject({ severity: 'info' });

    // Updating the record to say the address is now assigned clears the first conflict.
    const record = (await a.agent.get(`/api/v1/ipam/subnets/${scopeId}`)).body.addresses.find((x: any) => x.ip === '192.168.7.60').record;
    await a.agent.patch(`/api/v1/ipam/addresses/${record.id}`).set(CSRF).send({ kind: 'static', label: 'New server' });
    const resolved = await events('ip_conflict_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].details).toMatchObject({ ip: '192.168.7.60', kind: 'reserved_in_use' });
    expect(await events('ip_conflict_detected')).toHaveLength(2);
  });

  it('enforces roles and keeps organizations apart', async () => {
    const { a, scopeId, post } = await office();
    const record = (await post({ ip: '192.168.7.10', kind: 'static', label: 'NAS' })).body;
    const plan = { vlan_id: null, gateway: null, dns_servers: [], dhcp_start: null, dhcp_end: null, notes: null };

    const other = await newAccount('ipam-other');
    await addScope(other, '192.168.7.0/24');
    expect((await other.agent.get('/api/v1/ipam/subnets')).body.items[0]).toMatchObject({ online: 0, documented_only: 0 });
    expect((await other.agent.get(`/api/v1/ipam/subnets/${scopeId}`)).status).toBe(404);
    expect((await other.agent.get(`/api/v1/ipam/subnets/${scopeId}/export.csv`)).status).toBe(404);
    expect((await other.agent.put(`/api/v1/ipam/subnets/${scopeId}`).set(CSRF).send(plan)).status).toBe(404);
    expect((await other.agent.patch(`/api/v1/ipam/addresses/${record.id}`).set(CSRF).send({ label: 'mine' })).status).toBe(404);
    expect((await other.agent.delete(`/api/v1/ipam/addresses/${record.id}`).set(CSRF)).status).toBe(404);
    expect((await other.agent.post('/api/v1/ipam/addresses').set(CSRF).send({ site_id: a.siteId, ip: '192.168.7.11', kind: 'static', label: 'x' })).status).toBe(404);
    expect((await other.agent.get(`/api/v1/ipam/history?site_id=${a.siteId}&ip=192.168.7.10`)).body.items).toEqual([]);

    // Technicians document addresses; only admins change the subnet plan; viewers only read.
    await setRole(a.email, a.organizationId, 'technician');
    expect((await post({ ip: '192.168.7.11', kind: 'static', label: 'ok' })).status).toBe(201);
    expect((await a.agent.put(`/api/v1/ipam/subnets/${scopeId}`).set(CSRF).send(plan)).status).toBe(403);
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await post({ ip: '192.168.7.12', kind: 'static', label: 'no' })).status).toBe(403);
    expect((await a.agent.delete(`/api/v1/ipam/addresses/${record.id}`).set(CSRF)).status).toBe(403);
    expect((await a.agent.get(`/api/v1/ipam/subnets/${scopeId}`)).status).toBe(200);
  });
});
