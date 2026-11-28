import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { internetOff } from '../src/modules/access/policy.ts';
import { watchCollectors } from '../src/modules/collectors/index.ts';
import { guessPlatform } from '../src/modules/endpoints/enrollment/suggest.ts';
import { scopeCandidates } from '../src/modules/sites/scope-suggestions.ts';
import { type TestAccount, CSRF, addScope, app, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

// Smart defaults / automation: system actor in the audit log, automation settings, and every
// automatic behaviour or suggestion built on them. Each automatic action must be switchable and
// leave a system audit entry; each inferred fact must say so.

const auditLogs = async (a: TestAccount) => (await a.agent.get('/api/v1/audit-logs?limit=200')).body.items as Record<string, any>[];
const systemEntries = async (a: TestAccount, key: string) => (await auditLogs(a)).filter((e) => e.actor === 'system' && e.metadata.automation === key);
const devices = async (a: TestAccount) => (await a.agent.get('/api/v1/devices?sort=ip')).body.items as Record<string, any>[];
const setAutomation = (a: TestAccount, key: string, body: Record<string, unknown>) => a.agent.put(`/api/v1/automation/${key}`).set(CSRF).send(body);

// ── 1 + 2: system actor, automation settings ──
describe('automation settings', () => {
  it('lists the catalogue with effective state, resolves site over org over default, and records changes', async () => {
    const a = await newAccount('auto');
    let list = await a.agent.get('/api/v1/automation');
    expect(list.status).toBe(200);
    expect(list.body.site_id).toBeNull();
    const keys = list.body.items.map((i: any) => i.key);
    expect(keys).toEqual([
      'incident.refresh_measurements', 'classify.switch_from_snmp', 'suggest.monitor_infrastructure',
      'suggest.knowledge_from_incidents',
      'smart.rogue_dhcp', 'smart.upnp_audit', 'smart.wifi_analyzer', 'smart.banner_probe', 'smart.dhcp_fingerprint', 'router.reserve_own_address',
    ]);
    const refresh = list.body.items[0];
    expect(refresh).toMatchObject({
      owner: 'correlation',
      kind: 'act',
      enabled: true,
      default_enabled: true,
      source: 'default',
      config: { min_interval_minutes: 5 },
      default_config: { min_interval_minutes: 5 },
      org_override: null,
      site_override: null,
      last_effect: { count: 0, last_at: null, window_days: 30 },
    });
    expect(refresh.description_key).toBe('automation.incident_refresh_measurements');

    // Organization off, site back on: the site row wins for that site only.
    expect((await setAutomation(a, 'incident.refresh_measurements', { enabled: false })).body).toMatchObject({ enabled: false, source: 'org' });
    const siteOn = await setAutomation(a, 'incident.refresh_measurements', { site_id: a.siteId, enabled: true, config: { min_interval_minutes: 10 } });
    expect(siteOn.status).toBe(200);
    expect(siteOn.body).toMatchObject({ enabled: true, source: 'site', config: { min_interval_minutes: 10 }, org_override: { enabled: false }, site_override: { enabled: true } });
    list = await a.agent.get(`/api/v1/automation?site_id=${a.siteId}`);
    expect(list.body.items[0]).toMatchObject({ enabled: true, source: 'site' });
    expect((await a.agent.get('/api/v1/automation')).body.items[0]).toMatchObject({ enabled: false, source: 'org' });

    // Updating without config keeps the stored config.
    expect((await setAutomation(a, 'incident.refresh_measurements', { site_id: a.siteId, enabled: false })).body.config).toEqual({ min_interval_minutes: 10 });

    // Reset removes the override: the organization row applies again.
    const reset = await a.agent.delete(`/api/v1/automation/incident.refresh_measurements?site_id=${a.siteId}`).set(CSRF);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ enabled: false, source: 'org', site_override: null });

    // Validation: unknown key, config of the wrong shape, missing enabled.
    expect((await setAutomation(a, 'nope.unknown', { enabled: true })).status).toBe(404);
    expect((await setAutomation(a, 'incident.refresh_measurements', { enabled: true, config: { min_interval_minutes: 0 } })).status).toBe(400);
    expect((await setAutomation(a, 'incident.refresh_measurements', { enabled: true, config: { surprise: 1 } })).status).toBe(400);
    expect((await setAutomation(a, 'incident.refresh_measurements', { config: {} })).status).toBe(400);

    // Every change is audited as a user action; audit entries carry the actor.
    const logs = await auditLogs(a);
    expect(logs.filter((e) => e.action === 'automation.updated').length).toBe(3);
    expect(logs.find((e) => e.action === 'automation.reset')).toMatchObject({ actor: 'user', metadata: { key: 'incident.refresh_measurements', site_id: a.siteId } });
    expect(logs.every((e) => ['user', 'system', 'collector'].includes(e.actor))).toBe(true);
    expect(logs.find((e) => e.action === 'organization.created')?.actor).toBe('user');
  });

  it('enforces roles and tenant isolation', async () => {
    const a = await newAccount('auto-roles');
    const b = await newAccount('auto-other');
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get('/api/v1/automation')).status).toBe(200);
    expect((await setAutomation(a, 'classify.switch_from_snmp', { enabled: false })).status).toBe(403);
    expect((await a.agent.delete('/api/v1/automation/classify.switch_from_snmp').set(CSRF)).status).toBe(403);
    await setRole(a.email, a.organizationId, 'technician');
    expect((await setAutomation(a, 'classify.switch_from_snmp', { enabled: false })).status).toBe(403);
    await setRole(a.email, a.organizationId, 'admin');
    expect((await setAutomation(a, 'classify.switch_from_snmp', { enabled: false })).status).toBe(200);

    // Another organization neither sees nor changes this one's settings, and cannot name its site.
    expect((await b.agent.get(`/api/v1/automation?site_id=${a.siteId}`)).status).toBe(404);
    expect((await setAutomation(b, 'classify.switch_from_snmp', { site_id: a.siteId, enabled: true })).status).toBe(404);
    expect((await b.agent.get('/api/v1/automation')).body.items[1]).toMatchObject({ key: 'classify.switch_from_snmp', enabled: true, source: 'default' });
    expect((await a.agent.get('/api/v1/automation')).body.items[1]).toMatchObject({ enabled: false, source: 'org' });
    const rows = await systemPool.query(`SELECT organization_id FROM automation_settings WHERE organization_id = ANY($1)`, [[a.organizationId, b.organizationId]]);
    expect(rows.rows.map((r) => r.organization_id)).toEqual([a.organizationId]);
  });
});

