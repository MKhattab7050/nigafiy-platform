import { afterAll, describe, expect, it } from 'vitest';
import type { Diagnosis, IncidentDetail, Topology } from '@nigafiy/shared-types';
import { closePools, systemPool } from '../src/infrastructure/db.ts';
import { watchCollectors } from '../src/modules/collectors/index.ts';
import { rollupCheckResults } from '../src/modules/monitoring/index.ts';
import { type CheckFacts, type NetworkFacts, diagnoseNetwork } from '../src/modules/doctor/rules.ts';
import { CSRF, type TestAccount, type TestCollector, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

afterAll(closePools);

// ── helpers ──
const sample = (checkId: string, secondsAgo: number, ok: boolean, extra: Record<string, unknown> = {}) => ({
  type: 'check_result',
  check_id: checkId,
  ts: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  ok,
  ...(ok ? { latency_ms: 12, loss_pct: 0 } : { loss_pct: 100, error: 'no echo reply (5 requests sent)' }),
  ...extra,
});
/** `n` consecutive samples, the newest `endSecondsAgo` seconds ago, 10 s apart. */
const run = (checkId: string, n: number, endSecondsAgo: number, ok: boolean, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => sample(checkId, endSecondsAgo + (n - 1 - i) * 10, ok, extra));

interface Checks {
  gateway: string;
  cf: string;
  google: string;
  dns: string;
}
async function checksOf(a: TestAccount): Promise<Checks> {
  const items = (await a.agent.get('/api/v1/checks')).body.items as { id: string; target: string; role: string }[];
  const by = (target: string) => items.find((c) => c.target === target)!.id;
  return { gateway: by('auto:gateway'), cf: by('1.1.1.1'), google: by('8.8.8.8'), dns: by('example.com') };
}
const incidents = async (a: TestAccount, status = 'all') => (await a.agent.get(`/api/v1/incidents?status=${status}`)).body.items as Record<string, any>[];
const detail = async (a: TestAccount, id: string) => (await a.agent.get(`/api/v1/incidents/${id}`)).body as IncidentDetail;

async function healthySite(label: string): Promise<{ a: TestAccount; c: TestCollector; k: Checks }> {
  const a = await newAccount(label);
  const c = await newCollector(a);
  await heartbeat(c, { gateway_ip: '192.168.1.1' });
  const k = await checksOf(a);
  await telemetry(c, [...run(k.gateway, 2, 600, true, { resolved_target: '192.168.1.1', latency_ms: 2 }), ...run(k.cf, 2, 600, true), ...run(k.google, 2, 600, true), ...run(k.dns, 2, 600, true)]);
  return { a, c, k };
}

// ── Network Doctor: pure rules ──
describe('Network Doctor rules', () => {
  const check = (role: CheckFacts['role'], state: CheckFacts['state'], over: Partial<CheckFacts> = {}): CheckFacts => ({
    id: `${role}-${Math.random()}`,
    name: `${role} check`,
    kind: role === 'dns' ? 'dns' : 'icmp',
    role,
    target: role === 'gateway' ? 'auto:gateway' : role === 'dns' ? 'example.com' : '1.1.1.1',
    port: null,
    state,
    last_result_at: new Date(),
    last_latency_ms: state === 'down' ? null : 10,
    last_loss_pct: state === 'down' ? 100 : 0,
    last_error: state === 'down' ? 'no echo reply' : null,
    last_resolved_target: role === 'gateway' ? '192.168.1.1' : null,
    latency_warn_ms: 150,
    recent_samples: 10,
    recent_ok: state === 'down' ? 0 : 10,
    recent_latency_ms: 10,
    recent_loss_pct: 0,
    baseline_latency_ms: 9,
    baseline_samples: 500,
    ...over,
  });
  const facts = (checks: CheckFacts[], over: Partial<NetworkFacts> = {}): NetworkFacts => ({
    now: new Date(),
    checks,
    collectors: { total: 1, online: 1, last_heartbeat_at: new Date() },
    devices: { total: 20, offline: 0, went_offline_recently: 0 },
    recent_changes: [],
    ...over,
  });

  it('separates LAN, WAN, DNS and remote-target faults', () => {
    const wan = diagnoseNetwork(facts([check('gateway', 'ok'), check('internet', 'down'), check('internet', 'down'), check('dns', 'down')]));
    expect(wan).toMatchObject({ fault_domain: 'wan_isp', confidence: 'high', rule: 'gateway-ok-internet-down' });
    expect(wan.ruled_out).toHaveLength(1); // the healthy gateway is shown as ruled out
    expect(wan.evidence.length).toBe(3);

    // One internet target only → the rule says so and lowers its confidence.
    expect(diagnoseNetwork(facts([check('gateway', 'ok'), check('internet', 'down')]))).toMatchObject({ fault_domain: 'wan_isp', confidence: 'medium' });

    expect(diagnoseNetwork(facts([check('gateway', 'down'), check('internet', 'down'), check('dns', 'down')]))).toMatchObject({ fault_domain: 'local_gateway', confidence: 'high' });
    // Gateway silent but internet works: probably ICMP filtered → not claimed with high confidence.
    expect(diagnoseNetwork(facts([check('gateway', 'down'), check('internet', 'ok')]))).toMatchObject({ fault_domain: 'local_gateway', confidence: 'medium' });
    expect(diagnoseNetwork(facts([check('gateway', 'down'), check('internet', 'down')], { devices: { total: 20, offline: 9, went_offline_recently: 9 } })).fault_domain).toBe('lan_segment');
    // Internet answers through the router whose LAN address does not, and the LAN went silent: this
    // computer is cut off (an isolated Wi-Fi), not a dead router or switch.
    expect(diagnoseNetwork(facts([check('gateway', 'down'), check('internet', 'ok')], { devices: { total: 20, offline: 9, went_offline_recently: 9 } }))).toMatchObject({
      rule: 'cut-off-from-lan',
      fault_domain: 'lan_segment',
      confidence: 'high',
    });

    expect(diagnoseNetwork(facts([check('gateway', 'ok'), check('internet', 'ok'), check('internet', 'ok'), check('dns', 'down')]))).toMatchObject({ fault_domain: 'dns', confidence: 'high' });
    expect(diagnoseNetwork(facts([check('gateway', 'ok'), check('internet', 'down'), check('internet', 'ok')])).fault_domain).toBe('remote_target');
    expect(diagnoseNetwork(facts([check('gateway', 'degraded', { last_loss_pct: 20 }), check('internet', 'degraded')])).fault_domain).toBe('lan_quality');
    const slow = diagnoseNetwork(facts([check('gateway', 'ok'), check('internet', 'degraded', { last_latency_ms: 400 }), check('internet', 'degraded', { last_latency_ms: 380 })]));
    expect(slow.fault_domain).toBe('wan_quality');
    expect(slow.summary).toContain('7-day baseline 9.0 ms');
    expect(diagnoseNetwork(facts([check('gateway', 'ok'), check('internet', 'ok'), check('dns', 'ok')]))).toMatchObject({ fault_domain: 'healthy', evidence: [] });
  });

  it('refuses to diagnose without current observations', () => {
    expect(diagnoseNetwork(facts([check('gateway', 'ok'), check('internet', 'down')], { collectors: { total: 1, online: 0, last_heartbeat_at: null } }))).toMatchObject({ fault_domain: 'insufficient_data', confidence: 'low' });
    expect(diagnoseNetwork(facts([check('gateway', 'unknown'), check('internet', 'unknown')])).fault_domain).toBe('insufficient_data');
    // No diagnosis ever claims certainty in its wording.
    for (const d of [diagnoseNetwork(facts([check('gateway', 'ok'), check('internet', 'down'), check('internet', 'down')]))]) {
      expect(d.confidence_reason.length).toBeGreaterThan(10);
      expect(d.investigation_steps.length).toBeGreaterThan(0);
    }
  });
});

// ── Incidents ──
describe('incident correlation and lifecycle', () => {
  it('groups a WAN outage into one diagnosed incident, resolves it on recovery and cites it next time', async () => {
    const { a, c, k } = await healthySite('wan');
    expect(await incidents(a)).toHaveLength(0);

    // Both internet targets fail, then DNS: three check_down events → ONE incident.
    await telemetry(c, [...run(k.cf, 3, 300, false), ...run(k.google, 3, 300, false), ...run(k.gateway, 3, 300, true, { resolved_target: '192.168.1.1', latency_ms: 2 })]);
    await telemetry(c, run(k.dns, 3, 270, false, { error: 'timed out' }));
    let list = await incidents(a, 'active');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'network', status: 'open', severity: 'critical', fault_domain: 'wan_isp', confidence: 'high', event_count: 3, number: 1 });
    const id = list[0]!.id as string;

    let d = await detail(a, id);
    const dx = d.diagnosis as Diagnosis;
    expect(dx.title).toBe('Internet connection is down (WAN / ISP)');
    expect(dx.engine).toBe('rules-v1');
    expect(dx.evidence.filter((e) => e.basis === 'observed').length).toBeGreaterThanOrEqual(3);
    expect(dx.ruled_out[0]!.label).toContain('192.168.1.1'); // the gateway answers → LAN ruled out
    expect(dx.affected.checks).toHaveLength(3);
    expect(dx.related_incidents).toHaveLength(0);
    expect(d.activity.map((x) => x.kind)).toEqual(expect.arrayContaining(['opened', 'diagnosis']));
    expect((await a.agent.get('/api/v1/overview')).body.active_incidents).toHaveLength(1);
    // Live Doctor report agrees and points at the incident.
    const report = (await a.agent.get('/api/v1/doctor')).body.items[0];
    expect(report.diagnosis.fault_domain).toBe('wan_isp');
    expect(report.active_incident.id).toBe(id);

    // Human workflow.
    expect((await a.agent.post(`/api/v1/incidents/${id}/acknowledge`).set(CSRF)).status).toBe(200);
    expect((await a.agent.post(`/api/v1/incidents/${id}/acknowledge`).set(CSRF)).status).toBe(409);
    const me = (await a.agent.get('/api/v1/members')).body.items[0];
    expect((await a.agent.patch(`/api/v1/incidents/${id}`).set(CSRF).send({ assigned_to: me.id })).status).toBe(200);
    expect((await a.agent.post(`/api/v1/incidents/${id}/comments`).set(CSRF).send({ body: 'ISP ticket #4411 opened' })).status).toBe(201);
    expect((await a.agent.post(`/api/v1/incidents/${id}/resolve`).set(CSRF).send({ note: '' })).status).toBe(400);

    // Partial recovery keeps it open; full recovery resolves it automatically.
    await telemetry(c, run(k.cf, 3, 200, true));
    expect((await incidents(a, 'active'))[0]).toMatchObject({ status: 'acknowledged' });
    await telemetry(c, [...run(k.google, 3, 150, true), ...run(k.dns, 3, 150, true)]);
    expect(await incidents(a, 'active')).toHaveLength(0);
    d = await detail(a, id);
    expect(d).toMatchObject({ status: 'resolved', resolution_kind: 'auto', assigned_to_name: me.display_name });
    expect((d.diagnosis as Diagnosis).fault_domain).toBe('wan_isp'); // still describes the fault, not the recovery
    expect(d.activity.some((x) => x.kind === 'resolved')).toBe(true);
    expect(d.activity.some((x) => x.body === 'ISP ticket #4411 opened')).toBe(true);
    // Replay: events are placed before / during / after and linked ones are marked.
    expect(d.timeline.filter((e) => e.linked).length).toBe(6);
    expect(d.timeline.every((e) => ['before', 'during', 'after'].includes(e.phase))).toBe(true);
    expect((await a.agent.post(`/api/v1/incidents/${id}/diagnose`).set(CSRF)).status).toBe(409);

    // The technician records what fixed it; the next similar incident cites it as history (not as a confirmed fix).
    expect((await a.agent.patch(`/api/v1/incidents/${id}`).set(CSRF).send({ resolution_note: 'ISP fibre cut repaired' })).status).toBe(200);
    await telemetry(c, [...run(k.cf, 3, 60, false), ...run(k.google, 3, 60, false)]);
    list = await incidents(a, 'active');
    expect(list).toHaveLength(1);
    expect(list[0]!.number).toBe(2);
    const second = (await detail(a, list[0]!.id)).diagnosis as Diagnosis;
    expect(second.related_incidents).toHaveLength(1);
    expect(second.related_incidents[0]).toMatchObject({ number: 1, resolution_note: 'ISP fibre cut repaired' });

    // Manual resolution with a note.
    expect((await a.agent.post(`/api/v1/incidents/${list[0]!.id}/resolve`).set(CSRF).send({ note: 'False alarm during maintenance' })).status).toBe(200);
    expect((await detail(a, list[0]!.id)).resolution_kind).toBe('manual');
  });

  it('opens device incidents only for critical devices and service incidents with a specific cause', async () => {
    const { a, c } = await healthySite('devsvc');
    const scopeId = await addScope(a, '192.168.1.0/24');
    const hosts = [
      { ip: '192.168.1.10', mac: '00:0c:29:10:00:10', hostname: 'core-sw' },
      { ip: '192.168.1.20', mac: '00:0c:29:10:00:20', hostname: 'laptop' },
      { ip: '192.168.1.30', mac: '00:0c:29:10:00:30', hostname: 'erp' },
    ];
    await telemetry(c, [sweep(scopeId, hosts, 20)]);
    const devs = (await a.agent.get('/api/v1/devices')).body.items as { id: string; hostname: string }[];
    const core = devs.find((x) => x.hostname === 'core-sw')!;
    await a.agent.patch(`/api/v1/devices/${core.id}`).set(CSRF).send({ is_critical: true });

    // The laptop and the core switch both disappear: only the critical one raises an incident.
    await telemetry(c, [sweep(scopeId, [hosts[2]!], 15)]);
    await telemetry(c, [sweep(scopeId, [hosts[2]!], 10)]);
    let list = await incidents(a, 'active');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'device', severity: 'critical', fault_domain: 'device' });
    // The device card's "Incidents" action (Milestone 4) lists only this device's incidents.
    const laptop = devs.find((x) => x.hostname === 'laptop')!;
    const forCore = await a.agent.get(`/api/v1/incidents?status=all&device_id=${core.id}`);
    expect(forCore.status).toBe(200);
    expect(forCore.body.items.map((i: { id: string }) => i.id)).toEqual([list[0]!.id]);
    expect((await a.agent.get(`/api/v1/incidents?status=all&device_id=${laptop.id}`)).body.items).toHaveLength(0);
    expect((await a.agent.get('/api/v1/incidents?device_id=not-a-uuid')).status).toBe(400);
    await telemetry(c, [sweep(scopeId, hosts, 5)]);
    expect(await incidents(a, 'active')).toHaveLength(0);

    // A TCP service on an online host actively refuses the connection.
    const created = await a.agent.post('/api/v1/checks').set(CSRF).send({ site_id: a.siteId, name: 'ERP web', kind: 'tcp', target: '192.168.1.30', port: 8443 });
    await telemetry(c, run(created.body.id, 3, 100, false, { error: 'connect: connection refused', resolved_target: '192.168.1.30' }));
    list = await incidents(a, 'active');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'service', severity: 'warning' });
    const dx = (await detail(a, list[0]!.id)).diagnosis as Diagnosis;
    expect(dx).toMatchObject({ rule: 'service-port-refused', confidence: 'high' });
    expect(dx.ruled_out[0]!.value).toContain('Online'); // the host itself is up
    await telemetry(c, run(created.body.id, 3, 50, true));
    expect(await incidents(a, 'active')).toHaveLength(0);
  });

  it("explains a collector gap from the collector's own buffered measurements", async () => {
    const { a, c, k } = await healthySite('gap');
    await systemPool.query(`UPDATE collectors SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [c.id]);
    await watchCollectors();
    let list = await incidents(a, 'active');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'collector', fault_domain: 'collector', confidence: 'low' });
    expect(((await detail(a, list[0]!.id)).diagnosis as Diagnosis).rule).toBe('collector-silent');
    // While nobody observes the site, the Doctor says so instead of guessing.
    expect((await a.agent.get('/api/v1/doctor')).body.items[0].diagnosis.fault_domain).toBe('insufficient_data');
    expect((await a.agent.post('/api/v1/doctor/run-checks').set(CSRF).send({ site_id: a.siteId })).status).toBe(409);

    await heartbeat(c, { spool_depth: 4 }); // reconnects …
    const id = list[0]!.id as string;
    expect((await detail(a, id)).status).toBe('resolved');
    // … and uploads what it measured meanwhile: internet was unreachable, gateway fine.
    await telemetry(c, [...run(k.cf, 3, 30, false), ...run(k.google, 3, 30, false), ...run(k.gateway, 3, 30, true, { resolved_target: '192.168.1.1' })]);
    const refined = (await detail(a, id)).diagnosis as Diagnosis;
    expect(refined).toMatchObject({ rule: 'collector-gap-explained', fault_domain: 'site_internet', confidence: 'high' });
    expect(refined.title).toContain('lost its internet connection');
  });

  it('enforces roles and tenant isolation', async () => {
    const { a, c, k } = await healthySite('inc-a');
    const b = await newAccount('inc-b');
    await telemetry(c, [...run(k.cf, 3, 60, false), ...run(k.google, 3, 60, false)]);
    const id = (await incidents(a))[0]!.id as string;

    expect(await incidents(b)).toHaveLength(0);
    expect((await b.agent.get(`/api/v1/incidents/${id}`)).status).toBe(404);
    expect((await b.agent.post(`/api/v1/incidents/${id}/acknowledge`).set(CSRF)).status).toBe(409); // indistinguishable from "not open"
    expect((await b.agent.post(`/api/v1/incidents/${id}/comments`).set(CSRF).send({ body: 'x' })).status).toBe(404);
    expect((await b.agent.post(`/api/v1/incidents/${id}/resolve`).set(CSRF).send({ note: 'not mine' })).status).toBe(409);
    expect((await b.agent.get(`/api/v1/topology?site_id=${a.siteId}`)).status).toBe(404);
    expect((await b.agent.get(`/api/v1/doctor?site_id=${a.siteId}`)).body.items).toHaveLength(0);
    expect((await b.agent.get(`/api/v1/time-machine/snapshot?at=${new Date().toISOString()}&site_id=${a.siteId}`)).body.devices.total).toBe(0);
    expect((await detail(a, id)).status).toBe('open');
    expect((await detail(a, id)).activity.some((x) => x.body === 'x')).toBe(false);
    // A user of another organization cannot be assigned.
    const outsider = (await b.agent.get('/api/v1/members')).body.items[0].id;
    expect((await a.agent.patch(`/api/v1/incidents/${id}`).set(CSRF).send({ assigned_to: outsider })).status).toBe(400);
    expect((await a.agent.get('/api/v1/members')).body.items).toHaveLength(1);

    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get(`/api/v1/incidents/${id}`)).status).toBe(200);
    expect((await a.agent.post(`/api/v1/incidents/${id}/acknowledge`).set(CSRF)).status).toBe(403);
    expect((await a.agent.post(`/api/v1/incidents/${id}/resolve`).set(CSRF).send({ note: 'viewer try' })).status).toBe(403);
    expect((await a.agent.post('/api/v1/doctor/run-checks').set(CSRF).send({ site_id: a.siteId })).status).toBe(403);
  });

  it('delivers a run-checks command to online collectors', async () => {
    const { a, c } = await healthySite('runchecks');
    expect((await a.agent.post('/api/v1/doctor/run-checks').set(CSRF).send({ site_id: a.siteId })).status).toBe(202);
    const hb = await heartbeat(c);
    expect(hb.body.commands).toEqual([expect.objectContaining({ kind: 'run_checks' })]);
  });
});

// ── Time Machine ──
describe('Network Time Machine', () => {
  it('reconstructs a past moment and compares two periods', async () => {
    const { a, c, k } = await healthySite('tm');
    const scopeId = await addScope(a, '192.168.1.0/24');
    const A = { ip: '192.168.1.10', mac: '00:0c:29:77:00:10', hostname: 'always-on' };
    const B = { ip: '192.168.1.20', mac: '00:0c:29:77:00:20', hostname: 'flaky' };
    await telemetry(c, [sweep(scopeId, [A, B], 20)]);
    await telemetry(c, [sweep(scopeId, [A], 15)]);
    await telemetry(c, [sweep(scopeId, [A], 10)]); // B offline from −10 min
    await telemetry(c, [sweep(scopeId, [A, { ...B, ip: '192.168.1.21' }], 5)]); // B back from −5 min on a new IP
    await telemetry(c, [...run(k.cf, 3, 8 * 60, false), ...run(k.google, 3, 8 * 60, false)]); // outage −8 min …
    await telemetry(c, [...run(k.cf, 3, 6 * 60, true), ...run(k.google, 3, 6 * 60, true)]); // … until −6 min

    // The test back-dates telemetry; in reality checks exist before their samples.
    await systemPool.query(`UPDATE monitoring_checks SET created_at = now() - interval '1 hour' WHERE organization_id = $1`, [a.organizationId]);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const snap = async (minutesAgo: number) => (await a.agent.get(`/api/v1/time-machine/snapshot?at=${encodeURIComponent(at(minutesAgo))}`)).body;

    expect((await snap(25)).devices.total).toBe(0); // before anything was discovered
    const early = await snap(12);
    expect(early.devices).toMatchObject({ total: 2, online: 2, offline: 0 });
    const during = await snap(7.5);
    expect(during.devices).toMatchObject({ online: 1, offline: 1 });
    const flakyThen = during.devices.items.find((d: { name: string }) => d.name === 'flaky');
    expect(flakyThen).toMatchObject({ status: 'offline', ip: '192.168.1.20' }); // the IP it had THEN
    expect(during.checks.find((x: { id: string }) => x.id === k.cf).state).toBe('down');
    expect(during.incidents).toHaveLength(1);
    expect(during.method.length).toBeGreaterThan(2);
    const after = await snap(1);
    expect(after.devices.items.find((d: { name: string }) => d.name === 'flaky')).toMatchObject({ status: 'online', ip: '192.168.1.21' });
    expect(after.checks.find((x: { id: string }) => x.id === k.cf).state).toBe('ok');
    expect(after.incidents).toHaveLength(0);

    expect((await a.agent.get(`/api/v1/time-machine/snapshot?at=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`)).status).toBe(400);
    expect((await a.agent.get('/api/v1/time-machine/snapshot?at=yesterday')).status).toBe(400);

    // Period A: −22…−12 min (both devices up, no incident). Period B: −9.5…−5.5 min (flaky down, outage).
    const q = `a_from=${encodeURIComponent(at(22))}&a_to=${encodeURIComponent(at(12))}&b_from=${encodeURIComponent(at(9.5))}&b_to=${encodeURIComponent(at(5.5))}`;
    const cmp = (await a.agent.get(`/api/v1/time-machine/compare?${q}`)).body;
    expect(cmp.a).toMatchObject({ devices_seen: 2, new_devices: 2, incidents: 0 });
    expect(cmp.b).toMatchObject({ devices_seen: 1, new_devices: 0, incidents: 1 });
    expect(cmp.devices_only_in_a.map((d: { name: string }) => d.name)).toEqual(['flaky']);
    expect(cmp.devices_only_in_b).toHaveLength(0);
    expect(cmp.b.events.check_down).toBe(2);
    const internetB = cmp.b.checks.find((x: { role: string }) => x.role === 'internet');
    expect(internetB.availability_pct).toBeLessThan(100);
    expect(cmp.incidents_b).toHaveLength(1);
    expect((await a.agent.get(`/api/v1/time-machine/compare?${q.replace('a_to', 'a_from').replace('a_from', 'a_to')}`)).status).toBe(400);

    // Long-range charts come from hourly roll-ups; the job is idempotent.
    await rollupCheckResults();
    await rollupCheckResults();
    const series = (await a.agent.get(`/api/v1/checks/${k.cf}/series?range=90d`)).body;
    expect(series.points.reduce((n: number, p: { samples: number }) => n + p.samples, 0)).toBe(8);
    expect(series.points.some((p: { ok_ratio: number }) => p.ok_ratio < 1)).toBe(true);
  });
});

// ── Topology ──
describe('topology', () => {
  it('builds the map from evidence and labels every edge observed or inferred', async () => {
    const a = await newAccount('topo');
    const scopeId = await addScope(a, '192.168.1.0/24');
    const c = await newCollector(a, 'edge');
    await heartbeat(c, { gateway_ip: '192.168.1.1', interfaces: [{ name: 'eth0', addresses: ['192.168.1.5/24'] }] });
    await telemetry(c, [
      sweep(scopeId, [
        { ip: '192.168.1.1', mac: '00:0c:29:01:00:01', hostname: 'gw' },
        { ip: '192.168.1.5', mac: '00:0c:29:01:00:05', hostname: 'collector-host' },
        { ip: '192.168.1.30' }, // answered ICMP only
      ]),
    ]);
    const k = await checksOf(a);
    await telemetry(c, run(k.cf, 1, 5, true));

    const t = (await a.agent.get(`/api/v1/topology?site_id=${a.siteId}`)).body as Topology;
    const node = (label: string) => t.nodes.find((n) => n.label === label)!;
    expect(t.nodes.map((n) => n.kind).sort()).toEqual(['device', 'device', 'gateway', 'internet', 'segment']);
    expect(node('gw')).toMatchObject({ kind: 'gateway', ip: '192.168.1.1' });
    expect(node('collector-host').runs_collector).toBe(true);

    const edgeFrom = (label: string) => t.edges.find((e) => e.source === node(label).id)!;
    expect(edgeFrom('collector-host')).toMatchObject({ relation: 'member_of', basis: 'observed', confidence: 'high', evidence_source: 'Collector neighbour table' });
    expect(edgeFrom('192.168.1.30')).toMatchObject({ basis: 'inferred', confidence: 'medium' });
    const gatewayOf = t.edges.find((e) => e.relation === 'gateway_of')!;
    expect(gatewayOf).toMatchObject({ source: 'seg:192.168.1.0/24', target: node('gw').id, basis: 'inferred' });
    expect(gatewayOf.evidence).toContain('default gateway');
    const uplink = t.edges.find((e) => e.relation === 'uplink')!;
    expect(uplink).toMatchObject({ target: 'internet', basis: 'inferred', confidence: 'high' });
    expect(uplink.last_verified_at).not.toBeNull();
    expect(t.edges.every((e) => e.evidence.length > 20 && e.evidence_source.length > 0)).toBe(true);
    expect(t.limitations.join(' ')).toContain('no managed switch has been read over SNMP');
    expect((await a.agent.get('/api/v1/topology')).status).toBe(400);
  });

  it('shows a gateway that lies outside every scope as known-but-unprobed', async () => {
    const a = await newAccount('topo2');
    const scopeId = await addScope(a, '192.168.50.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '10.0.0.1', interfaces: [{ name: 'eth0', addresses: ['10.0.0.7/24'] }] });
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.50.9' }])]);
    const t = (await a.agent.get(`/api/v1/topology?site_id=${a.siteId}`)).body as Topology;
    const gw = t.nodes.find((n) => n.kind === 'gateway')!;
    expect(gw).toMatchObject({ id: 'gw:10.0.0.1', device_id: null, status: null });
    // The collector is not in the scanned range, so membership is only weakly inferred and no gateway link is claimed.
    expect(t.edges.find((e) => e.relation === 'member_of')).toMatchObject({ basis: 'inferred', confidence: 'low' });
    expect(t.edges.some((e) => e.relation === 'gateway_of')).toBe(false);
  });
});
