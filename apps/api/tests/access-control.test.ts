import { describe, expect, it } from 'vitest';
import { internetOff, mergeRules, normalizeDomain } from '../src/modules/access/policy.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

const HOSTS = [
  { ip: '192.168.9.1', mac: '00:0c:29:99:00:01', hostname: 'gw.lan' },
  { ip: '192.168.9.30', mac: '00:0c:29:99:00:30', hostname: 'kid-tablet' },
  { ip: '192.168.9.40', mac: '00:0c:29:99:00:40', hostname: 'laptop' },
];

async function home() {
  const a = await newAccount('acc');
  const scopeId = await addScope(a, '192.168.9.0/24');
  const c = await newCollector(a);
  await heartbeat(c, { gateway_ip: '192.168.9.1', interfaces: [{ name: 'eth0', addresses: ['192.168.9.40/24', 'fe80::1/64'] }] });
  await telemetry(c, [sweep(scopeId, HOSTS, 5)]);
  const list = (await a.agent.get('/api/v1/devices?sort=ip')).body.items as Record<string, any>[];
  const byIp = (ip: string) => list.find((d) => d.current_ip === ip)!;
  return { a, c, scopeId, tablet: byIp('192.168.9.30'), laptop: byIp('192.168.9.40') };
}

describe('access control rules', () => {
  it('normalizes domains', () => {
    expect(normalizeDomain('https://www.TikTok.com/@x?y')).toBe('tiktok.com');
    expect(normalizeDomain('*.example.org.')).toBe('example.org');
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
  });

  it('merges layers and evaluates pauses and bedtimes in the site time zone', () => {
    const now = new Date('2026-11-10T20:30:00Z'); // Tuesday 22:30 in Cairo (UTC+2)
    const rule = mergeRules(
      now,
      { blocked_categories: ['ads_malware'], blocked_domains: ['a.com'], allowed_domains: [] },
      { blocked_categories: ['social', 'bogus'], blocked_domains: ['b.com'], allowed_domains: ['ok.com'], schedule: [{ days: [2], from: '22:00', to: '07:00' }], paused_until: '2026-11-10T19:00:00Z' },
      { blocked_categories: [], blocked_domains: ['a.com'], allowed_domains: [], paused_until: null },
    );
    expect(rule).toEqual({
      blocked_categories: ['ads_malware', 'social'],
      blocked_domains: ['a.com', 'b.com'],
      allowed_domains: ['ok.com'],
      schedule: [{ days: [2], from: '22:00', to: '07:00' }],
    });
    expect(internetOff(rule, now, 'Africa/Cairo')).toBe('schedule');
    expect(internetOff(rule, now, 'UTC')).toBeNull(); // 20:30 UTC is before 22:00
    expect(internetOff(rule, new Date('2026-11-11T04:00:00Z'), 'Africa/Cairo')).toBe('schedule'); // Wed 06:00, Tuesday night window
    expect(internetOff({ ...rule, schedule: [], paused_until: '2026-11-10T21:00:00Z' }, now)).toBe('paused');
  });
});