// ── 3: scope suggestions ──
describe('scope suggestions', () => {
  it('derives candidate networks from interfaces and gateway, narrowing what is too large', () => {
    const c = scopeCandidates([
      {
        id: 'c1',
        name: 'edge-1',
        gateway_ip: '10.20.0.1',
        interfaces: [
          { name: 'eth0', addresses: ['192.168.50.20/24', 'fe80::1/64'] },
          { name: 'eth1', addresses: ['10.20.5.7/16'] },
          { name: 'wg0', addresses: ['172.16.9.1/32', '8.8.4.4/24', 'garbage'] },
        ],
      },
      { id: 'c2', name: 'edge-2', gateway_ip: '192.168.77.1', interfaces: [{ name: 'eth0', addresses: ['192.168.50.21/24'] }] },
    ]);
    const by = (cidr: string) => c.find((x) => x.cidr === cidr)!;
    expect(c.map((x) => x.cidr).sort()).toEqual(['10.20.0.0/24', '10.20.5.0/24', '192.168.50.0/24', '192.168.77.0/24']);
    // The gateway sits on the reported /16 too: the /24 around it, with the reported size as evidence.
    expect(by('10.20.0.0/24')).toMatchObject({ inferred: true, confidence: 'medium', reported_cidr: '10.20.0.0/16' });
    expect(by('10.20.0.0/24').sources).toEqual([{ kind: 'gateway', collector_id: 'c1', collector_name: 'edge-1', interface: null, reported: '10.20.0.1' }]);
    expect(by('192.168.50.0/24')).toMatchObject({ inferred: false, confidence: 'high', reported_cidr: null });
    expect(by('192.168.50.0/24').sources.map((s) => s.collector_name)).toEqual(['edge-1', 'edge-2']);
    expect(by('10.20.5.0/24')).toMatchObject({ inferred: true, confidence: 'medium', reported_cidr: '10.20.0.0/16' });
    expect(by('10.20.5.0/24').evidence.join(' ')).toContain('65,536 addresses');
    expect(by('192.168.77.0/24')).toMatchObject({ inferred: true, confidence: 'low' });
    expect(by('192.168.77.0/24').sources[0]).toMatchObject({ kind: 'gateway', interface: null, reported: '192.168.77.1' });
  });

  it('suggests only uncovered private networks, never creates a scope, and is tenant-scoped', async () => {
    const a = await newAccount('scopes');
    const c = await newCollector(a);
    await heartbeat(c, {
      gateway_ip: '192.168.60.1',
      interfaces: [
        { name: 'eth0', addresses: ['192.168.60.15/24'] },
        { name: 'eth1', addresses: ['10.1.2.3/16'] },
      ],
    });
    let res = await a.agent.get(`/api/v1/sites/${a.siteId}/scope-suggestions`);
    expect(res.status).toBe(200);
    expect(res.body.site_id).toBe(a.siteId);
    expect(res.body.items.map((i: any) => i.cidr)).toEqual(['192.168.60.0/24', '10.1.2.0/24']);
    expect(res.body.items[0]).toMatchObject({ narrowed: false, inferred: false, confidence: 'high' });
    expect(res.body.items[0].sources).toEqual([
      { kind: 'interface', collector_id: c.id, collector_name: 'edge-1', interface: 'eth0', reported: '192.168.60.15/24' },
      { kind: 'gateway', collector_id: c.id, collector_name: 'edge-1', interface: null, reported: '192.168.60.1' },
    ]);
    expect(res.body.items[1]).toMatchObject({ narrowed: true, inferred: true, confidence: 'medium', reported_cidr: '10.1.0.0/16' });
    expect((await a.agent.get('/api/v1/scopes')).body.items).toHaveLength(0); // suggesting created nothing

    // Authorizing stays explicit; once authorized, the network is no longer suggested.
    await addScope(a, res.body.items[0].cidr);
    res = await a.agent.get(`/api/v1/sites/${a.siteId}/scope-suggestions`);
    expect(res.body.items.map((i: any) => i.cidr)).toEqual(['10.1.2.0/24']);

    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get(`/api/v1/sites/${a.siteId}/scope-suggestions`)).status).toBe(200);
    const b = await newAccount('scopes-other');
    expect((await b.agent.get(`/api/v1/sites/${a.siteId}/scope-suggestions`)).status).toBe(404);
    expect((await b.agent.get(`/api/v1/sites/${b.siteId}/scope-suggestions`)).body.items).toEqual([]);
  });
});

