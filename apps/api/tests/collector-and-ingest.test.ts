import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, systemPool } from '../src/infrastructure/db.ts';
import { watchCollectors } from '../src/jobs/collector-watch.ts';
import { dispatchNotifications } from '../src/jobs/notification-dispatch.ts';
import { CSRF, type TestAccount, type TestCollector, addScope, app, heartbeat, newAccount, newCollector, sweep, telemetry } from './helpers.ts';

afterAll(closePools);

const events = async (a: TestAccount, type: string) =>
  (await a.agent.get(`/api/v1/events?type=${type}&limit=200`)).body.items as { title: string; severity: string; details: Record<string, unknown>; device_id: string }[];
const devices = async (a: TestAccount) => (await a.agent.get('/api/v1/devices?sort=ip')).body.items as Record<string, any>[];

describe('collector registration and authentication', () => {
  it('rejects enrollment without a valid token', async () => {
    const res = await request(app).post('/api/v1/collector/enroll').send({ enrollment_token: `lde_${'x'.repeat(43)}`, hostname: 'h', version: '1', os: 'linux', arch: 'amd64' });
    expect(res.status).toBe(401);
    expect((await request(app).post('/api/v1/collector/enroll').send({})).status).toBe(400);
  });

  it('makes enrollment tokens single-use and expiring, and stores only hashes', async () => {
    const a = await newAccount('enroll');
    const c = await newCollector(a);
    const again = await request(app).post('/api/v1/collector/enroll').send({ enrollment_token: c.enrollmentToken, hostname: 'h', version: '1', os: 'linux', arch: 'amd64' });
    expect(again.status).toBe(401);

    const row = (await systemPool.query(`SELECT credential_hash, enrollment_token_hash FROM collectors WHERE id = $1`, [c.id])).rows[0];
    expect(row.enrollment_token_hash).toBeNull();
    expect(c.credential).not.toContain(row.credential_hash);
    expect(row.credential_hash).toMatch(/^[0-9a-f]{64}$/);

    const pending = await a.agent.post('/api/v1/collectors').set(CSRF).send({ site_id: a.siteId, name: 'late' });
    await systemPool.query(`UPDATE collectors SET enrollment_expires_at = now() - interval '1 minute' WHERE id = $1`, [pending.body.collector.id]);
    const expired = await request(app).post('/api/v1/collector/enroll').send({ enrollment_token: pending.body.enrollment_token, hostname: 'h', version: '1', os: 'linux', arch: 'amd64' });
    expect(expired.status).toBe(401);
    // The API never returns token or credential material when listing collectors.
    const list = JSON.stringify((await a.agent.get('/api/v1/collectors')).body);
    expect(list).not.toMatch(/lde_|ldc_|hash/);
  });

  it('rejects missing, forged and revoked credentials', async () => {
    const a = await newAccount('cred');
    const c = await newCollector(a);
    expect((await request(app).post('/api/v1/collector/heartbeat').send({})).status).toBe(401);
    const forged: TestCollector = { ...c, credential: `ldc_${c.id}.${'A'.repeat(43)}` };
    expect((await heartbeat(forged)).status).toBe(401);
    const otherId: TestCollector = { ...c, credential: c.credential.replace(c.id, randomUUID()) };
    expect((await heartbeat(otherId)).status).toBe(401);
    expect((await heartbeat(c)).status).toBe(200);
    expect((await a.agent.post(`/api/v1/collectors/${c.id}/revoke`).set(CSRF)).status).toBe(200);
    expect((await heartbeat(c)).status).toBe(401);
    expect((await telemetry(c, [{ type: 'check_result', check_id: randomUUID(), ts: new Date().toISOString(), ok: true }])).status).toBe(401);
  });

  it('delivers configuration and commands on heartbeat, scoped to the collector site', async () => {
    const a = await newAccount('config');
    const scopeId = await addScope(a, '192.168.40.0/24');
    const disabled = await addScope(a, '192.168.41.0/24');
    await a.agent.patch(`/api/v1/scopes/${disabled}`).set(CSRF).send({ enabled: false });
    const c = await newCollector(a);

    const first = await heartbeat(c, { gateway_ip: '192.168.40.1' });
    expect(first.status).toBe(200);
    expect(first.body.config.discovery.scopes).toEqual([{ id: scopeId, cidr: '192.168.40.0/24' }]);
    expect(first.body.config.checks.length).toBe(4);
    expect(first.body.config.checks[0]).toMatchObject({ kind: 'icmp', target: 'auto:gateway' });
    expect(first.body.commands).toEqual([]);

    expect((await a.agent.post(`/api/v1/collectors/${c.id}/scan`).set(CSRF)).status).toBe(202);
    const second = await heartbeat(c);
    expect(second.body.commands).toHaveLength(1);
    expect(second.body.commands[0].kind).toBe('run_discovery');
    // Re-delivered until acknowledged, then gone.
    expect((await heartbeat(c)).body.commands).toHaveLength(1);
    expect((await heartbeat(c, { completed_commands: [second.body.commands[0].id], gateway_ip: '192.168.40.1' })).body.commands).toHaveLength(0);

    const listed = (await a.agent.get('/api/v1/collectors')).body.items[0];
    expect(listed).toMatchObject({ status: 'active', connection_state: 'online', gateway_ip: '192.168.40.1' });
  });

  it('rejects malformed telemetry', async () => {
    const a = await newAccount('invalid');
    const scopeId = await addScope(a, '192.168.42.0/24');
    const c = await newCollector(a);
    const bad = [
      {},
      { batch_id: 'not-a-uuid', sent_at: new Date().toISOString(), items: [] },
      { batch_id: randomUUID(), sent_at: new Date().toISOString(), items: [{ type: 'shell_command', run: 'rm -rf /' }] },
      { batch_id: randomUUID(), sent_at: new Date().toISOString(), items: [{ ...sweep(scopeId, []), hosts: [{ ip: '999.1.1.1', sources: ['icmp'] }] }] },
      { batch_id: randomUUID(), sent_at: new Date().toISOString(), items: [{ ...sweep(scopeId, []), organization_id: randomUUID() }] },
      { batch_id: randomUUID(), sent_at: new Date().toISOString(), items: [{ type: 'check_result', check_id: randomUUID(), ts: 'yesterday', ok: true }] },
    ];
    for (const body of bad) {
      const res = await request(app).post('/api/v1/collector/telemetry').set('Authorization', `Bearer ${c.credential}`).send(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const future = await telemetry(c, [{ ...sweep(scopeId, [{ ip: '192.168.42.5' }]), finished_at: new Date(Date.now() + 3600_000).toISOString() }]);
    expect(future.body.rejected).toHaveLength(1);
    expect((await a.agent.get('/api/v1/devices')).body.total).toBe(0);
  });
});

describe('discovery ingestion and device identity', () => {
  it('builds the inventory, tracks identity across IP changes and detects offline/online', async () => {
    const a = await newAccount('disco');
    const scopeId = await addScope(a, '192.168.1.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.1.1' });

    // Sweep 1 (baseline). One host is outside the authorized scope and must be dropped.
    const batchId = randomUUID();
    const s1 = sweep(scopeId, [
      { ip: '192.168.1.1', mac: '00:0c:29:aa:00:01', hostname: 'gw.lan' },
      { ip: '192.168.1.10', mac: '00:0c:29:aa:00:10', hostname: 'nas.lan' },
      { ip: '192.168.1.20', mac: 'da:a1:19:00:00:20' }, // locally administered (randomized) MAC
      { ip: '192.168.1.30' }, // no MAC observable
      { ip: '10.99.0.5', mac: '00:0c:29:ff:ff:ff' }, // out of scope
    ], 20);
    const first = await telemetry(c, [s1], batchId);
    expect(first.body).toMatchObject({ duplicate: false, accepted: 1 });

    let list = await devices(a);
    expect(list.map((d) => d.current_ip)).toEqual(['192.168.1.1', '192.168.1.10', '192.168.1.20', '192.168.1.30']);
    expect(list[0]).toMatchObject({ device_type: 'router', type_source: 'inferred', vendor: 'VMware, Inc.', identity_basis: 'mac', status: 'online' });
    expect(list[0]!.type_evidence).toContain('default gateway');
    expect(list[2]).toMatchObject({ mac_randomized: true, vendor: null });
    expect(list[3]).toMatchObject({ identity_basis: 'ip', primary_mac: null, device_type: 'unknown', type_source: 'none' });
    expect(await events(a, 'device_discovered')).toHaveLength(0); // baseline → one summary event
    expect((await events(a, 'discovery_baseline'))[0]!.title).toContain('found 4 devices');

    // Replaying the same batch (at-least-once delivery) changes nothing.
    expect((await telemetry(c, [s1], batchId)).body).toMatchObject({ duplicate: true, accepted: 0 });
    expect((await a.agent.get('/api/v1/devices')).body.total).toBe(4);

    // Sweep 2: NAS moved to a new IP, .30 now shows its MAC, a new laptop appears, the phone (.20) is silent.
    await telemetry(c, [sweep(scopeId, [
      { ip: '192.168.1.1', mac: '00:0c:29:aa:00:01' },
      { ip: '192.168.1.11', mac: '00:0c:29:aa:00:10' },
      { ip: '192.168.1.30', mac: '00:0c:29:aa:00:30' },
      { ip: '192.168.1.40', mac: '00:0c:29:aa:00:40', hostname: 'laptop.lan' },
    ], 15)]);
    list = await devices(a);
    expect(list).toHaveLength(5);
    const nas = list.find((d) => d.primary_mac === '00:0c:29:aa:00:10')!;
    expect(nas.current_ip).toBe('192.168.1.11');
    expect(nas.hostname).toBe('nas.lan');
    expect((await events(a, 'device_ip_changed'))[0]!.details).toMatchObject({ previous_ip: '192.168.1.10', new_ip: '192.168.1.11' });
    expect(list.find((d) => d.current_ip === '192.168.1.30')).toMatchObject({ identity_basis: 'mac', primary_mac: '00:0c:29:aa:00:30' });
    expect((await events(a, 'device_discovered')).map((e) => e.title)).toEqual(['New device on the network: laptop.lan']);
    expect(list.find((d) => d.current_ip === '192.168.1.20')!.status).toBe('online'); // one missed sweep is not enough

    // Sweep 3: phone still silent → offline (2 consecutive misses), with evidence.
    await telemetry(c, [sweep(scopeId, [
      { ip: '192.168.1.1', mac: '00:0c:29:aa:00:01' },
      { ip: '192.168.1.11', mac: '00:0c:29:aa:00:10' },
      { ip: '192.168.1.30', mac: '00:0c:29:aa:00:30' },
      { ip: '192.168.1.40', mac: '00:0c:29:aa:00:40' },
    ], 10)]);
    const phone = (await devices(a)).find((d) => d.current_ip === '192.168.1.20')!;
    expect(phone.status).toBe('offline');
    const offline = await events(a, 'device_offline');
    expect(offline).toHaveLength(1);
    expect(offline[0]!.details).toMatchObject({ consecutive_missed_sweeps: 2, ip: '192.168.1.20' });

    // A buffered sweep older than what is applied is recorded but must not change live state.
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.1.20', mac: 'da:a1:19:00:00:20' }], 18)]);
    expect((await devices(a)).find((d) => d.current_ip === '192.168.1.20')!.status).toBe('offline');
    const runs = await systemPool.query(`SELECT applied FROM discovery_runs WHERE collector_id = $1 ORDER BY finished_at`, [c.id]);
    expect(runs.rows.map((r) => r.applied)).toEqual([true, false, true, true]);

    // Sweep 4: the phone is back, and .40 is suddenly answered by a different MAC.
    await telemetry(c, [sweep(scopeId, [
      { ip: '192.168.1.1', mac: '00:0c:29:aa:00:01' },
      { ip: '192.168.1.20', mac: 'da:a1:19:00:00:20' },
      { ip: '192.168.1.40', mac: '00:0c:29:bb:00:99' },
    ], 5)]);
    expect((await events(a, 'device_online'))[0]!.title).toContain('back online');
    const macChange = await events(a, 'ip_mac_changed');
    expect(macChange).toHaveLength(1);
    expect(macChange[0]!.details).toMatchObject({ ip: '192.168.1.40', previous_mac: '00:0c:29:aa:00:40', new_mac: '00:0c:29:bb:00:99' });
    expect(macChange[0]!.severity).toBe('warning');

    // Device detail: history is preserved.
    const detail = (await a.agent.get(`/api/v1/devices/${nas.id}`)).body;
    expect(detail.ip_history.map((h: { ip: string }) => h.ip).sort()).toEqual(['192.168.1.10', '192.168.1.11']);
    const phoneDetail = (await a.agent.get(`/api/v1/devices/${phone.id}`)).body;
    expect(phoneDetail.availability.map((x: { status: string }) => x.status)).toEqual(['online', 'offline', 'online']);
    expect(phoneDetail.recent_events.length).toBeGreaterThanOrEqual(2);

    // Manual classification wins over inference and survives later sweeps.
    const gw = (await devices(a)).find((d) => d.current_ip === '192.168.1.1')!;
    expect((await a.agent.patch(`/api/v1/devices/${gw.id}`).set(CSRF).send({ device_type: 'firewall', is_critical: true, tags: ['Core', 'core', 'edge'], owner: 'IT' })).status).toBe(200);
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.1.1', mac: '00:0c:29:aa:00:01' }], 1)]);
    const gwAfter = (await a.agent.get(`/api/v1/devices/${gw.id}`)).body;
    expect(gwAfter).toMatchObject({ device_type: 'firewall', type_source: 'manual', is_critical: true, tags: ['core', 'edge'], owner: 'IT' });

    // Filters, search (wildcards are literal) and pagination.
    expect((await a.agent.get('/api/v1/devices?status=offline')).body.total).toBeGreaterThanOrEqual(1);
    expect((await a.agent.get('/api/v1/devices?q=nas')).body.total).toBe(1);
    expect((await a.agent.get('/api/v1/devices?q=core')).body.total).toBe(1);
    expect((await a.agent.get('/api/v1/devices?q=%25')).body.total).toBe(0);
    const page = (await a.agent.get('/api/v1/devices?page_size=2&page=2')).body;
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(6);
    expect((await a.agent.get('/api/v1/devices?page_size=5000')).status).toBe(400);

    // Dashboard numbers are derived from the same stored data.
    const overview = (await a.agent.get('/api/v1/overview')).body;
    expect(overview.devices.total).toBe(6);
    expect(overview.devices.online + overview.devices.offline + overview.devices.unknown).toBe(6);
    expect(overview.internet.avg_latency_ms).toBeNull(); // no check samples yet → null, not a made-up number
    expect(overview.availability_24h_pct).toBeNull();
  });

  it('marks devices unknown (not offline) when the only collector goes silent', async () => {
    const a = await newAccount('silent');
    const scopeId = await addScope(a, '192.168.2.0/24');
    const c = await newCollector(a);
    await heartbeat(c);
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.2.5', mac: '00:0c:29:cc:00:05' }])]);
    await systemPool.query(`UPDATE collectors SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [c.id]);
    await watchCollectors();
    expect((await devices(a))[0]!.status).toBe('unknown');
    const off = await events(a, 'collector_offline');
    expect(off).toHaveLength(1);
    expect(off[0]!.severity).toBe('critical');
    await watchCollectors(); // idempotent: no duplicate alert
    expect(await events(a, 'collector_offline')).toHaveLength(1);
    expect((await a.agent.get('/api/v1/overview')).body.open_problems).toBe(1);

    await heartbeat(c);
    expect(await events(a, 'collector_online')).toHaveLength(1);
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.2.5', mac: '00:0c:29:cc:00:05' }])]);
    expect((await devices(a))[0]!.status).toBe('online');
    expect(await events(a, 'device_online')).toHaveLength(0); // unknown → online is not a recovery
  });
});

describe('monitoring checks', () => {
  const sample = (checkId: string, secondsAgo: number, ok: boolean, latency?: number, loss = ok ? 0 : 100) => ({
    type: 'check_result',
    check_id: checkId,
    ts: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    ok,
    ...(latency === undefined ? {} : { latency_ms: latency }),
    loss_pct: loss,
    ...(ok ? {} : { error: 'request timed out' }),
  });

  it('runs an explainable state machine with flap damping and one event per transition', async () => {
    const a = await newAccount('checks');
    const c = await newCollector(a);
    const checks = (await a.agent.get('/api/v1/checks')).body.items;
    const internet = checks.find((x: { target: string }) => x.target === '1.1.1.1');
    const state = async () => (await a.agent.get('/api/v1/checks')).body.items.find((x: { id: string }) => x.id === internet.id);

    await telemetry(c, [sample(internet.id, 600, true, 12), sample(internet.id, 570, true, 14)]);
    expect((await state()).state).toBe('ok');
    expect(await events(a, 'check_recovered')).toHaveLength(0);

    // Two failures: still ok (threshold is 3).
    const dup = sample(internet.id, 540, false);
    await telemetry(c, [dup, sample(internet.id, 510, false)]);
    expect((await state()).state).toBe('ok');
    // A healthy sample in between resets the counter.
    await telemetry(c, [sample(internet.id, 480, true, 15), sample(internet.id, 450, false), sample(internet.id, 420, false)]);
    expect((await state()).state).toBe('ok');
    await telemetry(c, [sample(internet.id, 390, false)]);
    const down = await state();
    expect(down).toMatchObject({ state: 'down', last_error: 'request timed out' });
    const downEvents = await events(a, 'check_down');
    expect(downEvents).toHaveLength(1);
    expect(downEvents[0]!.severity).toBe('critical');
    expect(downEvents[0]!.details).toMatchObject({ previous_state: 'ok', new_state: 'down', rule: '3 consecutive samples classified "down"' });

    // Still down → no repeated alerts. Duplicate sample → ignored.
    await telemetry(c, [sample(internet.id, 360, false), dup]);
    expect(await events(a, 'check_down')).toHaveLength(1);

    // Recovery, then sustained high latency → degraded with the reason recorded.
    await telemetry(c, [sample(internet.id, 330, true, 20), sample(internet.id, 300, true, 22), sample(internet.id, 270, true, 21)]);
    expect((await state()).state).toBe('ok');
    expect(await events(a, 'check_recovered')).toHaveLength(1);
    await telemetry(c, [sample(internet.id, 240, true, 400), sample(internet.id, 210, true, 380), sample(internet.id, 180, true, 420)]);
    expect((await state()).state).toBe('degraded');
    const degraded = await events(a, 'check_degraded');
    expect((degraded[0]!.details.reasons as string[])[0]).toContain('above the 150 ms threshold');

    // Historical series and dashboard figures come from the stored samples.
    const series = (await a.agent.get(`/api/v1/checks/${internet.id}/series?range=15m`)).body;
    const total = series.points.reduce((n: number, p: { samples: number }) => n + p.samples, 0);
    expect(total).toBe(15);
    expect(series.points.some((p: { ok_ratio: number }) => p.ok_ratio === 0)).toBe(true);
    const overview = (await a.agent.get('/api/v1/overview')).body;
    expect(overview.internet.samples).toBe(15);
    expect(overview.internet.avg_latency_ms).toBeGreaterThan(0);
    expect(overview.availability_24h_pct).toBeCloseTo((9 / 15) * 100, 1);
    expect(overview.checks.degraded).toBe(1);
  });

  it('validates check definitions', async () => {
    const a = await newAccount('checkdef');
    const post = (body: Record<string, unknown>) => a.agent.post('/api/v1/checks').set(CSRF).send({ site_id: a.siteId, ...body });
    expect((await post({ name: 'web', kind: 'tcp', target: 'intranet.lan', port: 443 })).status).toBe(201);
    expect((await post({ name: 'no port', kind: 'tcp', target: 'intranet.lan' })).status).toBe(400);
    expect((await post({ name: 'inject', kind: 'icmp', target: '1.1.1.1; reboot' })).status).toBe(400);
    expect((await post({ name: 'too fast', kind: 'icmp', target: '1.1.1.1', interval_seconds: 1 })).status).toBe(400);
  });
});

describe('notifications', () => {
  it('delivers signed webhooks for matching events and never exposes the signing secret', async () => {
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const a = await newAccount('hooks');
      const created = await a.agent.post('/api/v1/notification-channels').set(CSRF).send({ name: 'ops', url: `http://127.0.0.1:${port}/hook`, min_severity: 'critical' });
      expect(created.status).toBe(201);
      const secret: string = created.body.signing_secret;
      expect(JSON.stringify((await a.agent.get('/api/v1/notification-channels')).body)).not.toContain(secret.slice(6));
      const stored = await systemPool.query(`SELECT secret_encrypted FROM notification_channels WHERE id = $1`, [created.body.channel.id]);
      expect(stored.rows[0].secret_encrypted).toMatch(/^v1:/);
      expect(stored.rows[0].secret_encrypted).not.toContain(secret);

      const c = await newCollector(a); // 'collector_enrolled' is info → below the channel threshold
      await systemPool.query(`UPDATE collectors SET connection_state = 'online', last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [c.id]);
      await watchCollectors(); // critical event
      await dispatchNotifications();

      const mine = received.filter((r) => JSON.parse(r.body).organization_id === a.organizationId);
      expect(mine).toHaveLength(1);
      const payload = JSON.parse(mine[0]!.body);
      expect(payload.event).toMatchObject({ type: 'collector_offline', severity: 'critical' });
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(mine[0]!.headers['x-lan-detective-signature']))!;
      expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${mine[0]!.body}`).digest('hex'));
      expect((await a.agent.get('/api/v1/notification-channels')).body.items[0].last_delivery_status).toBe('delivered');

      expect((await a.agent.post('/api/v1/notification-channels').set(CSRF).send({ name: 'bad', url: 'ftp://example.com/x' })).status).toBe(400);
      expect((await a.agent.post('/api/v1/notification-channels').set(CSRF).send({ name: 'bad', url: 'https://user:pw@example.com/x' })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
