import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addressScope, classifyTarget, compareIp, discoveryMethod, validateScope } from '../src/common/net.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, sweep, telemetry } from './helpers.ts';

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