// ── 4: time zones ──
describe('site time zones', () => {
  it('accepts a validated IANA zone at registration and on sites; default stays UTC', async () => {
    const agent = request.agent(app);
    const base = { password: 'correct horse battery', display_name: 'tz', organization_name: 'tz corp' };
    const bad = await agent.post('/api/v1/auth/register').set(CSRF).send({ ...base, email: `tz-bad-${Date.now()}@example.test`, timezone: 'Mars/Olympus_Mons' });
    expect(bad.status).toBe(400);
    expect((await agent.post('/api/v1/auth/register').set(CSRF).send({ ...base, email: `tz-off-${Date.now()}@example.test`, timezone: '+02:00' })).status).toBe(400);
    const ok = await agent.post('/api/v1/auth/register').set(CSRF).send({ ...base, email: `tz-${Date.now()}@example.test`, timezone: 'africa/cairo' });
    expect(ok.status).toBe(201);
    expect((await agent.get('/api/v1/sites')).body.items[0].timezone).toBe('Africa/Cairo');

    const a = await newAccount('tz-default');
    expect((await a.agent.get('/api/v1/sites')).body.items[0].timezone).toBe('UTC');
    expect((await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Bad', timezone: 'Not/AZone' })).status).toBe(400);
    const berlin = await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Berlin', timezone: 'Europe/Berlin' });
    expect(berlin.status).toBe(201);
    expect(berlin.body.timezone).toBe('Europe/Berlin');
    expect((await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Plain' })).body.timezone).toBe('UTC');

    // PATCH validates the same way, and a field left out keeps its value.
    expect((await a.agent.patch(`/api/v1/sites/${berlin.body.id}`).set(CSRF).send({ timezone: 'Europe/Atlantis' })).status).toBe(400);
    const renamed = await a.agent.patch(`/api/v1/sites/${berlin.body.id}`).set(CSRF).send({ name: 'Berlin office' });
    expect(renamed.body).toMatchObject({ name: 'Berlin office', timezone: 'Europe/Berlin' });
    expect((await a.agent.patch(`/api/v1/sites/${berlin.body.id}`).set(CSRF).send({ timezone: 'Asia/Tokyo' })).body.timezone).toBe('Asia/Tokyo');
  });

  it('evaluates bedtimes in the site zone (not UTC) and tells the collector that zone', async () => {
    const a = await newAccount('tz-bedtime');
    expect((await a.agent.patch(`/api/v1/sites/${a.siteId}`).set(CSRF).send({ timezone: 'Asia/Tokyo' })).status).toBe(200);
    const scopeId = await addScope(a, '192.168.93.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.93.1' });
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.93.30', mac: '00:0c:29:93:00:30', hostname: 'kid-tablet' }], 2)]);
    const tablet = (await devices(a))[0]!;

    // A one-hour bedtime around the current hour in Tokyo (UTC+9, no DST): it is bedtime there, not in UTC.
    const now = new Date();
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]),
    );
    const hour = Number(parts.hour);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
    const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
    const schedule = [{ days: [day], from: hh(hour), to: hh(hour + 1) }];
    expect(internetOff({ blocked_categories: [], blocked_domains: [], allowed_domains: [], schedule }, now, 'Asia/Tokyo')).toBe('schedule');
    expect(internetOff({ blocked_categories: [], blocked_domains: [], allowed_domains: [], schedule }, now, 'UTC')).toBeNull();
    // A zone stored before validation existed is evaluated as UTC instead of failing the page.
    expect(internetOff({ blocked_categories: [], blocked_domains: [], allowed_domains: [], schedule }, now, 'Bogus/Zone')).toBeNull();

    expect((await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, enabled: true })).status).toBe(200);
    expect((await a.agent.patch(`/api/v1/devices/${tablet.id}/access`).set(CSRF).send({ schedule })).status).toBe(200);
    const page = (await a.agent.get(`/api/v1/access?site_id=${a.siteId}`)).body;
    expect(page.devices.find((d: any) => d.id === tablet.id).internet_off).toBe('schedule');

    const access = (await heartbeat(c)).body.config.access;
    expect(access.timezone).toBe('Asia/Tokyo');
    expect(access.clients[0].rule.schedule).toEqual(schedule);
  });
});

