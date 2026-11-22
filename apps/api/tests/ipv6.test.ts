import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addressScope, classifyTarget, compareIp, discoveryMethod, validateScope } from '../src/common/net.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { bigToIp, buildPlan, ipToBig, rangeOf } from '../src/modules/ipam/plan.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

describe('IPv6 network scopes', () => {
  it('accepts LAN prefixes of bounded size and refuses everything else, with a reason code', () => {
    expect(validateScope('fd12:3456:789a:1::42/64')).toEqual({ ok: true, cidr: 'fd12:3456:789a:1::/64' });
    expect(validateScope('2a01:4f8:1:2::/64')).toEqual({ ok: true, cidr: '2a01:4f8:1:2::/64' });
    expect(validateScope('fe80::/64')).toEqual({ ok: true, cidr: 'fe80::/64' });
    expect(validateScope('fd00:1::/48').ok).toBe(true);
    expect(validateScope('fd00::/47').code).toBe('ipv6_too_large');
    for (const bad of ['2001:db8::/64', '3fff:1::/48', '2002:c0a8:101::/48', '2001:0:1::/48', '2001:20::/48', 'ff02::/64', '64:ff9b::/96', '::/128']) {
      expect(validateScope(bad).code, bad).toBe('ipv6_not_lan');
    }
    expect(validateScope('::ffff:192.168.1.0/120').code).toBe('ipv6_mapped');
    expect(validateScope('fe80::%eth0/64').code).toBe('invalid_cidr');
    expect(validateScope('::1/128').ok).toBe(false); // loopback only with ALLOW_LOOPBACK_SCOPES
  });

  it('never sweeps an IPv6 prefix larger than /120', () => {
    expect(discoveryMethod('192.168.1.0/24')).toBe('sweep');
    expect(discoveryMethod('fd00::/64')).toBe('neighbor');
    expect(discoveryMethod('fd00::/119')).toBe('neighbor');
    expect(discoveryMethod('fd00::100/120')).toBe('sweep');
  });

  it('classifies IPv6 targets and addresses the same way as the collector', () => {
    expect(classifyTarget('fd00::5')).toEqual({ kind: 'local', family: 6 });
    expect(classifyTarget('2a01:4f8::1')).toEqual({ kind: 'global', family: 6 });
    expect(classifyTarget('::1')).toEqual({ kind: 'loopback', family: 6 });
    for (const refused of ['fe80::1', 'ff02::1', '::', '2001:db8::1', '2002::1', '::ffff:10.0.0.1', 'fe80::1%eth0']) expect(classifyTarget(refused).kind, refused).toBe('refused');
    expect(addressScope('192.168.1.5')).toBe('ipv4');
    expect(addressScope('fe80::1')).toBe('link_local');
    expect(addressScope('fd00::1')).toBe('unique_local');
    expect(addressScope('2a01:4f8::1')).toBe('global');
    expect(['fd00::10', '192.168.1.20', 'fd00::9', '192.168.1.3'].sort(compareIp)).toEqual(['192.168.1.3', '192.168.1.20', 'fd00::9', 'fd00::10']);
  });

  it('authorizes an IPv6 prefix through the API, reports its discovery method and keeps families apart', async () => {
    const a = await newAccount('v6-scope');
    await addScope(a, '192.168.40.0/24');
    const created = await a.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: 'fd00:40::7/64', authorization_confirmed: true });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ cidr: 'fd00:40::/64', family: 6, discovery_method: 'neighbor' });
    const small = await a.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: 'fd00:41::100/120', authorization_confirmed: true });
    expect(small.body).toMatchObject({ family: 6, discovery_method: 'sweep' });
    const overlap = await a.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: 'fd00:40::/48', authorization_confirmed: true });
    expect(overlap.status).toBe(409);
    const doc = await a.agent.post(`/api/v1/sites/${a.siteId}/scopes`).set(CSRF).send({ cidr: '2001:db8::/64', authorization_confirmed: true });
    expect(doc.status).toBe(400);
    expect(doc.body.error).toMatchObject({ code: 'invalid_scope', details: { reason_code: 'ipv6_not_lan' } });
    const list = await a.agent.get(`/api/v1/scopes?site_id=${a.siteId}`);
    expect(list.body.items.map((s: { cidr: string; family: number }) => [s.cidr, s.family])).toEqual([
      ['192.168.40.0/24', 4],
      ['fd00:40::/64', 6],
      ['fd00:41::100/120', 6],
    ]);
    // The collector receives the IPv6 scope in its configuration.
    const c = await newCollector(a);
    const hb = await heartbeat(c);
    expect(hb.body.config.discovery.scopes.map((s: { cidr: string }) => s.cidr)).toContain('fd00:40::/64');
  });

  it('applies the scope rule to IPv6 toolbox and watch targets', async () => {
    const a = await newAccount('v6-targets');
    await addScope(a, 'fd00:50::/64');
    await addScope(a, '2a01:4f8:50:1::/64');
    const c = await newCollector(a);
    await heartbeat(c);
    const run = (tool: string, target: string, port?: number) => a.agent.post('/api/v1/toolbox').set(CSRF).send({ site_id: a.siteId, tool, target, ...(port ? { port } : {}) });
    expect((await run('ping', 'fd00:50::5')).status).toBe(202);
    expect((await run('rdns', 'fd00:50::5')).status).toBe(202);
    expect((await run('tcp', '2a01:4f8:50:1::9', 22)).status).toBe(202); // global address inside a scope: a LAN address
    expect((await run('ping', '2606:4700:4700::1111')).status).toBe(202); // public IPv6: reachability diagnostics
    for (const [tool, target, port] of [
      ['ping', 'fd00:51::5'], // unique-local outside every scope
      ['ping', 'fe80::1'], // link-local: never
      ['ping', 'ff02::1'],
      ['ping', '2001:db8::1'],
      ['tcp', '2606:4700:4700::1111', 443], // public port check
      ['ports', '2606:4700:4700::1111'],
    ] as [string, string, number?][]) {
      const r = await run(tool, target, port);
      expect(r.status, `${tool} ${target}`).toBe(422);
      expect(r.body.error.code).toBe('out_of_scope');
    }

    const check = (target: string, allowPublic = false) =>
      a.agent.post('/api/v1/checks').set(CSRF).send({ site_id: a.siteId, name: `c ${target}`, kind: 'https', target, port: 443, config: { allow_public: allowPublic } });
    expect((await check('fd00:50::10')).status).toBe(201);
    expect((await check('fd00:52::10')).status).toBe(422);
    expect((await check('2606:4700:4700::1111')).body.error.code).toBe('public_not_allowed');
    expect((await check('2606:4700:4700::1111', true)).status).toBe(201);
    expect((await check('fe80::10', true)).status).toBe(400);
    const ping = await a.agent.post('/api/v1/checks').set(CSRF).send({ site_id: a.siteId, name: 'v6 ping', kind: 'icmp', target: 'fd00:50::1' });
    expect(ping.status).toBe(201);
  });
});

