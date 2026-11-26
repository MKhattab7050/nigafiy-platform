import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, systemPool } from '../src/infrastructure/db.ts';
import { applyMonitorGaps, detectRestartGap, recordAliveTick, watchCollectors } from '../src/modules/collectors/index.ts';
import { startCollectorWatchGrace } from '../src/modules/collectors/monitor-gaps.ts';
import { sendOutsideHeartbeats } from '../src/modules/notifications/index.ts';
import { CSRF, type TestAccount, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

afterAll(closePools);

const H = 3600_000;
const events = async (a: TestAccount, type: string) =>
  (await a.agent.get(`/api/v1/events?type=${type}&limit=50`)).body.items as { title: string; severity: string; details: Record<string, unknown> }[];

/** Same rule as the device page (web availability-strip weekAvailability): unknown time is not counted. */
function uptimePct(intervals: { status: string; started_at: Date | string; ended_at: Date | string | null }[], now: Date): number | null {
  let online = 0;
  let known = 0;
  for (const a of intervals) {
    const from = new Date(a.started_at).getTime();
    const to = a.ended_at ? new Date(a.ended_at).getTime() : now.getTime();
    if (to <= from || a.status === 'unknown') continue;
    known += to - from;
    if (a.status === 'online') online += to - from;
  }
  return known > 0 ? (online / known) * 100 : null;
}

describe('applyMonitorGaps (device history vs. monitor off)', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const at = (h: number) => new Date(now.getTime() - h * H);

  it('labels the part of an interval inside a gap as monitor off, keeps the rest', () => {
    const out = applyMonitorGaps([{ status: 'online', started_at: at(10), ended_at: null }], [{ started_at: at(6), ended_at: at(2) }], now);
    expect(out.map((s) => [s.status, !!s.monitor_off])).toEqual([
      ['online', false],
      ['unknown', true],
      ['online', false],
    ]);
    expect(out[1]).toMatchObject({ started_at: at(6), ended_at: at(2) });
    expect(out[2]!.ended_at).toBeNull(); // the current state continues after the gap
  });

  it('does not count monitor-off time as downtime', () => {
    // Device seen offline at 20:00, the PC was off all night, device online in the morning.
    const history = [
      { status: 'online' as const, started_at: at(12), ended_at: at(10) },
      { status: 'offline' as const, started_at: at(10), ended_at: at(1) },
      { status: 'online' as const, started_at: at(1), ended_at: null },
    ];
    const before = uptimePct(history, now)!;
    const after = uptimePct(applyMonitorGaps(history, [{ started_at: at(9.5), ended_at: at(1) }], now), now)!;
    // Before: 3 h online of 12 h. After: the 8.5 h when nothing was watching are not counted.
    expect(before).toBeCloseTo(25, 5);
    expect(after).toBeCloseTo((3 / 3.5) * 100, 5);
  });

  it('merges overlapping gaps and never invents history before the first interval', () => {
    const out = applyMonitorGaps(
      [{ status: 'offline', started_at: at(4), ended_at: at(3) }],
      [
        { started_at: at(8), ended_at: at(3.5) },
        { started_at: at(3.8), ended_at: at(3.2) },
      ],
      now,
    );
    expect(out).toEqual([
      { status: 'unknown', started_at: at(4), ended_at: at(3.2), monitor_off: true },
      { status: 'offline', started_at: at(3.2), ended_at: at(3) },
    ]);
    expect(applyMonitorGaps([{ status: 'online', started_at: at(2), ended_at: null }], [], now)).toHaveLength(1);
  });
});

