import { describe, expect, it } from 'vitest';
import { systemPool, withSystem } from '../src/infrastructure/db.ts';
import { emitEvent } from '../src/modules/events/index.ts';
import { watchMaintenance } from '../src/modules/maintenance/watch.ts';
import { CSRF, type TestAccount, newAccount, setRole } from './helpers.ts';

/**
 * Maintenance windows: wall-clock times in the window's IANA zone (DST and half-hour offsets),
 * one-off and weekly occurrences, scope (site and targets), and what "in maintenance" does to an
 * event: recorded on the event, no notification queued, no incident opened.
 */

async function addDevice(a: TestAccount, siteId: string, ip: string): Promise<string> {
  const r = await systemPool.query<{ id: string }>(
    `INSERT INTO devices (organization_id, site_id, identity_basis, current_ip, hostname, device_type, type_source, first_seen_at, last_seen_at)
     VALUES ($1,$2,'ip',$3,$4,'unknown','manual',now(),now()) RETURNING id`,
    [a.organizationId, siteId, ip, `host-${ip}`],
  );
  return r.rows[0]!.id;
}

/** A critical device_offline event at `at` (would open a device incident and notify outside maintenance). */
async function offline(a: TestAccount, siteId: string, deviceId: string, at: string) {
  const id = await withSystem((db) =>
    emitEvent(db, a.organizationId, {
      siteId,
      deviceId,
      type: 'device_offline',
      severity: 'critical',
      title: 'Device stopped responding',
      details: { evidence: ['test'] },
      source: 'platform',
      occurredAt: new Date(at),
    }),
  );
  const ev = (await systemPool.query<{ in_maintenance: boolean; maintenance_window_id: string | null }>(`SELECT in_maintenance, maintenance_window_id FROM network_events WHERE id = $1`, [id])).rows[0]!;
  const deliveries = (await systemPool.query(`SELECT 1 FROM notification_deliveries WHERE event_id = $1`, [id])).rowCount;
  return { id, ...ev, deliveries };
}

const KOLKATA = ['Asia/Kolkata', 'Asia/Calcutta'];

const incidentsFor = async (orgId: string, deviceId: string) =>
  (await systemPool.query(`SELECT 1 FROM incidents WHERE organization_id = $1 AND correlation_key = $2`, [orgId, `device:${deviceId}`])).rowCount;