// ── 5: monitoring ──
describe('monitoring helpers', () => {
  async function office(label: string) {
    const a = await newAccount(label);
    const scopeId = await addScope(a, '192.168.94.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.94.1' });
    await telemetry(c, [
      sweep(scopeId, [
        { ip: '192.168.94.1', mac: '00:0c:29:94:00:01', hostname: 'gw.lan' },
        { ip: '192.168.94.20', mac: '00:0c:29:94:00:20', hostname: 'laptop' },
      ], 2),
    ]);
    const list = await devices(a);
    return { a, c, scopeId, router: list.find((d) => d.current_ip === '192.168.94.1')!, laptop: list.find((d) => d.current_ip === '192.168.94.20')! };
  }

  it('monitors devices in bulk with per-id results and the single-device rules', async () => {
    const { a, router, laptop } = await office('bulkmon');
    await systemPool.query(`UPDATE devices SET current_ip = NULL WHERE id = $1`, [laptop.id]);
    const missing = '00000000-0000-4000-8000-000000000001';
    const res = await a.agent.post('/api/v1/devices/monitor').set(CSRF).send({ ids: [router.id, laptop.id, missing, router.id] });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.results).toEqual([
      { id: router.id, status: 'created', check_id: expect.any(String), error: null },
      { id: laptop.id, status: 'no_address', check_id: null, error: { code: 'no_address', message: expect.any(String) } },
      { id: missing, status: 'not_found', check_id: null, error: { code: 'not_found', message: 'Device not found' } },
    ]);
    const again = await a.agent.post('/api/v1/devices/monitor').set(CSRF).send({ ids: [router.id] });
    expect(again.body).toEqual({ created: 0, results: [{ id: router.id, status: 'exists', check_id: res.body.results[0].check_id, error: null }] });
    // Same check as the single-device endpoint would have made.
    expect((await a.agent.post(`/api/v1/devices/${router.id}/monitor`).set(CSRF)).body).toEqual({ check_id: res.body.results[0].check_id, created: false });
    expect((await a.agent.post('/api/v1/devices/monitor').set(CSRF).send({ ids: [] })).status).toBe(400);
    expect((await a.agent.post('/api/v1/devices/monitor').set(CSRF).send({ ids: ['x'] })).status).toBe(400);

    // Same permission as POST /devices/:id/monitor (admin); another organization's ids are simply not found.
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.post('/api/v1/devices/monitor').set(CSRF).send({ ids: [router.id] })).status).toBe(403);
    const b = await newAccount('bulkmon-other');
    const other = await b.agent.post('/api/v1/devices/monitor').set(CSRF).send({ ids: [laptop.id] });
    expect(other.body.results[0].status).toBe('not_found');
  });

  it('restores the starter checks idempotently', async () => {
    const a = await newAccount('defaults');
    const checks = async () => (await a.agent.get(`/api/v1/checks?site_id=${a.siteId}`)).body.items as Record<string, any>[];
    let res = await a.agent.post(`/api/v1/sites/${a.siteId}/default-checks`).set(CSRF);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ site_id: a.siteId, created: [] });
    expect(res.body.existing).toHaveLength(4);

    const before = await checks();
    const dns = before.find((c) => c.role === 'dns')!;
    const gw = before.find((c) => c.role === 'gateway')!;
    await a.agent.delete(`/api/v1/checks/${dns.id}`).set(CSRF);
    await a.agent.patch(`/api/v1/checks/${gw.id}`).set(CSRF).send({ name: 'Our router', interval_seconds: 120 });
    res = await a.agent.post(`/api/v1/sites/${a.siteId}/default-checks`).set(CSRF);
    expect(res.status).toBe(201);
    expect(res.body.created).toEqual(['DNS resolution (system resolver)']);
    const after = await checks();
    expect(after).toHaveLength(4);
    expect(after.find((c) => c.id === gw.id)).toMatchObject({ name: 'Our router', interval_seconds: 120 }); // the edited one is untouched
    expect((await a.agent.post(`/api/v1/sites/${a.siteId}/default-checks`).set(CSRF)).body.created).toEqual([]);
    expect((await auditLogs(a)).filter((e) => e.action === 'check.defaults_restored')).toHaveLength(1);

    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.post(`/api/v1/sites/${a.siteId}/default-checks`).set(CSRF)).status).toBe(403);
    const b = await newAccount('defaults-other');
    expect((await b.agent.post(`/api/v1/sites/${a.siteId}/default-checks`).set(CSRF)).status).toBe(404);
  });

  it('proposes monitoring inferred infrastructure, labelled as inferred, only while the automation is on', async () => {
    const { a, router, laptop } = await office('infra');
    expect(router).toMatchObject({ device_type: 'router', type_source: 'inferred' });
    const insight = async () => ((await a.agent.get('/api/v1/insights')).body.insights as any[]).find((i) => i.code === 'suggest_monitor_infrastructure');
    let found = await insight();
    expect(found).toBeTruthy();
    expect(found.devices).toEqual([
      { device_id: router.id, label: 'gw.lan', ip: '192.168.94.1', device_type: 'router', type_confidence: router.type_confidence, inferred: true, evidence: router.type_evidence },
    ]);
    expect(found.evidence[0]).toContain('inferred');
    expect(found.actions[0]).toMatchObject({ code: 'monitor_all', kind: 'api', href: '/api/v1/devices/monitor', body: { ids: [router.id] } });
    expect(found.devices.some((d: any) => d.device_id === laptop.id)).toBe(false);
    expect((await a.agent.get('/api/v1/checks')).body.items.some((c: any) => c.target === '192.168.94.1')).toBe(false); // proposing created nothing

    // Switched off for the site: not proposed; on again: proposed again.
    await setAutomation(a, 'suggest.monitor_infrastructure', { site_id: a.siteId, enabled: false });
    expect(await insight()).toBeUndefined();
    await setAutomation(a, 'suggest.monitor_infrastructure', { site_id: a.siteId, enabled: true });
    expect(await insight()).toBeTruthy();
    // Accepting it is the bulk monitor; afterwards there is nothing left to propose.
    found = await insight();
    expect((await a.agent.post(found.actions[0].href).set(CSRF).send(found.actions[0].body)).body.created).toBe(1);
    expect(await insight()).toBeUndefined();
    // A type set by hand is not an inference, so this rule does not propose it.
    await a.agent.patch(`/api/v1/devices/${laptop.id}`).set(CSRF).send({ device_type: 'nas' });
    expect(await insight()).toBeUndefined();
  });
});

