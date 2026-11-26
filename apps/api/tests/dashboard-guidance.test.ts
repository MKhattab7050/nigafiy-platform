import { describe, expect, it } from 'vitest';
import type { DashboardGuidance } from '@nigafiy/shared-types';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, sweep, telemetry, type TestAccount } from './helpers.ts';

const guidance = async (a: TestAccount, query = '') => {
  const res = await a.agent.get(`/api/v1/dashboard/guidance${query}`);
  expect(res.status).toBe(200);
  return res.body as DashboardGuidance;
};
const done = (g: DashboardGuidance) => Object.fromEntries(g.steps.map((s) => [s.key, s.done]));

describe('dashboard guidance', () => {
  it('works out every getting-started step from stored state', async () => {
    const a = await newAccount('guide');

    // A brand-new account: installed, nothing else.
    let g = await guidance(a);
    expect(g.steps.map((s) => s.key)).toEqual(['installed', 'scanned', 'reviewed', 'alerts', 'report']);
    expect(done(g)).toEqual({ installed: true, scanned: false, reviewed: false, alerts: false, report: false });
    expect(g.complete).toBe(false);
    expect(g.facts).toMatchObject({ devices_total: 0, last_sweep_at: null, sweeps_24h: 0, alert_channels: 0 });
    expect(g.steps[0]!.at).toBeTruthy();

    // First scan (empty), then two devices join: scanned, but they still need reviewing.
    const scopeId = await addScope(a, '192.168.41.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.41.1' });
    await telemetry(c, [sweep(scopeId, [], 20)]);
    await telemetry(c, [
      sweep(scopeId, [
        { ip: '192.168.41.1', mac: '00:0c:29:41:00:01', hostname: 'gw.lan' },
        { ip: '192.168.41.10', mac: '00:0c:29:41:00:10', hostname: 'nas.lan' },
      ], 10),
    ]);
    g = await guidance(a);
    expect(done(g)).toMatchObject({ scanned: true, reviewed: false });
    expect(g.facts.devices_total).toBe(2);
    expect(g.facts.devices_unreviewed).toBe(1); // the gateway is known by itself
    expect(g.facts.sweeps_24h).toBe(2);
    expect(g.facts.sweep_interval_seconds).toBeGreaterThan(0);
    expect(new Date(g.facts.last_sweep_at!).getTime()).toBeGreaterThan(Date.now() - 11 * 60_000);

    // Reviewing every device completes that step.
    expect((await a.agent.post('/api/v1/devices/trust').set(CSRF).send({ all_unreviewed: true, trust: 'known' })).status).toBe(200);
    g = await guidance(a);
    expect(done(g).reviewed).toBe(true);
    expect(g.steps.find((s) => s.key === 'reviewed')!.at).toBeTruthy();

    // A Telegram channel with no chat cannot deliver: not counted. A webhook can.
    await systemPool.query(
      `INSERT INTO notification_channels (organization_id, kind, name, url, secret_encrypted, enabled)
       VALUES ($1, 'telegram', 'Unlinked', 'telegram://linked-chats', 'x', true)`,
      [a.organizationId],
    );
    expect(done(await guidance(a)).alerts).toBe(false);
    await systemPool.query(
      `INSERT INTO notification_channels (organization_id, kind, name, url, secret_encrypted, enabled)
       VALUES ($1, 'webhook', 'Hook', 'https://hooks.example.test/x', 'x', true)`,
      [a.organizationId],
    );
    g = await guidance(a);
    expect(done(g).alerts).toBe(true);
    expect(g.facts.alert_channels).toBe(1);

    // The first summary sent completes the checklist.
    await systemPool.query(
      `INSERT INTO network_events (organization_id, type, severity, title, details, source, occurred_at)
       VALUES ($1, 'notification_summary', 'info', 'Weekly summary', '{}', 'platform', now())`,
      [a.organizationId],
    );
    g = await guidance(a);
    expect(done(g).report).toBe(true);
    expect(g.complete).toBe(true);
  });

  it('is scoped to the tenant and to the site asked for', async () => {
    const a = await newAccount('guide-a');
    const b = await newAccount('guide-b');
    const scopeId = await addScope(a, '192.168.42.0/24');
    const c = await newCollector(a);
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.42.5', mac: '00:0c:29:42:00:05' }], 5)]);
    expect((await guidance(a)).facts.devices_total).toBe(1);
    expect((await guidance(b)).facts.devices_total).toBe(0);
    expect(done(await guidance(b)).scanned).toBe(false);

    const other = await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Empty branch' });
    expect(other.status).toBe(201);
    const g = await guidance(a, `?site_id=${other.body.id}`);
    expect(g.facts.devices_total).toBe(0);
    expect(done(g).scanned).toBe(false);
    expect((await a.agent.get('/api/v1/dashboard/guidance?site_id=nope')).status).toBe(400);
  });
});