describe('maintenance windows', () => {
  it('validates input, enforces roles, defaults to the site zone, scopes the list per site, and audits', async () => {
    const a = await newAccount('mw-api');
    const branch = await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Branch', timezone: 'Asia/Kolkata' });
    expect(branch.status).toBe(201);
    const post = (body: Record<string, unknown>) => a.agent.post('/api/v1/maintenance').set(CSRF).send(body);

    expect((await post({ reason: 'x', timezone: 'Mars/Olympus', starts_local: '2026-12-01T01:00', ends_local: '2026-12-01T02:00' })).status).toBe(400);
    const backwards = await post({ reason: 'x', starts_local: '2026-12-01T03:00', ends_local: '2026-12-01T02:00' });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.code).toBe('invalid_window');
    expect((await post({ reason: 'x', starts_local: '2026-12-01T01:00', ends_local: '2026-12-01T02:00', recur_until: '2026-12-31' })).status).toBe(400);
    expect((await post({ reason: 'x', starts_local: '2026-12-01T01:00', ends_local: '2026-12-10T02:00', weekdays: [2] })).status).toBe(400); // > 7 days per occurrence
    expect((await post({ reason: 'x', target_all: false, starts_local: '2026-12-01T01:00', ends_local: '2026-12-01T02:00' })).body.error.code).toBe('empty_target');

    const created = await post({ site_id: branch.body.id, reason: 'Core switch firmware', starts_local: '2026-12-01T22:00', ends_local: '2026-12-02T01:30', weekdays: [2, 2, 4] });
    expect(created.status).toBe(201);
    // The site's zone is used; the zone check stores ICU's canonical id (Asia/Kolkata may come back as Asia/Calcutta).
    expect(KOLKATA).toContain(created.body.timezone);
    expect(created.body).toMatchObject({ weekdays: [2, 4], target_all: true, starts_local: '2026-12-01T22:00:00', ends_local: '2026-12-02T01:30:00' });
    const hq = await post({ site_id: a.siteId, reason: 'UPS swap', timezone: 'America/New_York', starts_local: '2026-12-05T01:00', ends_local: '2026-12-05T03:00' });
    expect(hq.status).toBe(201);
    // 01:00 in New York in December (EST, UTC-5) is 06:00 UTC.
    expect(hq.body.next_occurrence).toEqual({ start: '2026-12-05T06:00:00.000Z', end: '2026-12-05T08:00:00.000Z' });

    const hqList = (await a.agent.get(`/api/v1/maintenance?site_id=${a.siteId}`)).body.items.map((w: { id: string }) => w.id);
    expect(hqList).toEqual([hq.body.id]);
    expect((await a.agent.get('/api/v1/maintenance')).body.items).toHaveLength(2);

    await setRole(a.email, a.organizationId, 'viewer');
    expect((await post({ reason: 'x', starts_local: '2026-12-01T01:00', ends_local: '2026-12-01T02:00' })).status).toBe(403);
    expect((await a.agent.get('/api/v1/maintenance')).status).toBe(200);
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.patch(`/api/v1/maintenance/${hq.body.id}`).set(CSRF).send({ reason: 'UPS battery swap' })).status).toBe(200);

    const other = await newAccount('mw-api-other');
    expect((await other.agent.patch(`/api/v1/maintenance/${hq.body.id}`).set(CSRF).send({ reason: 'mine now' })).status).toBe(404);
    expect((await other.agent.delete(`/api/v1/maintenance/${hq.body.id}`).set(CSRF)).status).toBe(404);
    expect((await other.agent.get('/api/v1/maintenance')).body.items).toHaveLength(0);

    expect((await a.agent.delete(`/api/v1/maintenance/${hq.body.id}`).set(CSRF)).status).toBe(204);
    const actions = (await systemPool.query<{ action: string }>(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'maintenance.%' ORDER BY created_at`, [a.organizationId])).rows.map((r) => r.action);
    expect(actions).toEqual(['maintenance.created', 'maintenance.created', 'maintenance.updated', 'maintenance.deleted']);
  });

  it('one-off window in America/New_York across the DST change: only targeted devices of its site are in maintenance', async () => {
    const a = await newAccount('mw-oneoff');
    const branch = (await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Branch', timezone: 'UTC' })).body.id as string;
    const d1 = await addDevice(a, a.siteId, '10.20.0.11');
    const d2 = await addDevice(a, a.siteId, '10.20.0.12');
    const d3 = await addDevice(a, branch, '10.21.0.13');
    expect((await a.agent.post('/api/v1/notification-channels').set(CSRF).send({ name: 'ops', url: 'http://127.0.0.1:9/hook', min_severity: 'info' })).status).toBe(201);

    // 2026-03-08: clocks in New York go from 02:00 EST to 03:00 EDT. 01:00 EST = 06:00Z, 04:00 EDT = 08:00Z,
    // so the window lasts two real hours (a fixed -05:00 offset would wrongly end it at 09:00Z).
    const w = await a.agent.post('/api/v1/maintenance').set(CSRF).send({
      site_id: a.siteId,
      reason: 'Replace the core switch',
      timezone: 'America/New_York',
      starts_local: '2026-03-08T01:00:00',
      ends_local: '2026-03-08T04:00:00',
      device_ids: [d1],
    });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ target_all: false, device_ids: [d1], active: false, next_occurrence: null });

    const inside = await offline(a, a.siteId, d1, '2026-03-08T07:30:00Z');
    expect(inside).toMatchObject({ in_maintenance: true, maintenance_window_id: w.body.id, deliveries: 0 });
    expect(await incidentsFor(a.organizationId, d1)).toBe(0);

    // Same time, same site, a device the window does not target; and a device at another site.
    const untargeted = await offline(a, a.siteId, d2, '2026-03-08T07:30:00Z');
    expect(untargeted).toMatchObject({ in_maintenance: false, maintenance_window_id: null });
    expect(untargeted.deliveries).toBeGreaterThan(0);
    expect(await incidentsFor(a.organizationId, d2)).toBe(1);
    expect((await offline(a, branch, d3, '2026-03-08T07:30:00Z')).in_maintenance).toBe(false);

    // Edges in UTC: before the start, after the real (DST-shortened) end, and at the end instant (exclusive).
    expect((await offline(a, a.siteId, d1, '2026-03-08T05:59:00Z')).in_maintenance).toBe(false);
    expect((await offline(a, a.siteId, d1, '2026-03-08T06:00:00Z')).in_maintenance).toBe(true);
    expect((await offline(a, a.siteId, d1, '2026-03-08T08:00:00Z')).in_maintenance).toBe(false);
    expect((await offline(a, a.siteId, d1, '2026-03-08T08:30:00Z')).in_maintenance).toBe(false);
  });

  it('weekly window in Asia/Kolkata (UTC+05:30) crossing midnight, limited by recur_until and site scope', async () => {
    const a = await newAccount('mw-weekly');
    const branch = (await a.agent.post('/api/v1/sites').set(CSRF).send({ name: 'Pune', timezone: 'Asia/Kolkata' })).body.id as string;
    const hqDevice = await addDevice(a, a.siteId, '10.30.0.21');
    const branchDevice = await addDevice(a, branch, '10.31.0.22');

    // Mondays 22:00 → Tuesdays 02:00 Kolkata time (16:30Z → 20:30Z Monday), from 2 Nov until 20 Nov 2026.
    const w = await a.agent.post('/api/v1/maintenance').set(CSRF).send({
      site_id: branch,
      reason: 'Weekly backup window',
      starts_local: '2026-11-02T22:00',
      ends_local: '2026-11-03T02:00',
      weekdays: [1],
      recur_until: '2026-11-20',
    });
    expect(w.status).toBe(201);
    expect(KOLKATA).toContain(w.body.timezone);
    expect(w.body).toMatchObject({ weekdays: [1], recur_until: '2026-11-20', target_all: true });

    const at = async (iso: string, siteId = branch, deviceId = branchDevice) => (await offline(a, siteId, deviceId, iso)).in_maintenance;
    expect(await at('2026-11-16T16:45:00Z')).toBe(true); // Mon 22:15 IST
    expect(await at('2026-11-16T19:00:00Z')).toBe(true); // Tue 00:30 IST, same occurrence after midnight
    expect(await at('2026-11-16T16:15:00Z')).toBe(false); // Mon 21:45 IST
    expect(await at('2026-11-16T20:45:00Z')).toBe(false); // Tue 02:15 IST
    expect(await at('2026-11-17T17:00:00Z')).toBe(false); // Tue 22:30 IST: not a selected weekday
    expect(await at('2026-11-23T17:00:00Z')).toBe(false); // Monday after recur_until
    expect(await at('2026-10-26T17:00:00Z')).toBe(false); // Monday before the first occurrence
    expect(await at('2026-11-02T16:30:00Z')).toBe(true); // the first occurrence, at its start instant
    // The window is for the Pune site only.
    expect(await at('2026-11-16T16:45:00Z', a.siteId, hqDevice)).toBe(false);
    const ids = (await systemPool.query<{ maintenance_window_id: string | null }>(`SELECT DISTINCT maintenance_window_id FROM network_events WHERE organization_id = $1 AND in_maintenance`, [a.organizationId])).rows;
    expect(ids).toEqual([{ maintenance_window_id: w.body.id }]);
  });

  it('records each occurrence as a run with started / ended events, and the window scope', async () => {
    const a = await newAccount('mw-runs');
    const w = await a.agent.post('/api/v1/maintenance').set(CSRF).send({
      site_id: a.siteId,
      reason: 'Rewire the rack',
      timezone: 'Europe/Berlin',
      starts_local: '2026-07-04T09:00',
      ends_local: '2026-07-04T10:00',
    });
    expect(w.status).toBe(201);
    // 09:00 in Berlin in July (CEST, UTC+2) is 07:00Z.
    await watchMaintenance(new Date('2026-07-04T07:15:00Z'));
    await watchMaintenance(new Date('2026-07-04T07:20:00Z')); // idempotent: still one run
    const runs = (await systemPool.query<{ id: string; occurrence_start: Date; occurrence_end: Date; scope: Record<string, unknown>; ended_at: Date | null }>(`SELECT id, occurrence_start, occurrence_end, scope, ended_at FROM maintenance_runs WHERE window_id = $1`, [w.body.id])).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.occurrence_start.toISOString()).toBe('2026-07-04T07:00:00.000Z');
    expect(runs[0]!.occurrence_end.toISOString()).toBe('2026-07-04T08:00:00.000Z');
    expect(runs[0]!.scope).toMatchObject({ target_all: true });
    expect(runs[0]!.ended_at).toBeNull();

    await watchMaintenance(new Date('2026-07-04T08:05:00Z'));
    const ended = (await systemPool.query<{ ended_at: Date | null }>(`SELECT ended_at FROM maintenance_runs WHERE id = $1`, [runs[0]!.id])).rows[0]!;
    expect(ended.ended_at?.toISOString()).toBe('2026-07-04T08:05:00.000Z');
    const events = (await systemPool.query<{ type: string; in_maintenance: boolean; details: { window_id: string } }>(`SELECT type, in_maintenance, details FROM network_events WHERE organization_id = $1 AND type LIKE 'maintenance_%' ORDER BY occurred_at`, [a.organizationId])).rows;
    expect(events.map((e) => e.type)).toEqual(['maintenance_started', 'maintenance_ended']);
    expect(events.every((e) => e.details.window_id === w.body.id && !e.in_maintenance)).toBe(true);
  });
});
