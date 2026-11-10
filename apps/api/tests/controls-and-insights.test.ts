import { describe, expect, it } from 'vitest';
import { buildInsights, type DeviceFact, type InsightFacts } from '../src/modules/insights/rules.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry, type TestAccount } from './helpers.ts';

const events = async (a: TestAccount, type: string) =>
  (await a.agent.get(`/api/v1/events?type=${type}&limit=50`)).body.items as Record<string, any>[];
const devices = async (a: TestAccount, query = '') => (await a.agent.get(`/api/v1/devices?sort=ip${query}`)).body.items as Record<string, any>[];

const HOSTS = [
  { ip: '192.168.7.1', mac: '00:0c:29:77:00:01', hostname: 'gw.lan' },
  { ip: '192.168.7.10', mac: '00:0c:29:77:00:10', hostname: 'nas.lan' },
  { ip: '192.168.7.20', mac: '00:0c:29:77:00:20', hostname: 'tv.lan' },
];

async function home() {
  const a = await newAccount('ctl');
  const scopeId = await addScope(a, '192.168.7.0/24');
  const c = await newCollector(a);
  await heartbeat(c, { gateway_ip: '192.168.7.1' });
  await telemetry(c, [sweep(scopeId, HOSTS, 30)]);
  const list = await devices(a);
  const byIp = (ip: string) => list.find((d) => d.current_ip === ip)!;
  return { a, c, scopeId, gw: byIp('192.168.7.1'), nas: byIp('192.168.7.10'), tv: byIp('192.168.7.20') };
}

