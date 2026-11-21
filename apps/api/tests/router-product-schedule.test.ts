import { describe, expect, it } from 'vitest';
import { withSystem } from '../src/infrastructure/db.ts';
import { type ProductScheduleRow, enforceSchedule, localClock, windowState } from '../src/modules/routers/product-schedule.ts';
import { CSRF, type TestAccount, type TestCollector, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

// Schedules LAN Detective enforces itself with the router's block, for a router that can block a
// device but cannot schedule it (docs/features/router-controls.md, "Schedules").

const CAPS = [
  { capability: 'clients', supported: true },
  { capability: 'block', supported: true, mechanism: 'per-device internet blocking' },
  { capability: 'schedule', supported: false, note: 'parental control is not enforced while EasyMesh is on' },
];
const LAPTOP_MAC = 'aa:bb:cc:00:00:20';

interface Setup {
  a: TestAccount;
  c: TestCollector;
  routerId: string;
  devices: Record<string, string>;
}

async function commands(c: TestCollector, kind: string) {
  const hb = await heartbeat(c);
  expect(hb.status).toBe(200);
  return (hb.body.commands as { id: string; kind: string; payload: Record<string, unknown> }[]).filter((x) => x.kind === kind);
}

function result(routerId: string, fields: Record<string, unknown>) {
  return { type: 'router_result', ts: new Date().toISOString(), router_id: routerId, trigger: 'command', duration_ms: 9, ...fields };
}

async function setup(label: string): Promise<Setup> {
  const a = await newAccount(label);
  const scopeId = await addScope(a, '192.168.60.0/24');
  const c = await newCollector(a);
  await heartbeat(c);
  await telemetry(c, [
    sweep(scopeId, [
      { ip: '192.168.60.1', mac: '00:11:22:33:55:01', hostname: 'gateway' },
      { ip: '192.168.60.20', mac: LAPTOP_MAC, hostname: 'laptop' },
    ]),
  ]);
  const list = await a.agent.get('/api/v1/devices?page_size=50');
  const devices: Record<string, string> = {};
  for (const d of list.body.items) devices[d.current_ip] = d.id;
  const created = await a.agent.post('/api/v1/routers').set(CSRF).send({
    site_id: a.siteId,
    name: 'Home router',
    vendor: 'zyxel',
    address: '192.168.60.1',
    transport: 'https',
    credentials: { username: 'admin-user', password: 'router-pass-77' },
  });
  expect(created.status).toBe(201);
  const s = { a, c, routerId: created.body.id, devices };
  const q = await a.agent.post(`/api/v1/routers/${s.routerId}/refresh`).set(CSRF).send({});
  const [refreshCmd] = await commands(c, 'router_refresh');
  await telemetry(c, [
    result(s.routerId, {
      request_id: q.body.request_id,
      action: 'refresh',
      ok: true,
      capabilities: CAPS,
      clients: [{ mac: LAPTOP_MAC, ip: '192.168.60.20', hostname: 'laptop', connection: 'wifi_5ghz' }],
      blocked: [],
    }),
  ]);
  await heartbeat(c, { completed_commands: [refreshCmd!.id] });
  return s;
}

const change = (action: 'block' | 'unblock', already = false) => ({
  action,
  mac: LAPTOP_MAC,
  mechanism: 'per-device internet blocking',
  applied: !already,
  already_in_effect: already,
  detail: action === 'block' ? 'internet blocked' : 'internet allowed',
  undo: 'Unblock in LAN Detective',
});

/** The collector carries out the pending block/unblock command and reports it. */
async function carryOut(s: Setup, action: 'block' | 'unblock', already = false) {
  const [cmd] = await commands(s.c, `router_${action}`);
  expect(cmd, `a router_${action} command`).toBeDefined();
  const t = await telemetry(s.c, [result(s.routerId, { request_id: cmd!.payload.request_id, action, ok: true, mac: LAPTOP_MAC, change: change(action, already) })]);
  expect(t.body).toMatchObject({ accepted: 1 });
  await heartbeat(s.c, { completed_commands: [cmd!.id] });
  return cmd!;
}

const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
/** A window around "now" (UTC), crossing midnight when it has to. */
function windowAroundNow(beforeMin = 60, afterMin = 60) {
  const now = Date.now();
  return { days: ALL_DAYS, start: hhmm(new Date(now - beforeMin * 60_000)), end: hhmm(new Date(now + afterMin * 60_000)) };
}

async function enforceAt(routerId: string, at: Date) {
  return withSystem(async (db) => {
    const row = (
      await db.query<ProductScheduleRow>(
        `SELECT id, organization_id, site_id, router_id, device_id, mac::text AS mac, windows, timezone, created_by, created_by_email, created_at, updated_at,
                block_request_id, unblock_request_id, paused_until, removing, last_attempt_at, last_error
           FROM router_product_schedules WHERE router_id = $1`,
        [routerId],
      )
    ).rows[0];
    return row ? enforceSchedule(db, row, at) : 'none';
  });
}

async function scheduleRow(routerId: string) {
  return withSystem(async (db) => (await db.query(`SELECT * FROM router_product_schedules WHERE router_id = $1`, [routerId])).rows[0] ?? null);
}

describe('window arithmetic', () => {
  it('reads wall-clock time in the schedule’s time zone', () => {
    const at = new Date('2026-11-22T21:30:00Z'); // a Sunday
    expect(localClock(at, 'UTC')).toEqual({ day: 0, minute: 21 * 60 + 30 });
    expect(localClock(at, 'Africa/Cairo')).toEqual({ day: 0, minute: 23 * 60 + 30 }); // UTC+2
    expect(localClock(new Date('2026-11-22T22:30:00Z'), 'Africa/Cairo')).toEqual({ day: 1, minute: 30 });
  });

  it('handles same-day windows, windows across midnight and their days', () => {
    const w = [{ days: [0], start: '22:00', end: '07:00' }]; // Sunday night → Monday morning
    expect(windowState(w, new Date('2026-11-22T23:00:00Z'), 'UTC')).toEqual({ active: true, minutesLeft: 8 * 60 });
    expect(windowState(w, new Date('2026-11-23T06:30:00Z'), 'UTC')).toEqual({ active: true, minutesLeft: 30 }); // Monday, from Sunday's window
    expect(windowState(w, new Date('2026-11-23T07:00:00Z'), 'UTC').active).toBe(false);
    expect(windowState(w, new Date('2026-11-23T23:00:00Z'), 'UTC').active).toBe(false); // Monday night: not a chosen day
    const day = [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }];
    expect(windowState(day, new Date('2026-11-23T08:59:00Z'), 'UTC').active).toBe(false);
    expect(windowState(day, new Date('2026-11-23T09:00:00Z'), 'UTC')).toEqual({ active: true, minutesLeft: 480 });
    expect(windowState(day, new Date('2026-11-22T12:00:00Z'), 'UTC').active).toBe(false); // Sunday
    // In Cairo, 09:00 local is 07:00 UTC.
    expect(windowState(day, new Date('2026-11-23T07:00:00Z'), 'Africa/Cairo').active).toBe(true);
  });
});