describe('gap when the server itself was off', () => {
  it('records one gap and one calm notice per organization on start, and the dashboard shows it', async () => {
    const a = await newAccount('gap-api');
    const c = await newCollector(a);
    expect((await heartbeat(c)).status).toBe(200);

    const offFrom = new Date(Date.now() - 2 * H);
    await systemPool.query(`UPDATE collectors SET created_at = $2 WHERE id = $1`, [c.id, new Date(offFrom.getTime() - H)]);
    await systemPool.query(`INSERT INTO monitor_alive (id, last_alive_at) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET last_alive_at = $1`, [offFrom]);

    const gaps = await detectRestartGap();
    const mine = gaps.filter((g) => g.organization_id === a.organizationId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.started_at.getTime()).toBe(offFrom.getTime());

    // Started again right away: no second gap, no second notice.
    expect(await detectRestartGap()).toEqual([]);
    const row = await systemPool.query(`SELECT kind, site_id FROM monitoring_gaps WHERE organization_id = $1`, [a.organizationId]);
    expect(row.rows).toEqual([{ kind: 'api', site_id: null }]);

    const notices = await events(a, 'monitoring_off');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.severity).toBe('info');
    expect(notices[0]!.title).toMatch(/^Monitoring was off for 2 h/);
    expect(notices[0]!.details).toMatchObject({ kind: 'api', off_from: offFrom.toISOString() });

    const overview = (await a.agent.get('/api/v1/overview')).body;
    expect(overview.monitoring_off).toMatchObject({ kind: 'api', started_at: offFrom.toISOString() });
  });

  it('does not record a gap after a short restart', async () => {
    await recordAliveTick(new Date(Date.now() - 60_000));
    await systemPool.query(`UPDATE monitor_alive SET last_alive_at = now() - interval '60 seconds'`);
    expect(await detectRestartGap()).toEqual([]);
  });

  it('labels device history and the Time Machine during the gap as monitor off', async () => {
    const a = await newAccount('gap-device');
    const scope = await addScope(a, '192.168.77.0/24');
    const c = await newCollector(a);
    await heartbeat(c);
    expect((await telemetry(c, [sweep(scope, [{ ip: '192.168.77.20', mac: 'aa:bb:cc:00:77:20' }], 300)])).status).toBe(200);
    const device = (await a.agent.get('/api/v1/devices')).body.items[0] as { id: string };
    const from = new Date(Date.now() - 3 * H);
    const to = new Date(Date.now() - 1 * H);
    await systemPool.query(`INSERT INTO monitoring_gaps (organization_id, kind, started_at, ended_at) VALUES ($1, 'api', $2, $3)`, [a.organizationId, from, to]);

    const detail = (await a.agent.get(`/api/v1/devices/${device.id}`)).body;
    const off = detail.availability.filter((s: { monitor_off?: boolean }) => s.monitor_off);
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ status: 'unknown', started_at: from.toISOString(), ended_at: to.toISOString() });
    expect(detail.availability.at(-1)).toMatchObject({ status: 'online', ended_at: null });

    const during = (await a.agent.get(`/api/v1/time-machine/snapshot?at=${encodeURIComponent(new Date(Date.now() - 2 * H).toISOString())}`)).body;
    expect(during.devices.items.find((d: { id: string }) => d.id === device.id)?.status).toBe('unknown');
    const after = (await a.agent.get(`/api/v1/time-machine/snapshot?at=${encodeURIComponent(new Date(Date.now() - 0.5 * H).toISOString())}`)).body;
    expect(after.devices.items.find((d: { id: string }) => d.id === device.id)?.status).toBe('online');
  });
});

describe('gap when a Sensor went silent', () => {
  it('records a collector gap when heartbeats resume after a long silence, with one notice', async () => {
    const a = await newAccount('gap-collector');
    const c = await newCollector(a);
    await heartbeat(c);
    const silentFrom = new Date(Date.now() - 20 * 60_000);
    await systemPool.query(`UPDATE collectors SET last_heartbeat_at = $2 WHERE id = $1`, [c.id, silentFrom]);
    expect((await heartbeat(c)).status).toBe(200);
    expect((await heartbeat(c)).status).toBe(200); // the next normal heartbeat adds nothing

    const rows = await systemPool.query(`SELECT kind, site_id, collector_id, started_at FROM monitoring_gaps WHERE organization_id = $1`, [a.organizationId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ kind: 'collector', site_id: a.siteId, collector_id: c.id });
    expect((rows.rows[0].started_at as Date).getTime()).toBe(silentFrom.getTime());
    const notices = await events(a, 'monitoring_off');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Monitoring was off for 20 min');
  });

  it('does not add a second notice when the collector watch already reported the Sensor lost', async () => {
    const a = await newAccount('gap-watched');
    const c = await newCollector(a);
    await heartbeat(c);
    await systemPool.query(`UPDATE collectors SET last_heartbeat_at = now() - interval '15 minutes' WHERE id = $1`, [c.id]);
    await watchCollectors();
    expect(await events(a, 'collector_offline')).toHaveLength(1);
    await heartbeat(c);
    expect(await events(a, 'collector_online')).toHaveLength(1);
    expect(await events(a, 'monitoring_off')).toHaveLength(0);
    // The history still knows about it.
    expect((await systemPool.query(`SELECT 1 FROM monitoring_gaps WHERE organization_id = $1 AND kind = 'collector'`, [a.organizationId])).rowCount).toBe(1);
  });

  it('right after the server starts, Sensors are not declared lost before they could report', async () => {
    const a = await newAccount('gap-grace');
    const c = await newCollector(a);
    await heartbeat(c);
    await systemPool.query(`UPDATE collectors SET last_heartbeat_at = now() - interval '15 minutes' WHERE id = $1`, [c.id]);
    startCollectorWatchGrace(120);
    try {
      await watchCollectors();
      expect(await events(a, 'collector_offline')).toHaveLength(0);
    } finally {
      startCollectorWatchGrace(0);
    }
    await watchCollectors();
    expect(await events(a, 'collector_offline')).toHaveLength(1);
  });
});