describe('device controls', () => {
  it('approves devices, alerts on unwanted ones, and mutes alerts', async () => {
    const { a, c, scopeId, nas, tv } = await home();
    expect(nas.trust).toBe('unreviewed');
    expect((await devices(a, '&trust=unreviewed')).length).toBe(3);

    // Mark everything I know, then flag the TV as unwanted.
    expect((await a.agent.post('/api/v1/devices/trust').set(CSRF).send({ all_unreviewed: true, trust: 'known' })).body).toEqual({ updated: 3 });
    expect((await a.agent.post('/api/v1/devices/trust').set(CSRF).send({ trust: 'known' })).status).toBe(400); // neither ids nor all
    const patched = await a.agent.patch(`/api/v1/devices/${tv.id}`).set(CSRF).send({ trust: 'unwanted' });
    expect(patched.status).toBe(200);
    const tvNow = (await a.agent.get(`/api/v1/devices/${tv.id}`)).body;
    expect(tvNow.device ?? tvNow).toMatchObject({ trust: 'unwanted' });
    expect((tvNow.device ?? tvNow).trust_changed_at).toBeTruthy();
    expect((await devices(a, '&trust=known')).map((d) => d.current_ip)).toEqual(['192.168.7.1', '192.168.7.10']);

    // TV disappears (2 sweeps) and comes back → critical unwanted_device_online, not a plain device_online.
    const without = HOSTS.filter((h) => h.ip !== '192.168.7.20');
    await telemetry(c, [sweep(scopeId, without, 25)]);
    await telemetry(c, [sweep(scopeId, without, 20)]);
    await telemetry(c, [sweep(scopeId, HOSTS, 15)]);
    const unwanted = await events(a, 'unwanted_device_online');
    expect(unwanted).toHaveLength(1);
    expect(unwanted[0]).toMatchObject({ severity: 'critical' });
    expect(unwanted[0]!.details.how_to_block).toBeTruthy();

    // Muted: the NAS going offline and back produces no events.
    await a.agent.patch(`/api/v1/devices/${nas.id}`).set(CSRF).send({ alerts_muted: true });
    const noNas = HOSTS.filter((h) => h.ip !== '192.168.7.10');
    await telemetry(c, [sweep(scopeId, noNas, 10)]);
    await telemetry(c, [sweep(scopeId, noNas, 5)]);
    await telemetry(c, [sweep(scopeId, HOSTS, 1)]);
    const nasEvents = (await a.agent.get(`/api/v1/events?device_id=${nas.id}&limit=50`)).body.items as Record<string, any>[];
    expect(nasEvents.filter((e) => e.type === 'device_offline' || e.type === 'device_online')).toHaveLength(0);
    expect((await devices(a)).find((d) => d.id === nas.id)!.status).toBe('online');
  });

  it('creates one monitoring check per device that follows IP changes', async () => {
    const { a, c, scopeId, nas } = await home();
    const first = await a.agent.post(`/api/v1/devices/${nas.id}/monitor`).set(CSRF);
    expect(first.status).toBe(201);
    const again = await a.agent.post(`/api/v1/devices/${nas.id}/monitor`).set(CSRF);
    expect(again.status).toBe(200);
    expect(again.body.check_id).toBe(first.body.check_id);
    expect((await devices(a)).find((d) => d.id === nas.id)!.monitor_check_id).toBe(first.body.check_id);

    await telemetry(c, [sweep(scopeId, [{ ...HOSTS[1]!, ip: '192.168.7.11' }], 5)]);
    const check = await systemPool.query(`SELECT target FROM monitoring_checks WHERE id = $1`, [first.body.check_id]);
    expect(check.rows[0].target).toBe('192.168.7.11');
  });

  it('queues Wake-on-LAN through the online collector, inside the authorized range only', async () => {
    const { a, c, nas } = await home();
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.post(`/api/v1/devices/${nas.id}/wake`).set(CSRF)).status).toBe(403);
    await setRole(a.email, a.organizationId, 'owner');

    const res = await a.agent.post(`/api/v1/devices/${nas.id}/wake`).set(CSRF);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ queued: true, broadcast: '192.168.7.255' });
    const hb = await heartbeat(c);
    const wake = hb.body.commands.find((x: any) => x.kind === 'wake_device');
    expect(wake.payload).toEqual({ mac: '00:0c:29:77:00:10', broadcast: '192.168.7.255' });

    // Stale wake requests are dropped instead of waking a machine minutes later.
    await a.agent.post(`/api/v1/devices/${nas.id}/wake`).set(CSRF);
    await systemPool.query(`UPDATE collector_commands SET created_at = now() - interval '11 minutes' WHERE collector_id = $1 AND status = 'pending'`, [c.id]);
    expect((await heartbeat(c, { completed_commands: [wake.id] })).body.commands.filter((x: any) => x.kind === 'wake_device')).toHaveLength(0);

    // No online collector → refused with a clear reason.
    await systemPool.query(`UPDATE collectors SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [c.id]);
    const offline = await a.agent.post(`/api/v1/devices/${nas.id}/wake`).set(CSRF);
    expect(offline.status).toBe(409);
    expect(offline.body.error.code).toBe('no_collector');
  });
});

describe('insights', () => {
  it('reports what needs attention, with evidence and actions', async () => {
    const { a, tv } = await home();
    let report = (await a.agent.get('/api/v1/insights')).body;
    expect(report.insights.map((i: any) => i.code)).toContain('unreviewed');
    const unreviewed = report.insights.find((i: any) => i.code === 'unreviewed');
    expect(unreviewed.params.count).toBe(3);
    expect(unreviewed.actions.map((x: any) => x.code)).toEqual(['review', 'mark_all_known']);

    await a.agent.post('/api/v1/devices/trust').set(CSRF).send({ all_unreviewed: true, trust: 'known' });
    await a.agent.patch(`/api/v1/devices/${tv.id}`).set(CSRF).send({ trust: 'unwanted' });
    report = (await a.agent.get('/api/v1/insights')).body;
    expect(report.insights[0]).toMatchObject({ code: 'unwanted_online', severity: 'critical' });
    expect(report.insights[0].actions.map((x: any) => x.href)).toContain('http://192.168.7.1/');
    expect(report.score).toBeLessThan(90);
    expect(report.verdict).not.toBe('healthy');

    const other = await newAccount('other');
    expect((await other.agent.get('/api/v1/insights')).body.insights.map((i: any) => i.code)).toEqual(['no_collector']);
  });

  it('scores a quiet, reviewed network as healthy', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const old = new Date('2026-11-01T12:00:00Z');
    const dev = (over: Partial<DeviceFact>): DeviceFact => ({
      id: 'd', label: 'nas', ip: '10.0.0.2', status: 'online', trust: 'known', is_critical: false,
      mac_randomized: false, named: true, monitored: false, first_seen_at: old, last_seen_at: now, ...over,
    });
    const facts: InsightFacts = {
      now,
      devices: [dev({}), dev({ id: 'e', label: 'printer' })],
      collectors: [{ id: 'c', name: 'pc', last_heartbeat_at: now, gateway_ip: '10.0.0.1' }],
      scopes: 1,
      checks: [{ id: 'k', name: 'Gateway', role: 'gateway', state: 'ok', last_latency_ms: 2, last_loss_pct: 0 }],
      openIncidents: [],
      ipConflicts: [],
    };
    expect(buildInsights(facts)).toMatchObject({ score: 100, verdict: 'healthy', insights: [] });

    const bad = buildInsights({
      ...facts,
      devices: [dev({ is_critical: true, status: 'offline', last_seen_at: old })],
      checks: [{ ...facts.checks[0]!, state: 'down' }],
    });
    expect(bad.verdict).toBe('urgent');
    expect(bad.insights.map((i) => i.code)).toEqual(['path_gateway_down', 'critical_offline', 'suggest_monitor']);
  });
});