/** An IPv6 discovery run as the collector reports it (discovery.Discover6). */
function run6(scopeId: string, hosts: { ip: string; mac?: string; sources: string[]; hostname?: string }[], minutesAgo = 0) {
  const finished = new Date(Date.now() - minutesAgo * 60_000);
  return {
    type: 'discovery_run',
    run_id: randomUUID(),
    scope_id: scopeId,
    trigger: 'scheduled',
    started_at: new Date(finished.getTime() - 4000).toISOString(),
    finished_at: finished.toISOString(),
    hosts_probed: 6,
    hosts,
  };
}

describe('IPv6 discovery ingest', () => {
  it('adds IPv6 addresses to dual-stack devices, creates IPv6-only devices and keeps evidence per address', async () => {
    const a = await newAccount('v6-ingest');
    const v4 = await addScope(a, '192.168.60.0/24');
    const v6 = await addScope(a, 'fd00:60::/64');
    const c = await newCollector(a);
    await heartbeat(c);
    expect((await telemetry(c, [sweep(v4, [{ ip: '192.168.60.10', mac: '00:0c:29:60:00:0a', hostname: 'nas' }], 30)])).body.accepted).toBe(1);

    const first = await telemetry(c, [
      run6(
        v6,
        [
          { ip: 'FD00:60:0:0::10', mac: '00:0c:29:60:00:0a', sources: ['icmpv6_multicast', 'ndp_cache'] }, // dual-stack NAS, upper case on purpose
          { ip: 'fe80::20c:29ff:fe60:a', mac: '00:0c:29:60:00:0a', sources: ['ndp_cache'] }, // its link-local address
          { ip: 'fd00:60::20', mac: '00:0c:29:60:00:14', sources: ['icmpv6', 'ndp_cache'], hostname: 'v6only.lan' }, // IPv6-only device
          { ip: 'fe80::99', mac: '00:0c:29:60:00:99', sources: ['ndp_cache'] }, // only link-local, unknown MAC: no device
          { ip: 'fd00:61::1', sources: ['icmpv6'] }, // outside the scope: dropped and counted
        ],
        20,
      ),
    ]);
    expect(first.body.accepted).toBe(1);
    const run = await systemPool.query<{ hosts_responded: number; hosts_rejected: number }>(`SELECT hosts_responded, hosts_rejected FROM discovery_runs WHERE scope_id = $1`, [v6]);
    expect(run.rows[0]).toEqual({ hosts_responded: 2, hosts_rejected: 1 });

    const list = (await a.agent.get('/api/v1/devices').query({ site_id: a.siteId })).body.items as { id: string; current_ip: string; ipv6_addresses: string[]; status: string; hostname: string | null }[];
    expect(list.map((d) => d.current_ip).sort()).toEqual(['192.168.60.10', 'fd00:60::20']);
    const nas = list.find((d) => d.current_ip === '192.168.60.10')!;
    const only6 = list.find((d) => d.current_ip === 'fd00:60::20')!;
    expect(nas.ipv6_addresses).toEqual(['fd00:60::10']);
    expect(only6).toMatchObject({ status: 'online', hostname: 'v6only.lan', ipv6_addresses: ['fd00:60::20'] });

    const detail = (await a.agent.get(`/api/v1/devices/${nas.id}`)).body;
    expect(detail.addresses.map((x: { ip: string; address_scope: string; current: boolean }) => [x.ip, x.address_scope, x.current])).toEqual([
      ['192.168.60.10', 'ipv4', true],
      ['fd00:60::10', 'unique_local', false],
      ['fe80::20c:29ff:fe60:a', 'link_local', false],
    ]);
    expect(detail.addresses[1]).toMatchObject({ family: 6, sources: ['icmpv6_multicast', 'ndp_cache'], scope_cidr: 'fd00:60::/64' });
    expect(detail.discovery_sources).toEqual(expect.arrayContaining(['icmpv6_multicast', 'ndp_cache']));
    // No address-change event for the dual-stack device: IPv6 addresses are additional, not a move.
    const events = await systemPool.query<{ type: string }>(`SELECT type FROM network_events WHERE device_id = $1`, [nas.id]);
    expect(events.rows.map((e) => e.type)).not.toContain('device_ip_changed');

    // Search matches IPv6 addresses (inventory and global search).
    const found = (await a.agent.get('/api/v1/devices').query({ q: 'fd00:60::10' })).body.items;
    expect(found.map((d: { id: string }) => d.id)).toEqual([nas.id]);
    const global = (await a.agent.get('/api/v1/search').query({ q: 'fd00:60::20' })).body.items;
    expect(global.find((h: { kind: string }) => h.kind === 'device')?.id).toBe(only6.id);

    // Wake-on-LAN is IPv4 only.
    const wake = await a.agent.post(`/api/v1/devices/${only6.id}/wake`).set(CSRF);
    expect(wake.status).toBe(409);
    expect(wake.body.error.code).toBe('wol_ipv4_only');

    // Two IPv6 runs without the IPv6-only device: it goes offline; the dual-stack NAS keeps its IPv4 availability.
    for (const m of [10, 5]) await telemetry(c, [run6(v6, [{ ip: 'fd00:60::10', mac: '00:0c:29:60:00:0a', sources: ['icmpv6_multicast'] }], m)]);
    const after = (await a.agent.get('/api/v1/devices').query({ site_id: a.siteId })).body.items as { id: string; status: string }[];
    expect(after.find((d) => d.id === only6.id)!.status).toBe('offline');
    expect(after.find((d) => d.id === nas.id)!.status).toBe('online');
    const offline = await systemPool.query<{ details: { method: string } }>(`SELECT details FROM network_events WHERE device_id = $1 AND type = 'device_offline'`, [only6.id]);
    expect(offline.rows[0]!.details.method).toContain('ICMPv6');

    // The IPv6-only device shows up over IPv4: IPv4 becomes its current address, without an address-change event.
    await telemetry(c, [sweep(v4, [{ ip: '192.168.60.20', mac: '00:0c:29:60:00:14' }], 1)]);
    const moved = (await a.agent.get(`/api/v1/devices/${only6.id}`)).body;
    expect(moved.current_ip).toBe('192.168.60.20');
    expect(moved.addresses.map((x: { ip: string }) => x.ip)).toEqual(['192.168.60.20', 'fd00:60::20']);
    const changed = await systemPool.query(`SELECT 1 FROM network_events WHERE device_id = $1 AND type = 'device_ip_changed'`, [only6.id]);
    expect(changed.rowCount).toBe(0);
  });

  it('refuses malformed IPv6 hosts at the protocol boundary', async () => {
    const a = await newAccount('v6-proto');
    const v6 = await addScope(a, 'fd00:62::/64');
    const c = await newCollector(a);
    await heartbeat(c);
    for (const ip of ['fe80::1%eth0', 'fd00:62::zz', 'fd00:62::1/64']) {
      const r = await telemetry(c, [run6(v6, [{ ip, sources: ['icmpv6'] }])]);
      expect(r.status === 400 || r.body.rejected?.length === 1, ip).toBe(true);
    }
    const bad = await telemetry(c, [run6(v6, [{ ip: 'fd00:62::1', sources: ['nmap'] }])]);
    expect(bad.status === 400 || bad.body.rejected?.length === 1).toBe(true);
  });
});