describe('access control API', () => {
  it('delivers nothing to the collector until filtering is turned on', async () => {
    const { a, c } = await home();
    expect((await heartbeat(c, { gateway_ip: '192.168.9.1', interfaces: [{ name: 'eth0', addresses: ['192.168.9.40/24'] }] })).body.config.access).toEqual({ enabled: false });
    const page = (await a.agent.get(`/api/v1/access?site_id=${a.siteId}`)).body;
    expect(page.settings.enabled).toBe(false);
    expect(page.setup.dns_server_ip).toBe('192.168.9.40'); // the collector host's address inside the authorized range
    expect(page.setup.gateway_ip).toBe('192.168.9.1');
    expect(page.categories).toContain('adult');
    const codes = (await a.agent.get('/api/v1/insights')).body.insights.map((i: any) => i.code);
    expect(codes).toContain('access_off');
  });

  it('builds per-device rules from site, profile and device layers', async () => {
    const { a, c, tablet, laptop } = await home();
    const on = await a.agent
      .put('/api/v1/access/settings')
      .set(CSRF)
      .send({ site_id: a.siteId, enabled: true, blocked_categories: ['ads_malware'], blocked_domains: ['https://www.Evil.example/x'] });
    expect(on.status).toBe(200);
    expect((await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, blocked_domains: ['no spaces allowed'] })).status).toBe(400);

    const kids = await a.agent
      .post(`/api/v1/access/profiles?site_id=${a.siteId}`)
      .set(CSRF)
      .send({ name: 'Kids', blocked_categories: ['social', 'adult'], schedule: [{ days: [0, 1, 2, 3, 4], from: '22:00', to: '07:00' }] });
    expect(kids.status).toBe(201);
    expect((await a.agent.post(`/api/v1/access/profiles?site_id=${a.siteId}`).set(CSRF).send({ name: 'kids' })).status).toBe(409);
    expect(
      (await a.agent.post(`/api/v1/access/profiles?site_id=${a.siteId}`).set(CSRF).send({ name: 'Bad', schedule: [{ days: [1], from: '25:00', to: '07:00' }] })).status,
    ).toBe(400);

    expect((await a.agent.patch(`/api/v1/devices/${tablet.id}/access`).set(CSRF).send({ profile_id: kids.body.id, allowed_domains: ['khanacademy.org'] })).status).toBe(200);
    const paused = await a.agent.post(`/api/v1/devices/${laptop.id}/pause`).set(CSRF).send({ minutes: 30 });
    expect(paused.status).toBe(200);

    const access = (await heartbeat(c)).body.config.access;
    expect(access.enabled).toBe(true);
    expect(access.default).toMatchObject({ blocked_categories: ['ads_malware'], blocked_domains: ['evil.example'] });
    const tabletRule = access.clients.find((x: any) => x.mac === '00:0c:29:99:00:30');
    expect(tabletRule.ip).toBe('');
    expect(tabletRule.rule).toMatchObject({
      blocked_categories: ['ads_malware', 'adult', 'social'],
      blocked_domains: ['evil.example'],
      allowed_domains: ['khanacademy.org'],
      schedule: [{ days: [0, 1, 2, 3, 4], from: '22:00', to: '07:00' }],
    });
    const laptopRule = access.clients.find((x: any) => x.mac === '00:0c:29:99:00:40');
    expect(new Date(laptopRule.rule.paused_until).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

    // Resume, and the laptop no longer needs its own rule.
    await a.agent.post(`/api/v1/devices/${laptop.id}/pause`).set(CSRF).send({ minutes: null });
    expect((await heartbeat(c)).body.config.access.clients.map((x: any) => x.mac)).toEqual(['00:0c:29:99:00:30']);

    // Pausing the whole profile pauses every device in it.
    await a.agent.post(`/api/v1/access/profiles/${kids.body.id}/pause`).set(CSRF).send({ minutes: 60 });
    expect((await heartbeat(c)).body.config.access.clients[0].rule.paused_until).toBeTruthy();

    const page = (await a.agent.get(`/api/v1/access?site_id=${a.siteId}`)).body;
    expect(page.profiles).toMatchObject([{ name: 'Kids', device_count: 1 }]);
    expect(page.devices.find((d: any) => d.id === tablet.id)).toMatchObject({ profile_name: 'Kids', internet_off: 'paused', protected: false });

    // Deleting the profile releases its devices.
    expect((await a.agent.delete(`/api/v1/access/profiles/${kids.body.id}`).set(CSRF)).status).toBe(204);
    expect((await a.agent.get(`/api/v1/access?site_id=${a.siteId}`)).body.devices.find((d: any) => d.id === tablet.id).profile_id).toBeNull();
  });

  it('stores DNS activity per device and reports the filter status', async () => {
    const { a, c, tablet } = await home();
    await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, enabled: true });
    const hb = await heartbeat(c, { access_status: { enabled: true, listening: true, listen: ':53', upstreams: ['192.168.9.1'], lists: { social: 30 } } });
    expect(hb.status).toBe(200);
    const insight = async () => (await a.agent.get('/api/v1/insights')).body.insights.map((i: any) => i.code) as string[];
    expect(await insight()).toContain('access_no_devices');
    const end = new Date();
    const start = new Date(end.getTime() - 5 * 60_000);
    const item = {
      type: 'dns_stats',
      ts: end.toISOString(),
      window_start: start.toISOString(),
      clients: [
        {
          ip: '192.168.9.30',
          mac: '00:0C:29:99:00:30',
          queries: 120,
          blocked: 7,
          top_domains: [
            { domain: 'tiktok.com', count: 7, blocked: 7, reason: 'category', category: 'social' },
            { domain: 'wikipedia.org', count: 40, blocked: 0 },
          ],
        },
        { ip: '192.168.9.77', queries: 3, blocked: 0, top_domains: [] }, // not a known device: kept without a device
      ],
    };
    const res = await telemetry(c, [item]);
    expect(res.body).toMatchObject({ accepted: 1, rejected: [] });
    const bad = await telemetry(c, [{ ...item, window_start: new Date(end.getTime() + 60_000).toISOString() }]);
    expect(bad.body.rejected).toHaveLength(1);

    expect(await insight()).not.toContain('access_no_devices');
    const activity = (await a.agent.get(`/api/v1/devices/${tablet.id}/activity?hours=24`)).body;
    expect(activity).toMatchObject({ queries: 120, blocked: 7 });
    expect(activity.domains[0]).toMatchObject({ domain: 'tiktok.com', blocked: 7, category: 'social' });
    const page = (await a.agent.get(`/api/v1/access?site_id=${a.siteId}`)).body;
    expect(page.setup.status).toMatchObject({ listening: true });
    expect(page.setup.protected_devices).toBe(1);
    expect(page.devices.find((d: any) => d.id === tablet.id)).toMatchObject({ protected: true, queries_24h: 120, blocked_24h: 7 });
  });

  it('enforces roles and tenant isolation', async () => {
    const { a, tablet } = await home();
    const other = await newAccount('acc-other');
    expect((await other.agent.get(`/api/v1/access?site_id=${a.siteId}`)).status).toBe(404);
    expect((await other.agent.post(`/api/v1/devices/${tablet.id}/pause`).set(CSRF).send({ minutes: 5 })).status).toBe(404);
    expect((await other.agent.get(`/api/v1/devices/${tablet.id}/activity`)).status).toBe(404);
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, enabled: true })).status).toBe(403);
    expect((await a.agent.post(`/api/v1/devices/${tablet.id}/pause`).set(CSRF).send({ minutes: 5 })).status).toBe(200);
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.post(`/api/v1/devices/${tablet.id}/pause`).set(CSRF).send({ minutes: 5 })).status).toBe(403);
  });
});
