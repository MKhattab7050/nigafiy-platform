import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Fleet Pro (migration 043): monitoring rules per group, evaluated on each heartbeat. A breach that
// lasts the rule's duration raises a Watch event and an incident; the first healthy measurement
// resolves it. Not measured never raises or resolves anything.

const hb = (cred: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/v1/agent/heartbeat')
    .set('Authorization', `Bearer ${cred}`)
    .send({ agent_version: '0.3.0', hostname: 'MON-PC', os: 'windows', arch: 'amd64', uptime_seconds: 60, cpu_pct: 5, ram_used_mb: 1000, ram_pct: 20, ...extra });

async function addMember(owner: TestAccount, role: 'admin' | 'technician' | 'viewer'): Promise<TestAccount> {
  const other = await newAccount(`mon-${role}`);
  const user = await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [other.email]);
  await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)`, [user.rows[0]!.id, owner.organizationId, role]);
  expect((await other.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: owner.organizationId })).status).toBe(200);
  return { ...other, organizationId: owner.organizationId, siteId: owner.siteId };
}

const events = async (orgId: string, type: string) =>
  (await systemPool.query<{ id: string; severity: string; title: string; details: Record<string, unknown> }>(`SELECT id, severity, title, details FROM network_events WHERE organization_id = $1 AND type = $2 ORDER BY occurred_at, id`, [orgId, type])).rows;
const incidents = async (orgId: string) =>
  (await systemPool.query<{ status: string; kind: string; correlation_key: string; resolution_note: string | null }>(`SELECT status, kind, correlation_key, resolution_note FROM incidents WHERE organization_id = $1 ORDER BY opened_at`, [orgId])).rows;
// Pretend the breach began earlier (the duration check uses the stored start).
const age = (ruleId: string, seconds: number) => systemPool.query(`UPDATE fleet_monitor_states SET breached_since = breached_since - make_interval(secs => $2) WHERE rule_id = $1`, [ruleId, seconds]);

describe('fleet: monitoring rules', () => {
  it('validates each kind, admins write, technicians and viewers read, every change is audited', async () => {
    const a = await newAccount('mon-roles');
    const viewer = await addMember(a, 'viewer');
    const tech = await addMember(a, 'technician');
    const bad = [
      { name: 'x', kind: 'cpu' },
      { name: 'x', kind: 'cpu', threshold: 150 },
      { name: 'x', kind: 'disk_free', threshold: 10 },
      { name: 'x', kind: 'service' },
      { name: 'x', kind: 'event_log', event_log: 'System' },
      { name: 'x', kind: 'cpu', threshold: 90, script: 'rm -rf /' },
    ];
    for (const b of bad) expect((await a.agent.post('/api/v1/fleet/monitoring/rules').set(CSRF).send(b)).status, JSON.stringify(b)).toBe(400);
    const r = await a.agent.post('/api/v1/fleet/monitoring/rules').set(CSRF).send({ name: 'CPU high', kind: 'cpu', threshold: 90, duration_seconds: 300, service_name: 'ignored' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.service_name).toBeNull();
    expect(r.body.threshold_unit).toBe('pct');
    expect((await tech.agent.post('/api/v1/fleet/monitoring/rules').set(CSRF).send({ name: 'x', kind: 'cpu', threshold: 50 })).status).toBe(403);
    expect((await viewer.agent.delete(`/api/v1/fleet/monitoring/rules/${r.body.id}`).set(CSRF)).status).toBe(403);
    expect((await viewer.agent.get('/api/v1/fleet/monitoring/rules')).body.rules).toHaveLength(1);
    expect((await a.agent.put(`/api/v1/fleet/monitoring/rules/${r.body.id}`).set(CSRF).send({ name: 'CPU very high', kind: 'cpu', threshold: 95 })).status).toBe(200);
    expect((await a.agent.delete(`/api/v1/fleet/monitoring/rules/${r.body.id}`).set(CSRF)).status).toBe(204);
    const actions = (await systemPool.query<{ action: string }>(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'fleet.monitor_rule_%' ORDER BY created_at, id`, [a.organizationId])).rows.map((x) => x.action);
    expect(actions).toEqual(['fleet.monitor_rule_created', 'fleet.monitor_rule_updated', 'fleet.monitor_rule_deleted']);
    // Other organizations see nothing.
    const b = await newAccount('mon-other');
    expect((await b.agent.get('/api/v1/fleet/monitoring/rules')).body.rules).toHaveLength(0);
  });

  it('CPU breach must last the duration, then raises an event and an incident; recovery resolves both', async () => {
    const a = await newAccount('mon-cpu');
    const { epId, cred } = await onlineEndpoint(a, 'MON-PC');
    const rule = (await a.agent.post('/api/v1/fleet/monitoring/rules').set(CSRF).send({ name: 'CPU high', kind: 'cpu', threshold: 90, duration_seconds: 120, severity: 'critical' })).body;
    expect((await hb(cred, { cpu_pct: 97 })).status).toBe(200);
    expect(await events(a.organizationId, 'endpoint_monitor_breach')).toHaveLength(0);
    let st = (await a.agent.get(`/api/v1/fleet/monitoring/states?endpoint_id=${epId}`)).body.states;
    expect(st[0].breached_since).toBeTruthy();
    expect(st[0].alerted_at).toBeNull();
    expect(st[0].last_value).toBe('CPU 97% (alert above 90%)');
    await age(rule.id, 121);
    await hb(cred, { cpu_pct: 95 });
    const raised = await events(a.organizationId, 'endpoint_monitor_breach');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('critical');
    expect(raised[0]!.title).toBe('MON-PC: CPU high — CPU 95% (alert above 90%)');
    expect(raised[0]!.details.endpoint_id).toBe(epId);
    let inc = await incidents(a.organizationId);
    expect(inc).toHaveLength(1);
    expect(inc[0]!.kind).toBe('endpoint');
    expect(inc[0]!.correlation_key).toBe(`endpoint:${epId}:rule:${rule.id}`);
    // Still breaching: no second event.
    await hb(cred, { cpu_pct: 99 });
    expect(await events(a.organizationId, 'endpoint_monitor_breach')).toHaveLength(1);
    // Healthy: recovered, incident resolved.
    await hb(cred, { cpu_pct: 12 });
    expect(await events(a.organizationId, 'endpoint_monitor_recovered')).toHaveLength(1);
    inc = await incidents(a.organizationId);
    expect(inc[0]!.status).toBe('resolved');
    st = (await a.agent.get(`/api/v1/fleet/monitoring/states?endpoint_id=${epId}`)).body.states;
    expect(st[0].breached_since).toBeNull();
  });

  it('disk free, service and event-log rules: the heartbeat tells the agent what to measure; not measured raises nothing', async () => {
    const a = await newAccount('mon-kinds');
    const { cred } = await onlineEndpoint(a, 'MON-PC');
    const mk = async (b: Record<string, unknown>) => {
      const r = await a.agent.post('/api/v1/fleet/monitoring/rules').set(CSRF).send({ duration_seconds: 0, ...b });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { id: string };
    };
    const disk = await mk({ name: 'C: low', kind: 'disk_free', threshold: 10, threshold_unit: 'gb', mount: 'C:' });
    const svc = await mk({ name: 'Spooler', kind: 'service', service_name: 'Spooler' });
    const evl = await mk({ name: 'Service crashes', kind: 'event_log', event_log: 'System', event_ids: [7031, 7034], event_level: 'error', threshold: 2, event_window_minutes: 30 });
    let r = await hb(cred);
    expect(r.body.monitor.services).toEqual(['Spooler']);
    expect(r.body.monitor.events).toEqual([{ id: evl.id, log: 'System', ids: [7031, 7034], level: 'error', window_minutes: 30 }]);
    // An older agent (no disks, no monitor block): nothing raised.
    expect(await events(a.organizationId, 'endpoint_monitor_breach')).toHaveLength(0);

    r = await hb(cred, {
      disks: [{ mount: 'C:', total_gb: 476.3, used_gb: 470.1, free_gb: 6.2, used_pct: 98.7 }],
      monitor: {
        services: { Spooler: 'stopped' },
        events: { [evl.id]: { count: 3, sample: 'Service Control Manager 7034 at 2026-11-24T09:58:00Z', measured_at: '2026-11-24T10:00:00Z' } },
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const titles = (await events(a.organizationId, 'endpoint_monitor_breach')).map((e) => e.title).sort();
    expect(titles).toEqual([
      'MON-PC: C: low — C: 6.2 GB free (alert below 10 GB)',
      'MON-PC: Service crashes — 3 matching entries in 30 min (alert at 2); newest: Service Control Manager 7034 at 2026-11-24T09:58:00Z',
      'MON-PC: Spooler — Service Spooler: stopped',
    ]);
    // A query the agent could not run keeps the alert open (not measured is not "recovered").
    await hb(cred, { monitor: { services: { Spooler: 'unknown' }, events: { [evl.id]: { count: 0, error: 'Get-WinEvent: access denied', measured_at: '2026-11-24T10:01:00Z' } } } });
    expect(await events(a.organizationId, 'endpoint_monitor_recovered')).toHaveLength(0);
    // Turning a rule off resolves its alert.
    expect((await a.agent.put(`/api/v1/fleet/monitoring/rules/${svc.id}`).set(CSRF).send({ name: 'Spooler', kind: 'service', service_name: 'Spooler', enabled: false })).status).toBe(200);
    const rec = await events(a.organizationId, 'endpoint_monitor_recovered');
    expect(rec).toHaveLength(1);
    expect(rec[0]!.details.reason).toBe('the rule was turned off');
    // A service that does not exist is a breach (named on the event).
    await mk({ name: 'Agent svc', kind: 'service', service_name: 'NoSuch' });
    await hb(cred, { monitor: { services: { NoSuch: 'not_found' }, events: {} } });
    expect((await events(a.organizationId, 'endpoint_monitor_breach')).some((e) => e.title.includes('does not exist'))).toBe(true);
    // Hostile monitor payloads are refused.
    expect((await hb(cred, { monitor: { services: {}, events: { 'not-a-uuid': { count: 1, measured_at: '2026-11-24T10:00:00Z' } } } })).status).toBe(400);
    void disk;
  });

  it('group rules apply to the group only; moving the computer out ends its alert', async () => {
    const a = await newAccount('mon-group');
    const { epId, cred } = await onlineEndpoint(a, 'MON-PC');
    const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Servers' });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const rule = (await a.agent.post('/api/v1/fleet/monitoring/rules').set(CSRF).send({ name: 'Mem', kind: 'memory', threshold: 80, duration_seconds: 0, fleet_group_id: g.body.group.id })).body;
    expect(rule.fleet_group_id, JSON.stringify(rule)).toBe(g.body.group.id);
    await hb(cred, { ram_pct: 95 });
    expect(await events(a.organizationId, 'endpoint_monitor_breach')).toHaveLength(0);
    const assign = await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ fleet_group_id: g.body.group.id, endpoint_ids: [epId] });
    expect(assign.status, JSON.stringify(assign.body)).toBeLessThan(300);
    await hb(cred, { ram_pct: 95 });
    expect(await events(a.organizationId, 'endpoint_monitor_breach')).toHaveLength(1);
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ fleet_group_id: null, endpoint_ids: [epId] });
    await hb(cred, { ram_pct: 95 });
    const rec = await events(a.organizationId, 'endpoint_monitor_recovered');
    expect(rec).toHaveLength(1);
    expect(rec[0]!.details.reason).toBe('the rule no longer applies to this computer');
    void rule;
  });
});