describe('IPAM for IPv6 subnets', () => {
  const dev = (id: string, ip: string, mac: string | null, status: 'online' | 'offline' = 'online') => ({ id, ip, label: id, mac, device_type: 'unknown', status, last_seen_at: '2026-11-22T10:00:00.000Z' });
  const rec = (ip: string, kind: 'static' | 'reserved' | 'dhcp_reservation', label: string, mac: string | null = null) => ({ id: ip, site_id: 's', ip, kind, label, mac, notes: null, updated_at: '' });

  it('computes IPv6 ranges exactly: no broadcast, the subnet-router anycast address set aside', () => {
    const m = rangeOf('fd00:70::/64');
    expect(bigToIp(m.network, 6)).toBe('fd00:70::');
    expect(bigToIp(m.first, 6)).toBe('fd00:70::1');
    expect(bigToIp(m.last, 6)).toBe('fd00:70::ffff:ffff:ffff:ffff');
    expect(m.broadcast).toBeNull();
    expect(m.usable).toBe((1n << 64n) - 1n);
    expect(m.netmask).toBe('ffff:ffff:ffff:ffff::');
    expect(rangeOf('fd00:70::/127').usable).toBe(2n); // RFC 6164 point-to-point
    expect(rangeOf('192.168.7.0/24')).toMatchObject({ family: 4, usable: 254n, netmask: '255.255.255.0' });
    expect(ipToBig('fd00:70::1') - ipToBig('fd00:70::')).toBe(1n);
  });

  it('builds a sparse plan with exact counts, bounded next-free and every conflict kind', () => {
    const plan = buildPlan({
      cidr: 'fd00:70::/64',
      devices: [
        dev('a', 'fd00:70::1', '00:0c:29:70:00:01'),
        dev('b', 'fd00:70::1', '00:0c:29:70:00:02'), // two devices online at one address
        dev('c', 'fd00:70::5', '00:0c:29:70:00:05'), // answering at a reserved address
        dev('d', 'fd00:70::6', '00:0c:29:70:00:66'), // not the documented device
        dev('e', 'fd00:70::7', '00:0c:29:70:00:07', 'offline'),
        dev('f', '192.168.70.5', '00:0c:29:70:00:0f'), // other family: never part of an IPv6 plan
      ],
      records: [rec('fd00:70::5', 'reserved', 'Keep free'), rec('fd00:70::6', 'dhcp_reservation', 'Printer', '00:0c:29:70:00:06'), rec('fd00:70::103', 'static', 'Camera')],
      gateway: { ip: 'fd00:70::2', source: 'documented' },
      collectorIps: ['fd00:70::3', 'fe80::1', '192.168.70.2'],
      dhcp: { start: 'fd00:70::100', end: 'fd00:70::1ff' },
    });
    expect(plan.family).toBe(6);
    expect(plan.addresses.map((a) => a.ip)).toEqual(['fd00:70::1', 'fd00:70::2', 'fd00:70::3', 'fd00:70::5', 'fd00:70::6', 'fd00:70::7', 'fd00:70::103']);
    expect(plan.conflicts.map((c) => [c.ip, c.kind])).toEqual([
      ['fd00:70::1', 'duplicate_ip'],
      ['fd00:70::5', 'reserved_in_use'],
      ['fd00:70::6', 'assignment_mismatch'],
      ['fd00:70::103', 'static_in_dhcp_pool'],
    ]);
    expect(plan.counts).toMatchObject({ online: 3, offline: 1, documented_only: 1, usable_exact: '18446744073709551615', free_exact: '18446744073709551610' });
    // Listed addresses (gateway, collector included) are skipped; nothing is enumerated.
    expect(plan.next_free).toEqual(['fd00:70::4', 'fd00:70::8', 'fd00:70::9', 'fd00:70::a', 'fd00:70::b']);
  });

  it('jumps over a DHCP pool when suggesting free addresses, whatever its size', () => {
    const started = performance.now();
    const plan = buildPlan({
      cidr: 'fd00:71::/64',
      devices: [],
      records: [],
      gateway: null,
      collectorIps: [],
      dhcp: { start: 'fd00:71::1', end: 'fd00:71::ffff:ffff:fffe' }, // 2^48 addresses
    });
    expect(plan.next_free).toEqual(['fd00:71::ffff:ffff:ffff', 'fd00:71:0:0:1::', 'fd00:71::1:0:0:1', 'fd00:71::1:0:0:2', 'fd00:71::1:0:0:3']);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('documents IPv6 subnets and addresses, detects conflicts, pages the address list and exports CSV', async () => {
    const a = await newAccount('v6-ipam');
    const scopeId = await addScope(a, 'fd00:72::/64');
    const c = await newCollector(a);
    await heartbeat(c);
    const events = async (type: string) => (await a.agent.get(`/api/v1/events?type=${type}&limit=20`)).body.items;

    // Subnet plan: an IPv6 gateway and DHCPv6 pool; the DNS servers may be of either family.
    const plan = { vlan_id: 70, gateway: 'FD00:72::1', dns_servers: ['fd00:72::53', '192.168.72.53'], dhcp_start: 'fd00:72::1000', dhcp_end: 'fd00:72::1fff', notes: null };
    const put = await a.agent.put(`/api/v1/ipam/subnets/${scopeId}`).set(CSRF).send(plan);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ family: 6, network: 'fd00:72::', broadcast: null, prefix: 64, first_host: 'fd00:72::1', gateway: { ip: 'fd00:72::1', source: 'documented' }, dhcp: { start: 'fd00:72::1000', end: 'fd00:72::1fff' } });
    expect(put.body.dns_servers).toEqual(['fd00:72::53', '192.168.72.53']);
    const mixed = await a.agent.put(`/api/v1/ipam/subnets/${scopeId}`).set(CSRF).send({ ...plan, dhcp_start: '192.168.72.10', dhcp_end: '192.168.72.20' });
    expect(mixed.status).toBe(422);
    const reversed = await a.agent.put(`/api/v1/ipam/subnets/${scopeId}`).set(CSRF).send({ ...plan, dhcp_start: 'fd00:72::1fff', dhcp_end: 'fd00:72::1000' });
    expect(reversed.body.error.code).toBe('invalid_plan');

    // Documented addresses: canonical form, the subnet-router anycast address refused.
    const post = (body: Record<string, unknown>) => a.agent.post('/api/v1/ipam/addresses').set(CSRF).send({ site_id: a.siteId, ...body });
    const reserved = await post({ ip: 'FD00:72:0::50', kind: 'reserved', label: 'Keep free' });
    expect(reserved.status).toBe(201);
    expect(reserved.body.ip).toBe('fd00:72::50');
    expect((await post({ ip: 'fd00:72::', kind: 'static', label: 'Router' })).body.error.code).toBe('not_a_host_address');
    expect((await post({ ip: 'fd00:73::5', kind: 'static', label: 'Elsewhere' })).body.error.code).toBe('not_in_subnet');
    expect((await post({ ip: 'fe80::5%eth0', kind: 'static', label: 'Zone' })).status).toBe(400);
    expect((await post({ ip: 'fd00:72::1234', kind: 'static', label: 'Camera' })).status).toBe(201);
    expect(await events('ip_conflict_detected')).toHaveLength(1); // the static address is inside the DHCPv6 pool

    // Something answers at the reserved address: a conflict, one event naming the device.
    await telemetry(c, [run6(scopeId, [{ ip: 'fd00:72::50', mac: '00:0c:29:72:00:50', sources: ['icmpv6_multicast', 'ndp_cache'], hostname: 'intruder' }, { ip: 'fd00:72::51', mac: '00:0c:29:72:00:51', sources: ['ndp_cache'] }])]);
    const detail = (await a.agent.get(`/api/v1/ipam/subnets/${scopeId}`)).body;
    expect(detail.conflict_list.map((x: { ip: string; kind: string }) => [x.ip, x.kind])).toEqual([
      ['fd00:72::50', 'reserved_in_use'],
      ['fd00:72::1234', 'static_in_dhcp_pool'],
    ]);
    expect(detail).toMatchObject({ online: 2, documented_only: 1, usable_exact: '18446744073709551615', addresses_total: 4, addresses_offset: 0 });
    expect(BigInt(detail.free_exact)).toBe((1n << 64n) - 1n - 3n);
    expect(detail.next_free).toEqual(['fd00:72::2', 'fd00:72::3', 'fd00:72::4', 'fd00:72::5', 'fd00:72::6']);
    const raised = await events('ip_conflict_detected');
    expect(raised).toHaveLength(2);
    expect(raised.find((e: { details: { kind: string } }) => e.details.kind === 'reserved_in_use').details.evidence.join(' ')).toContain('intruder');

    // Paging: a page of the sparse list, or one address on its own.
    const page = (await a.agent.get(`/api/v1/ipam/subnets/${scopeId}`).query({ offset: 1, limit: 2 })).body;
    expect(page.addresses.map((x: { ip: string }) => x.ip)).toEqual(['fd00:72::50', 'fd00:72::51']);
    expect(page).toMatchObject({ addresses_offset: 1, addresses_total: 4 });
    const one = (await a.agent.get(`/api/v1/ipam/subnets/${scopeId}`).query({ ip: 'FD00:72::50' })).body;
    expect(one.addresses).toHaveLength(1);
    expect(one.addresses[0]).toMatchObject({ ip: 'fd00:72::50', state: 'online', conflict: 'reserved_in_use' });
    expect((await a.agent.get(`/api/v1/ipam/subnets/${scopeId}`).query({ limit: 100000 })).status).toBe(400);

    // History of an IPv6 address; CSV export with a file name valid on every system.
    const history = (await a.agent.get('/api/v1/ipam/history').query({ site_id: a.siteId, ip: 'fd00:72::50' })).body.items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ label: 'intruder', current: true });
    const csv = await a.agent.get(`/api/v1/ipam/subnets/${scopeId}/export.csv`);
    expect(csv.headers['content-disposition']).toContain('ipam-fd00-72--_64.csv');
    expect(csv.text).toContain('fd00:72::50,online,intruder');

    // Roles: viewers read, never write.
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await post({ ip: 'fd00:72::60', kind: 'static', label: 'No' })).status).toBe(403);
    expect((await a.agent.get(`/api/v1/ipam/subnets/${scopeId}`)).status).toBe(200);
  });

  it('migration 038 renames the detected conflict event wherever it is named', async () => {
    const a = await newAccount('v6-rename');
    await systemPool.query(
      `INSERT INTO network_events (organization_id, site_id, type, severity, title, source, occurred_at) VALUES ($1, $2, 'ip_conflict', 'warning', 'old', 'platform', now()), ($1, $2, 'ip_conflict_resolved', 'info', 'old', 'platform', now())`,
      [a.organizationId, a.siteId],
    );
    const channel = await systemPool.query<{ id: string }>(
      `INSERT INTO notification_channels (organization_id, kind, name, url, secret_encrypted, event_types) VALUES ($1, 'webhook', 'hook', 'https://hooks.example.test/x', 'x', ARRAY['ip_conflict', 'device_offline']) RETURNING id`,
      [a.organizationId],
    );
    const sql = readFileSync(new URL('../src/database/migrations/038_ipv6.sql', import.meta.url), 'utf8');
    const rename = sql.slice(sql.indexOf('UPDATE network_events'));
    await systemPool.query(rename);
    const types = await systemPool.query<{ type: string }>(`SELECT type FROM network_events WHERE organization_id = $1 ORDER BY type`, [a.organizationId]);
    expect(types.rows.map((r) => r.type)).toEqual(['ip_conflict_detected', 'ip_conflict_resolved']);
    const ch = await systemPool.query<{ event_types: string[] }>(`SELECT event_types FROM notification_channels WHERE id = $1`, [channel.rows[0]!.id]);
    expect(ch.rows[0]!.event_types).toEqual(['ip_conflict_detected', 'device_offline']);
  });
});