describe('outside heartbeat (push URL)', () => {
  async function pushServer() {
    const hits: { method: string; url: string }[] = [];
    let status = 200;
    const server = http.createServer((req, res) => {
      hits.push({ method: req.method ?? '', url: req.url ?? '' });
      res.statusCode = status;
      res.end('OK');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return { hits, port, setStatus: (s: number) => (status = s), close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('validates the URL and is admin-only', async () => {
    const a = await newAccount('hb-validate');
    expect((await a.agent.get('/api/v1/notifications/heartbeat')).body).toMatchObject({ configured: false, url_host: null, interval_seconds: 60 });
    for (const url of ['not a url', 'ftp://example.test/ping', 'https://user:pass@hc-ping.example.test/abc']) {
      const res = await a.agent.put('/api/v1/notifications/heartbeat').set(CSRF).send({ url });
      expect(res.status, url).toBe(400);
    }
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get('/api/v1/notifications/heartbeat')).status).toBe(403);
    expect((await a.agent.put('/api/v1/notifications/heartbeat').set(CSRF).send({ url: 'https://hc-ping.example.test/x' })).status).toBe(403);
  });

  it('pings on save and then every run while a Sensor reports; never returns the URL', async () => {
    const srv = await pushServer();
    try {
      const a = await newAccount('hb-ping');
      const c = await newCollector(a);
      const url = `http://127.0.0.1:${srv.port}/ping/secret-token-1234`;
      const saved = await a.agent.put('/api/v1/notifications/heartbeat').set(CSRF).send({ url });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ configured: true, url_host: '127.0.0.1', last_status: 200, last_error: null });
      expect(srv.hits).toEqual([{ method: 'GET', url: '/ping/secret-token-1234' }]);
      expect(JSON.stringify((await a.agent.get('/api/v1/notifications/heartbeat')).body)).not.toContain('secret-token');
      const stored = await systemPool.query(`SELECT url_sealed FROM monitor_heartbeat WHERE organization_id = $1`, [a.organizationId]);
      expect(stored.rows[0].url_sealed).not.toContain('secret-token');
      const audits = await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'outside_heartbeat.set'`, [a.organizationId]);
      expect(JSON.stringify(audits.rows)).not.toContain('secret-token');

      // The Sensor has never reported: nothing is being watched, so no ping.
      await sendOutsideHeartbeats();
      expect(srv.hits).toHaveLength(1);
      await heartbeat(c);
      await sendOutsideHeartbeats();
      expect(srv.hits.filter((h) => h.url === '/ping/secret-token-1234')).toHaveLength(2);

      // The service answering an error is recorded for the settings page.
      srv.setStatus(503);
      await sendOutsideHeartbeats();
      const after = (await a.agent.get('/api/v1/notifications/heartbeat')).body;
      expect(after).toMatchObject({ last_status: 503, last_error: 'The service answered HTTP 503' });

      expect((await a.agent.delete('/api/v1/notifications/heartbeat').set(CSRF)).body.configured).toBe(false);
      const before = srv.hits.length;
      await sendOutsideHeartbeats();
      expect(srv.hits.length).toBe(before);
    } finally {
      await srv.close();
    }
  });

  it('records an unreachable URL without leaking its path', async () => {
    const a = await newAccount('hb-down');
    // Nothing listens on this port.
    const res = await a.agent.put('/api/v1/notifications/heartbeat').set(CSRF).send({ url: 'http://127.0.0.1:1/ping/hidden-token' });
    expect(res.status).toBe(200);
    expect(res.body.last_status).toBeNull();
    expect(res.body.last_error).toBeTruthy();
    expect(res.body.last_error).not.toContain('hidden-token');
  });
});