// ── 6: incidents refresh measurements ──
describe('incident measurement refresh', () => {
  const sample = (checkId: string, secondsAgo: number, ok: boolean) => ({
    type: 'check_result',
    check_id: checkId,
    ts: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    ok,
    ...(ok ? { latency_ms: 12, loss_pct: 0 } : { loss_pct: 100, error: 'no echo reply' }),
  });
  const run = (checkId: string, n: number, end: number, ok: boolean) => Array.from({ length: n }, (_, i) => sample(checkId, end + (n - 1 - i) * 10, ok));

  async function site(label: string) {
    const a = await newAccount(label);
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.1.1' });
    const items = (await a.agent.get('/api/v1/checks')).body.items as { id: string; target: string }[];
    const k = (t: string) => items.find((x) => x.target === t)!.id;
    return { a, c, cf: k('1.1.1.1'), google: k('8.8.8.8') };
  }
  const runChecks = async (collectorId: string) =>
    (await systemPool.query<{ id: string; status: string }>(`SELECT id, status FROM collector_commands WHERE collector_id = $1 AND kind = 'run_checks' ORDER BY created_at`, [collectorId])).rows;

  it('queues run_checks when a network incident opens, records it, and rate-limits per site', async () => {
    const { a, c, cf, google } = await site('refresh');
    await telemetry(c, [...run(cf, 3, 600, false), ...run(google, 3, 600, false)]);
    const incident = (await a.agent.get('/api/v1/incidents?status=active')).body.items[0];
    expect(incident).toMatchObject({ kind: 'network' });
    let cmds = await runChecks(c.id);
    expect(cmds).toHaveLength(1);
    const hb = await heartbeat(c);
    expect(hb.body.commands).toEqual([expect.objectContaining({ kind: 'run_checks' })]);
    const entries = await systemEntries(a, 'incident.refresh_measurements');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'system', user_email: null, action: 'collector.run_checks_queued', target_type: 'incident', target_id: incident.id });
    expect(entries[0]!.metadata).toMatchObject({ site_id: a.siteId, collectors: [c.id], incident_kind: 'network' });
    const listed = (await a.agent.get(`/api/v1/automation?site_id=${a.siteId}`)).body.items[0];
    expect(listed.last_effect).toMatchObject({ count: 1 });
    expect(listed.last_effect.last_at).toBeTruthy();

    // Flapping: it recovers and fails again within minutes — no second command.
    await heartbeat(c, { completed_commands: [cmds[0]!.id] });
    await telemetry(c, [...run(cf, 3, 400, true), ...run(google, 3, 400, true)]);
    expect((await a.agent.get('/api/v1/incidents?status=active')).body.items).toHaveLength(0);
    await telemetry(c, [...run(cf, 3, 200, false), ...run(google, 3, 200, false)]);
    expect((await a.agent.get('/api/v1/incidents?status=active')).body.items).toHaveLength(1);
    cmds = await runChecks(c.id);
    expect(cmds).toHaveLength(1);
    expect(await systemEntries(a, 'incident.refresh_measurements')).toHaveLength(1);
  });

  it('never makes the incident fail to open when the refresh itself fails', async () => {
    const { a, c, cf, google } = await site('refresh-broken');
    // Make the automation's own lookup fail inside the tenant transaction.
    await systemPool.query(`REVOKE SELECT ON automation_settings FROM lan_app`);
    try {
      const res = await telemetry(c, [...run(cf, 3, 600, false), ...run(google, 3, 600, false)]);
      expect(res.status).toBeLessThan(300);
    } finally {
      await systemPool.query(`GRANT SELECT ON automation_settings TO lan_app`);
    }
    expect((await a.agent.get('/api/v1/incidents?status=active')).body.items).toEqual([expect.objectContaining({ kind: 'network' })]);
    expect(await runChecks(c.id)).toHaveLength(0);
  });

  it('does nothing when switched off, and queues for the other collectors when one goes silent', async () => {
    const off = await site('refresh-off');
    await setAutomation(off.a, 'incident.refresh_measurements', { site_id: off.a.siteId, enabled: false });
    await telemetry(off.c, [...run(off.cf, 3, 600, false), ...run(off.google, 3, 600, false)]);
    expect((await off.a.agent.get('/api/v1/incidents?status=active')).body.items).toHaveLength(1);
    expect(await runChecks(off.c.id)).toHaveLength(0);
    expect(await systemEntries(off.a, 'incident.refresh_measurements')).toHaveLength(0);

    const { a, c } = await site('refresh-collector');
    const second = await newCollector(a, 'edge-2');
    await heartbeat(second);
    await systemPool.query(`UPDATE collectors SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [c.id]);
    await watchCollectors();
    expect((await a.agent.get('/api/v1/incidents?status=active')).body.items[0]).toMatchObject({ kind: 'collector' });
    expect(await runChecks(c.id)).toHaveLength(0); // the silent one cannot measure
    expect(await runChecks(second.id)).toHaveLength(1);
    expect((await systemEntries(a, 'incident.refresh_measurements'))[0]!.metadata).toMatchObject({ incident_kind: 'collector', collectors: [second.id] });
  });
});

// ── 7: device type reset, documented PATCH behaviour ──
describe('documented updates', () => {
  it('returns a device type to automatic with device_type: null', async () => {
    const a = await newAccount('typereset');
    const scopeId = await addScope(a, '192.168.95.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.95.1' });
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.95.1', mac: '00:0c:29:95:00:01' }, { ip: '192.168.95.9', mac: '00:0c:29:95:00:09' }], 2)]);
    let [gw, other] = await devices(a);
    expect(gw).toMatchObject({ device_type: 'router', type_source: 'inferred' });
    const inferred = { type_confidence: gw!.type_confidence, type_evidence: gw!.type_evidence };
    await a.agent.patch(`/api/v1/devices/${gw!.id}`).set(CSRF).send({ device_type: 'firewall' });
    await a.agent.patch(`/api/v1/devices/${other!.id}`).set(CSRF).send({ device_type: 'printer' });
    expect((await devices(a))[0]).toMatchObject({ device_type: 'firewall', type_source: 'manual', type_confidence: null });

    expect((await a.agent.patch(`/api/v1/devices/${gw!.id}`).set(CSRF).send({ device_type: null })).status).toBe(200);
    expect((await a.agent.patch(`/api/v1/devices/${other!.id}`).set(CSRF).send({ device_type: null })).status).toBe(200);
    [gw, other] = await devices(a);
    expect(gw).toMatchObject({ device_type: 'router', type_source: 'inferred', ...inferred }); // classified again from its evidence
    expect(other).toMatchObject({ device_type: 'unknown', type_source: 'none', type_confidence: null, type_evidence: null });
    // Automatic again: the next sweep may classify it.
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.95.1', mac: '00:0c:29:95:00:01' }, { ip: '192.168.95.9', mac: '00:0c:29:95:00:09', hostname: 'printer-2f' }], 1)]);
    expect((await devices(a))[1]).toMatchObject({ device_type: 'printer', type_source: 'inferred' });
    expect((await a.agent.patch(`/api/v1/devices/${gw!.id}`).set(CSRF).send({ device_type: 'toaster' })).status).toBe(400);
  });

  it('PATCH /checks/:id accepts the documented partial fields only', async () => {
    const a = await newAccount('checkpatch');
    const check = (await a.agent.get('/api/v1/checks')).body.items.find((c: any) => c.role === 'internet');
    const res = await a.agent.patch(`/api/v1/checks/${check.id}`).set(CSRF).send({ interval_seconds: 45, latency_warn_ms: null, loss_warn_pct: 12.5, failure_threshold: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: check.id, interval_seconds: 45, latency_warn_ms: null, loss_warn_pct: 12.5, failure_threshold: 5, name: check.name, target: check.target });
    expect((await a.agent.patch(`/api/v1/checks/${check.id}`).set(CSRF).send({ enabled: false })).body).toMatchObject({ enabled: false, state: 'unknown' });
    expect((await a.agent.patch(`/api/v1/checks/${check.id}`).set(CSRF).send({ target: '9.9.9.9' })).status).toBe(400); // not patchable
    expect((await a.agent.patch(`/api/v1/checks/${check.id}`).set(CSRF).send({ interval_seconds: 5 })).status).toBe(400);
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.patch(`/api/v1/checks/${check.id}`).set(CSRF).send({ enabled: true })).status).toBe(403);
  });

  it('PUT /access/settings stores upstreams and delivers them to the collector', async () => {
    const a = await newAccount('upstreams');
    const c = await newCollector(a);
    await heartbeat(c);
    const res = await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, enabled: true, upstreams: ['9.9.9.9', '149.112.112.112'] });
    expect(res.status).toBe(200);
    expect((await a.agent.get(`/api/v1/access?site_id=${a.siteId}`)).body.settings.upstreams).toEqual(['9.9.9.9', '149.112.112.112']);
    expect((await heartbeat(c)).body.config.access).toMatchObject({ enabled: true, upstreams: ['9.9.9.9', '149.112.112.112'], timezone: 'UTC' });
    // Leaving upstreams out keeps them; invalid or too many are rejected.
    await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, blocked_categories: ['adult'] });
    expect((await heartbeat(c)).body.config.access.upstreams).toEqual(['9.9.9.9', '149.112.112.112']);
    expect((await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, upstreams: ['dns.google'] })).status).toBe(400);
    expect((await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, upstreams: ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9'] })).status).toBe(400);
    expect((await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, upstreams: [] })).status).toBe(200);
  });
});

// ── 8: switch detection ──
describe('switch detection', () => {
  const COMMUNITY = 'detect-community-77';
  const port = (i: number) => ({ if_index: i, name: `Gi0/${i}`, admin_up: true, oper_up: true, speed_mbps: 1000, in_errors: 0, out_errors: 0, in_discards: 0, out_discards: 0, in_octets: 1, out_octets: 1 });
  const poll = (targetId: string, over: Record<string, unknown> = {}) => ({
    type: 'snmp_poll',
    ts: new Date().toISOString(),
    target_id: targetId,
    ok: true,
    sys_name: 'sw-core',
    sys_descr: 'Test switch',
    ports: [port(1), port(2)],
    fdb: [{ mac: '00:0c:29:96:00:20', if_index: 1, vlan: 0 }],
    lldp: [],
    ...over,
  });

  async function office(label: string) {
    const a = await newAccount(label);
    const scopeId = await addScope(a, '192.168.96.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.96.1' });
    await telemetry(c, [
      sweep(scopeId, [
        { ip: '192.168.96.1', mac: '00:0c:29:96:00:01', hostname: 'gw.lan' },
        { ip: '192.168.96.2', mac: '00:0c:29:96:00:02', hostname: 'sw-core' },
        { ip: '192.168.96.3', mac: '00:0c:29:96:00:03', hostname: 'sw-floor2' },
        { ip: '192.168.96.4', mac: '00:0c:29:96:00:04', hostname: 'sw-manual' },
        { ip: '192.168.96.20', mac: '00:0c:29:96:00:20', hostname: 'laptop' },
      ], 2),
    ]);
    const list = await devices(a);
    const byIp = (ip: string) => list.find((d) => d.current_ip === ip)!;
    const add = async (host: string) => {
      const r = await a.agent.post('/api/v1/switches').set(CSRF).send({ site_id: a.siteId, host, credentials: { version: '2c', community: COMMUNITY } });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };
    return { a, c, byIp, add };
  }
  const device = async (a: TestAccount, id: string) => (await a.agent.get(`/api/v1/devices/${id}`)).body;

  it('marks the device a switch after its first successful SNMP read, never over a manual type', async () => {
    const { a, c, byIp, add } = await office('swdetect');
    const core = byIp('192.168.96.2');
    const manual = byIp('192.168.96.4');
    await a.agent.patch(`/api/v1/devices/${manual.id}`).set(CSRF).send({ device_type: 'server' });

    const coreTarget = await add('192.168.96.2');
    const manualTarget = await add('192.168.96.4');
    // A failed first read changes nothing.
    await telemetry(c, [{ type: 'snmp_poll', ts: new Date().toISOString(), target_id: coreTarget, ok: false, error: 'timeout' }]);
    expect((await device(a, core.id)).device_type).not.toBe('switch');

    await telemetry(c, [poll(coreTarget), poll(manualTarget, { sys_name: 'sw-manual' })]);
    const d = await device(a, core.id);
    expect(d).toMatchObject({ device_type: 'switch', type_source: 'inferred', type_confidence: 'high' });
    expect(d.type_evidence).toContain('SNMP sysName "sw-core"');
    expect(await device(a, manual.id)).toMatchObject({ device_type: 'server', type_source: 'manual' });

    const entries = await systemEntries(a, 'classify.switch_from_snmp');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'device.type_inferred', target_type: 'device', target_id: core.id, actor: 'system' });
    expect(entries[0]!.metadata).toMatchObject({ device_type: 'switch', confidence: 'high', snmp_target_id: coreTarget, site_id: a.siteId });
    expect(JSON.stringify(entries)).not.toContain(COMMUNITY);

    // Later reads do not repeat it, and the user can still override.
    await a.agent.patch(`/api/v1/devices/${core.id}`).set(CSRF).send({ device_type: 'router' });
    await telemetry(c, [poll(coreTarget)]);
    expect((await device(a, core.id)).device_type).toBe('router');
    expect(await systemEntries(a, 'classify.switch_from_snmp')).toHaveLength(1);
  });

  it('respects the automation switch', async () => {
    const { a, c, byIp, add } = await office('swdetect-off');
    await setAutomation(a, 'classify.switch_from_snmp', { enabled: false });
    const target = await add('192.168.96.2');
    await telemetry(c, [poll(target)]);
    expect((await device(a, byIp('192.168.96.2').id)).device_type).not.toBe('switch');
    expect(await systemEntries(a, 'classify.switch_from_snmp')).toHaveLength(0);
  });

  it('lists switch candidates from classification and LLDP, without credentials, per tenant', async () => {
    const { a, c, byIp, add } = await office('swcand');
    const target = await add('192.168.96.2');
    // sw-floor2 is heard over LLDP on the core switch's port 2 (by MAC, in another notation).
    await telemetry(c, [poll(target, { lldp: [{ if_index: 2, sys_name: 'sw-floor2.lan', chassis_id: '00-0C-29-96-00-03', port_id: 'Gi0/48' }] })]);
    const res = await a.agent.get(`/api/v1/sites/${a.siteId}/switch-candidates`);
    expect(res.status).toBe(200);
    const items = res.body.items as any[];
    const ids = items.map((i) => i.device_id);
    expect(ids).toContain(byIp('192.168.96.1').id); // the router
    expect(ids).toContain(byIp('192.168.96.3').id); // the LLDP neighbour
    expect(ids).not.toContain(byIp('192.168.96.2').id); // already read
    expect(ids).not.toContain(byIp('192.168.96.20').id);
    const floor2 = items.find((i) => i.device_id === byIp('192.168.96.3').id);
    expect(floor2).toMatchObject({ inferred: true, in_scope: true, ip: '192.168.96.3' });
    expect(floor2.reasons).toEqual([{ kind: 'lldp_neighbor', evidence: expect.stringContaining('port Gi0/2 of switch sw-core') }]);
    expect(items.find((i) => i.device_id === byIp('192.168.96.1').id).reasons[0].kind).toBe('classified');
    expect(JSON.stringify(res.body)).not.toMatch(/community|credential|password/i);

    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get(`/api/v1/sites/${a.siteId}/switch-candidates`)).status).toBe(200);
    const b = await newAccount('swcand-other');
    expect((await b.agent.get(`/api/v1/sites/${a.siteId}/switch-candidates`)).status).toBe(404);
  });
});

// ── 9: enrollment helpers ──
describe('enrollment helpers', () => {
  it('returns the server URL for install commands from the request origin or PUBLIC_URL', async () => {
    const a = await newAccount('serverurl');
    const created = await a.agent.post('/api/v1/collectors').set(CSRF).send({ site_id: a.siteId, name: 'edge' });
    expect(created.status).toBe(201);
    expect(created.body.server_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(created.body.server_url_source).toBe('request');
    // Behind the web app's proxy (a trusted loopback hop), the browser's origin is used.
    const proxied = await a.agent
      .post('/api/v1/endpoints')
      .set(CSRF)
      .set('X-Forwarded-Host', 'lan.example.test')
      .set('X-Forwarded-Proto', 'https')
      .send({ site_id: a.siteId, name: 'PC-1' });
    expect(proxied.status).toBe(201);
    expect(proxied.body).toMatchObject({ server_url: 'https://lan.example.test', server_url_source: 'request', enrollment_token: expect.any(String) });
    const reissued = await a.agent.post(`/api/v1/endpoints/${proxied.body.endpoint.id}/enrollment-token`).set(CSRF);
    expect(reissued.body.server_url).toMatch(/^http:\/\//);
    const collectorReissue = await a.agent.post(`/api/v1/collectors/${created.body.collector.id}/enrollment-token`).set(CSRF);
    expect(collectorReissue.body.server_url_source).toBe('request');
    // A configured PUBLIC_URL wins over whatever origin the request came through.
    const saved = env.PUBLIC_URL;
    (env as { PUBLIC_URL?: string }).PUBLIC_URL = 'https://lan.corp.test';
    try {
      const configured = await a.agent.post('/api/v1/collectors').set(CSRF).set('X-Forwarded-Host', 'other.test').send({ site_id: a.siteId, name: 'edge-2' });
      expect(configured.body).toMatchObject({ server_url: 'https://lan.corp.test', server_url_source: 'configured' });
    } finally {
      (env as { PUBLIC_URL?: string }).PUBLIC_URL = saved;
    }
  });

  it('suggests the agent platform from the device classification, windows only as a stated default', async () => {
    expect(guessPlatform({ device_type: 'linux_computer', type_source: 'inferred', type_confidence: 'medium', type_evidence: 'Announces _ssh._tcp', fingerprint: {} })).toMatchObject({
      platform: 'linux',
      source: 'inferred',
      confidence: 'medium',
    });
    expect(guessPlatform({ device_type: 'unknown', type_source: 'none', type_confidence: null, type_evidence: null, fingerprint: { ssdp: { server: 'Darwin/22 UPnP/1.0' } } })).toMatchObject({
      platform: 'macos',
      confidence: 'low',
    });

    const a = await newAccount('suggestplat');
    const scopeId = await addScope(a, '192.168.97.0/24');
    const c = await newCollector(a);
    await heartbeat(c);
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.97.10', mac: '00:0c:29:97:00:10', hostname: 'build-box' }, { ip: '192.168.97.11', mac: '00:0c:29:97:00:11' }], 2)]);
    const [box, anon] = await devices(a);
    await a.agent.patch(`/api/v1/devices/${box!.id}`).set(CSRF).send({ device_type: 'linux_computer' });
    const linux = await a.agent.get(`/api/v1/devices/${box!.id}/enrollment-suggestion`);
    expect(linux.status).toBe(200);
    expect(linux.body).toMatchObject({
      device_id: box!.id,
      site_id: a.siteId,
      suggested_name: 'build-box',
      suggested_platform: 'linux',
      platform_source: 'inferred',
      platform_confidence: 'high',
      existing_endpoint_id: null,
      server_url_source: 'request',
    });
    const unknown = await a.agent.get(`/api/v1/devices/${anon!.id}/enrollment-suggestion`);
    expect(unknown.body).toMatchObject({ suggested_platform: 'windows', platform_source: 'default', platform_confidence: null });
    expect(unknown.body.platform_evidence[0]).toContain('default');

    const ep = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'build-box', platform: 'linux', device_id: box!.id });
    expect((await a.agent.get(`/api/v1/devices/${box!.id}/enrollment-suggestion`)).body.existing_endpoint_id).toBe(ep.body.endpoint.id);

    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.get(`/api/v1/devices/${box!.id}/enrollment-suggestion`)).status).toBe(403);
    const b = await newAccount('suggestplat-other');
    expect((await b.agent.get(`/api/v1/devices/${box!.id}/enrollment-suggestion`)).status).toBe(404);
  });
});
