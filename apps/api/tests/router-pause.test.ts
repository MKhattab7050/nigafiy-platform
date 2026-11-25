import { describe, expect, it } from 'vitest';
import { withSystem } from '../src/infrastructure/db.ts';
import { runRouterPauses } from '../src/modules/routers/pause-block.ts';
import { CSRF, type TestAccount, type TestCollector, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

// "Pause internet" enforced on the router (migration 049): a pause blocks the device on the site's
// router when one can block, and lifts only that block when the pause ends.

const CAPS = [
  { capability: 'clients', supported: true },
  { capability: 'block', supported: true, mechanism: 'per-device internet blocking' },
];
const PHONE_MAC = 'aa:bb:cc:00:00:31';

interface Setup {
  a: TestAccount;
  c: TestCollector;
  routerId: string;
  phone: string;
}

async function commands(c: TestCollector, kind: string) {
  const hb = await heartbeat(c);
  expect(hb.status).toBe(200);
  return (hb.body.commands as { id: string; kind: string; payload: Record<string, unknown> }[]).filter((x) => x.kind === kind);
}

const result = (routerId: string, fields: Record<string, unknown>) => ({
  type: 'router_result',
  ts: new Date().toISOString(),
  router_id: routerId,
  trigger: 'command',
  duration_ms: 9,
  ...fields,
});

async function setup(label: string, withRouter = true): Promise<Setup> {
  const a = await newAccount(label);
  const scopeId = await addScope(a, '192.168.61.0/24');
  const c = await newCollector(a);
  await heartbeat(c);
  await telemetry(c, [
    sweep(scopeId, [
      { ip: '192.168.61.1', mac: '00:11:22:33:66:01', hostname: 'gateway' },
      { ip: '192.168.61.31', mac: PHONE_MAC, hostname: 'phone' },
    ]),
  ]);
  const list = await a.agent.get('/api/v1/devices?page_size=50');
  const phone = list.body.items.find((d: { current_ip: string }) => d.current_ip === '192.168.61.31').id;
  expect((await a.agent.put('/api/v1/access/settings').set(CSRF).send({ site_id: a.siteId, enabled: true })).status).toBe(200);
  if (!withRouter) return { a, c, routerId: '', phone };
  const created = await a.agent.post('/api/v1/routers').set(CSRF).send({
    site_id: a.siteId,
    name: 'Home router',
    vendor: 'zyxel',
    address: '192.168.61.1',
    transport: 'https',
    credentials: { username: 'admin-user', password: 'router-pass-77' },
  });
  expect(created.status).toBe(201);
  const routerId = created.body.id;
  const q = await a.agent.post(`/api/v1/routers/${routerId}/refresh`).set(CSRF).send({});
  const [refreshCmd] = await commands(c, 'router_refresh');
  await telemetry(c, [
    result(routerId, {
      request_id: q.body.request_id,
      action: 'refresh',
      ok: true,
      capabilities: CAPS,
      clients: [{ mac: PHONE_MAC, ip: '192.168.61.31', hostname: 'phone', connection: 'wifi_5ghz' }],
      blocked: [],
    }),
  ]);
  await heartbeat(c, { completed_commands: [refreshCmd!.id] });
  return { a, c, routerId, phone };
}

async function carryOut(s: Setup, action: 'block' | 'unblock') {
  const [cmd] = await commands(s.c, `router_${action}`);
  expect(cmd, `a router_${action} command`).toBeDefined();
  const change = { action, mac: PHONE_MAC, mechanism: 'per-device internet blocking', applied: true, already_in_effect: false, detail: action, undo: 'Unblock in Nigafiy' };
  const t = await telemetry(s.c, [result(s.routerId, { request_id: cmd!.payload.request_id, action, ok: true, mac: PHONE_MAC, change })]);
  expect(t.body).toMatchObject({ accepted: 1 });
  await heartbeat(s.c, { completed_commands: [cmd!.id] });
  return cmd!;
}

async function accessDevice(s: Setup) {
  const page = await s.a.agent.get(`/api/v1/access?site_id=${s.a.siteId}`);
  expect(page.status).toBe(200);
  return page.body.devices.find((d: { id: string }) => d.id === s.phone);
}

const pauseRow = (routerId: string) =>
  withSystem(async (db) => (await db.query(`SELECT * FROM router_pause_blocks WHERE router_id = $1`, [routerId])).rows[0] ?? null);

describe('internet pause enforced on the router', () => {
  it('blocks the device on the router when paused and lifts that block on resume', async () => {
    const s = await setup('rp-cycle');

    const paused = await s.a.agent.post(`/api/v1/devices/${s.phone}/pause`).set(CSRF).send({ minutes: 60 });
    expect(paused.status).toBe(200);
    expect((await accessDevice(s)).router_pause).toEqual({ pending: true, error: null });

    const cmd = await carryOut(s, 'block');
    expect(cmd.payload).toMatchObject({ router_id: s.routerId, mac: PHONE_MAC, pause: true });
    const d = await accessDevice(s);
    expect(d).toMatchObject({ internet_off: 'paused', router_blocked: true, enforcement_mode: 'router_only', router_pause: { pending: false, error: null } });
    const detail = await s.a.agent.get(`/api/v1/routers/${s.routerId}`);
    expect(detail.body.blocks[0]).toMatchObject({ mac: PHONE_MAC, pre_existing: false, applied_by_email: s.a.email, released_at: null });

    // The job leaves an in-effect block alone (never twice).
    await runRouterPauses();
    expect((await commands(s.c, 'router_block')).length).toBe(0);

    // Resume: the pause's own block is lifted at once, then the row is forgotten.
    expect((await s.a.agent.post(`/api/v1/devices/${s.phone}/pause`).set(CSRF).send({ minutes: null })).status).toBe(200);
    await carryOut(s, 'unblock');
    await runRouterPauses();
    expect(await pauseRow(s.routerId)).toBeNull();
    const after = await accessDevice(s);
    expect(after).toMatchObject({ internet_off: null, router_blocked: false, router_pause: null });

    const audits = await withSystem(async (db) =>
      (await db.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'router.pause%'`, [s.a.organizationId])).rows,
    );
    expect(audits.map((r) => r.action).sort()).toEqual(['router.pause.block', 'router.pause.unblock']);
  });

  it('lifts the block when the pause runs out, through the job', async () => {
    const s = await setup('rp-expiry');
    await s.a.agent.post(`/api/v1/devices/${s.phone}/pause`).set(CSRF).send({ minutes: 1 });
    await carryOut(s, 'block');
    await runRouterPauses(new Date(Date.now() + 2 * 60_000));
    await carryOut(s, 'unblock');
    await runRouterPauses(new Date(Date.now() + 3 * 60_000));
    expect(await pauseRow(s.routerId)).toBeNull();
  });

  it('never lifts a block an administrator made, and respects a hand-made unblock until the pause ends', async () => {
    const s = await setup('rp-owner');
    // A hand-made block first: the pause leaves it alone, before and after.
    await s.a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({ device_ids: [s.phone] });
    await carryOut(s, 'block');
    await s.a.agent.post(`/api/v1/devices/${s.phone}/pause`).set(CSRF).send({ minutes: 30 });
    expect((await commands(s.c, 'router_block')).length).toBe(0);
    await s.a.agent.post(`/api/v1/devices/${s.phone}/pause`).set(CSRF).send({ minutes: null });
    expect((await commands(s.c, 'router_unblock')).length).toBe(0);
    await s.a.agent.post(`/api/v1/routers/${s.routerId}/unblock`).set(CSRF).send({ device_ids: [s.phone] });
    await carryOut(s, 'unblock');

    // The pause's own block, lifted by hand during the pause: not blocked again until it ends.
    await s.a.agent.post(`/api/v1/devices/${s.phone}/pause`).set(CSRF).send({ minutes: 30 });
    await carryOut(s, 'block');
    await s.a.agent.post(`/api/v1/routers/${s.routerId}/unblock`).set(CSRF).send({ device_ids: [s.phone] });
    await carryOut(s, 'unblock');
    await runRouterPauses(new Date(Date.now() + 61_000));
    await runRouterPauses(new Date(Date.now() + 2 * 61_000));
    expect((await commands(s.c, 'router_block')).length).toBe(0);
    expect((await pauseRow(s.routerId)).overridden_until).not.toBeNull();
  });

  it('pauses a whole profile on the router, and lets a technician pause', async () => {
    const s = await setup('rp-profile');
    const p = await s.a.agent.post(`/api/v1/access/profiles?site_id=${s.a.siteId}`).set(CSRF).send({ name: 'Kids' });
    expect(p.status).toBe(201);
    expect((await s.a.agent.patch(`/api/v1/devices/${s.phone}/access`).set(CSRF).send({ profile_id: p.body.id })).status).toBe(200);
    await setRole(s.a.email, s.a.organizationId, 'technician');
    expect((await s.a.agent.post(`/api/v1/access/profiles/${p.body.id}/pause`).set(CSRF).send({ minutes: 30 })).status).toBe(200);
    await carryOut(s, 'block');
    expect((await accessDevice(s)).router_blocked).toBe(true);
  });

  it('keeps the DNS pause and says nothing enforces it when there is no router', async () => {
    const s = await setup('rp-none', false);
    expect((await s.a.agent.post(`/api/v1/devices/${s.phone}/pause`).set(CSRF).send({ minutes: 30 })).status).toBe(200);
    expect(await accessDevice(s)).toMatchObject({ internet_off: 'paused', enforcement_mode: 'unprotected', router_pause: null });
  });
});
