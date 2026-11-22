import { describe, expect, it } from 'vitest';
import { addressScope, classifyTarget, compareIp, discoveryMethod, validateScope } from '../src/common/net.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector } from './helpers.ts';

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