describe('product-enforced router schedules', () => {
  it('blocks at the start of a window and lifts only its own block at the end, through the collector', async () => {
    const s = await setup('ps-cycle');
    const laptop = s.devices['192.168.60.20']!;

    // The router cannot schedule; the device card offers a schedule LAN Detective enforces itself.
    const before = await s.a.agent.get(`/api/v1/devices/${laptop}/controls`);
    const rc = before.body.sections.router.routers[0];
    expect(rc.actions.schedule).toMatchObject({ possible: true, mode: 'product', href: `/api/v1/routers/${s.routerId}/schedule` });
    expect(rc.actions.schedule.note).toContain('LAN Detective enforces this schedule itself');
    expect(rc.schedule).toBeNull();

    // Validation: a window needs different start and end; the time zone must exist.
    const same = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: [{ days: [1], start: '10:00', end: '10:00' }], timezone: 'UTC' });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('invalid_window');
    const tz = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: [windowAroundNow()], timezone: 'Mars/Olympus' });
    expect(tz.status).toBe(422);
    expect(tz.body.error.code).toBe('invalid_timezone');

    // Saved inside a window: the block is queued at once.
    const saved = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: [windowAroundNow()], timezone: 'UTC' });
    expect(saved.status).toBe(202);
    expect(saved.body).toMatchObject({ mode: 'product', outcome: 'blocked', schedule: { in_window: true, timezone: 'UTC', blocking: true } });
    const blockCmd = await carryOut(s, 'block');
    expect(blockCmd.payload).toMatchObject({ router_id: s.routerId, mac: LAPTOP_MAC, schedule_id: expect.any(String) });

    // The ledger records the block as LAN Detective's, on behalf of the administrator who set the schedule.
    const detail = await s.a.agent.get(`/api/v1/routers/${s.routerId}`);
    expect(detail.body.blocks[0]).toMatchObject({ mac: LAPTOP_MAC, pre_existing: false, applied_by_email: s.a.email, released_at: null });
    expect(await enforceAt(s.routerId, new Date())).toBe('in_effect');
    expect((await commands(s.c, 'router_block')).length).toBe(0); // never twice for the same edge

    // The window ends: the schedule lifts its own block.
    const later = new Date(Date.now() + 3 * 3600_000);
    expect(await enforceAt(s.routerId, later)).toBe('unblocked');
    await carryOut(s, 'unblock');
    const after = (await s.a.agent.get(`/api/v1/routers/${s.routerId}`)).body.blocks[0];
    expect(after).toMatchObject({ released_via: 'product' });
    expect(await enforceAt(s.routerId, new Date(later.getTime() + 60_000))).toBe('idle');
    expect(await scheduleRow(s.routerId)).toMatchObject({ block_request_id: null, unblock_request_id: null, paused_until: null });

    // Audit: the administrator's change, and each action the schedule took.
    const audits = await withSystem(async (db) =>
      (await db.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'router.schedule%'`, [s.a.organizationId])).rows,
    );
    expect(audits.map((r) => r.action).sort()).toEqual(['router.schedule', 'router.schedule.block', 'router.schedule.unblock']);

    // The device card shows the stored schedule; removing it needs no router request when nothing is blocked.
    const card = (await s.a.agent.get(`/api/v1/devices/${laptop}/controls`)).body.sections.router.routers[0];
    expect(card.schedule).toMatchObject({ mode: 'product', timezone: 'UTC', removing: false });
    const removed = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: null });
    expect(removed.status).toBe(202);
    expect(removed.body).toMatchObject({ mode: 'product', outcome: 'gone', schedule: null });
    expect(await scheduleRow(s.routerId)).toBeNull();
  });

  it('never lifts a block an administrator made, and pauses until the window ends when its block is lifted by hand', async () => {
    const s = await setup('ps-owner');
    const laptop = s.devices['192.168.60.20']!;

    // The administrator blocks the device by hand first.
    const manual = await s.a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({ device_ids: [laptop] });
    expect(manual.body.results[0]).toMatchObject({ status: 'queued' });
    await carryOut(s, 'block');
    const saved = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: [windowAroundNow(30, 30)], timezone: 'UTC' });
    expect(saved.body.outcome).toBe('in_effect');
    // After the window the hand-made block stays.
    expect(await enforceAt(s.routerId, new Date(Date.now() + 2 * 3600_000))).toBe('idle');
    expect((await commands(s.c, 'router_unblock')).length).toBe(0);

    // The administrator lifts their block; the schedule takes over inside the window.
    await s.a.agent.post(`/api/v1/routers/${s.routerId}/unblock`).set(CSRF).send({ device_ids: [laptop] });
    await carryOut(s, 'unblock');
    expect(await enforceAt(s.routerId, new Date())).toBe('blocked');
    await carryOut(s, 'block');

    // Lifted by hand during the window: the schedule does not block again before the window ends.
    const un = await s.a.agent.post(`/api/v1/routers/${s.routerId}/unblock`).set(CSRF).send({ device_ids: [laptop] });
    expect(un.body.results[0]).toMatchObject({ status: 'queued' });
    await carryOut(s, 'unblock');
    expect(await enforceAt(s.routerId, new Date(Date.now() + 61_000))).toBe('paused');
    const row = await scheduleRow(s.routerId);
    expect(row.paused_until).not.toBeNull();
    expect(new Date(row.paused_until).getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect((await commands(s.c, 'router_block')).length).toBe(0);
    // Past the window the pause is over and nothing is blocked.
    expect(await enforceAt(s.routerId, new Date(Date.now() + 2 * 3600_000))).toBe('idle');
    expect((await scheduleRow(s.routerId)).paused_until).toBeNull();
  });

  it('lifts its own block when the schedule is removed during a window, then forgets it', async () => {
    const s = await setup('ps-remove');
    const laptop = s.devices['192.168.60.20']!;
    await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: [windowAroundNow()], timezone: 'UTC' });
    await carryOut(s, 'block');
    const removed = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: null });
    expect(removed.body).toMatchObject({ mode: 'product', outcome: 'unblocked', schedule: { removing: true } });
    await carryOut(s, 'unblock');
    expect(await enforceAt(s.routerId, new Date())).toBe('gone');
    expect(await scheduleRow(s.routerId)).toBeNull();
    const blocks = (await s.a.agent.get(`/api/v1/routers/${s.routerId}`)).body.blocks;
    expect(blocks.every((b: { released_at: string | null }) => b.released_at !== null)).toBe(true);
  });

  it('records a refusal instead of retrying in a loop, and needs the admin role', async () => {
    const s = await setup('ps-refuse');
    const laptop = s.devices['192.168.60.20']!;
    await setRole(s.a.email, s.a.organizationId, 'technician');
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: [windowAroundNow()], timezone: 'UTC' })).status).toBe(403);
    await setRole(s.a.email, s.a.organizationId, 'admin');

    // The router is disabled: the schedule is stored but cannot act; it says why.
    await s.a.agent.patch(`/api/v1/routers/${s.routerId}`).set(CSRF).send({ enabled: false });
    const saved = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: [windowAroundNow()], timezone: 'UTC' });
    expect(saved.status).toBe(202);
    expect(saved.body.outcome).toBe('refused');
    expect(saved.body.schedule.last_error).toContain('disabled');
    expect(await enforceAt(s.routerId, new Date(Date.now() + 10_000))).toBe('refused'); // within the retry pause: no new attempt
    expect((await commands(s.c, 'router_block')).length).toBe(0);
    // Enabled again: the next attempt after the pause blocks.
    await s.a.agent.patch(`/api/v1/routers/${s.routerId}`).set(CSRF).send({ enabled: true });
    expect(await enforceAt(s.routerId, new Date(Date.now() + 61_000))).toBe('blocked');
    expect((await commands(s.c, 'router_block')).length).toBe(1);
  });
});
