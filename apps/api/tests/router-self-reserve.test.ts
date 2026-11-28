import { afterEach, describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { selfReservationStatus, setOwnAdapterSource } from '../src/modules/routers/self-reserve.ts';
import { CSRF, type TestAccount, type TestCollector, addScope, heartbeat, newAccount, newCollector, sweep, telemetry } from './helpers.ts';

// The computer running Nigafiy keeps its address at home (automation router.reserve_own_address).

const CAPS = [
  { capability: 'clients', supported: true },
  { capability: 'block', supported: true },
  { capability: 'reservations', supported: true },
];

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };

interface Setup {
  a: TestAccount;
  c: TestCollector;
  routerId: string;
}

function result(routerId: string, fields: Record<string, unknown>) {
  return { type: 'router_result', ts: new Date().toISOString(), router_id: routerId, trigger: 'scheduled', duration_ms: 12, ...fields };
}

async function reserveCommands(c: TestCollector): Promise<Cmd[]> {
  const hb = await heartbeat(c);
  expect(hb.status).toBe(200);
  return (hb.body.commands as Cmd[]).filter((x) => x.payload?.ip !== undefined && x.kind.startsWith('router'));
}

async function setup(label: string, caps = CAPS): Promise<Setup> {
  const a = await newAccount(label);
  const scopeId = await addScope(a, '192.168.60.0/24');
  const c = await newCollector(a);
  await heartbeat(c);
  await telemetry(c, [sweep(scopeId, [{ ip: '192.168.60.1', mac: '00:11:22:33:44:01', hostname: 'gateway' }])]);
  const created = await a.agent
    .post('/api/v1/routers')
    .set(CSRF)
    .send({ site_id: a.siteId, name: 'Home router', vendor: 'zyxel', address: '192.168.60.1', transport: 'https', credentials: { username: 'u', password: 'router-pass-9z' } });
  expect(created.status).toBe(201);
  return { a, c, routerId: created.body.id };
}

async function read(s: Setup, reservations: unknown[], extra: Record<string, unknown> = {}) {
  const t = await telemetry(s.c, [
    result(s.routerId, {
      action: 'refresh',
      ok: true,
      capabilities: CAPS,
      clients: [{ mac: 'aa:bb:cc:00:00:30', ip: '192.168.60.30', hostname: 'tv', connection: 'ethernet' }],
      settings: { overview: { lan_ip: '192.168.60.1' }, reservations },
      ...extra,
    }),
  ]);
  expect(t.body).toMatchObject({ accepted: 1 });
}

const own = (s: Setup) => s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`).then((r) => r.body.own_computer);

afterEach(() => setOwnAdapterSource(null));

describe('this computer keeps its address on the router', () => {
  it('reserves each adapter on the router LAN once, after the first read, on behalf of who added the router', async () => {
    setOwnAdapterSource(() => [
      { mac: 'de:ad:be:ef:00:01', ip: '192.168.60.38' }, // Wi-Fi
      { mac: 'de:ad:be:ef:00:02', ip: '192.168.60.47' }, // cable
      { mac: 'de:ad:be:ef:00:03', ip: '10.9.9.9' }, // another network: not this router's
    ]);
    const s = await setup('self-res');
    await read(s, []);
    const queued = await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`);
    const pending = queued.body.pending.filter((p: any) => p.action === 'reserve');
    expect(pending.map((p: any) => [p.mac, p.params.ip]).sort()).toEqual([
      ['de:ad:be:ef:00:01', '192.168.60.38'],
      ['de:ad:be:ef:00:02', '192.168.60.47'],
    ]);
    expect(pending[0].created_by_email).toBe(s.a.email);
    expect(await own(s)).toEqual(
      expect.arrayContaining([
        { mac: 'de:ad:be:ef:00:01', ip: '192.168.60.38', status: 'pending', code: null },
        { mac: 'de:ad:be:ef:00:02', ip: '192.168.60.47', status: 'pending', code: null },
      ]),
    );
    const audits = await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'router.reserve'`, [s.a.organizationId]);
    expect(audits.rows.map((x) => x.metadata.automation)).toEqual(['router.reserve_own_address', 'router.reserve_own_address']);

    // The collector does it; the router's list now has both.
    const done = [
      { id: '1', mac: 'DE:AD:BE:EF:00:01', ip: '192.168.60.38', enabled: true },
      { id: '2', mac: 'de:ad:be:ef:00:02', ip: '192.168.60.47', enabled: true },
    ];
    for (const p of pending) {
      const t = await telemetry(s.c, [result(s.routerId, { request_id: p.id, action: 'reserve', trigger: 'command', ok: true, settings: { reservations: done } })]);
      expect(t.body).toMatchObject({ accepted: 1 });
    }
    await read(s, done);
    expect((await own(s)).map((o: any) => o.status)).toEqual(['reserved', 'reserved']);

    // Removed by hand later: never put back.
    await read(s, []);
    const again = (await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`)).body;
    expect(again.pending.filter((p: any) => p.action === 'reserve')).toEqual([]);
    expect(again.own_computer.map((o: any) => o.status)).toEqual(['removed', 'removed']);
  });

  it('leaves an existing reservation and an address taken by another device alone', async () => {
    setOwnAdapterSource(() => [
      { mac: 'de:ad:be:ef:00:11', ip: '192.168.60.40' }, // already reserved for this computer, elsewhere
      { mac: 'de:ad:be:ef:00:12', ip: '192.168.60.41' }, // reserved for someone else
      { mac: 'de:ad:be:ef:00:13', ip: '192.168.60.30' }, // the TV has it now
    ]);
    const s = await setup('self-res-keep');
    await read(s, [
      { id: '1', mac: 'de:ad:be:ef:00:11', ip: '192.168.60.99', enabled: true },
      { id: '2', mac: 'aa:bb:cc:00:00:41', ip: '192.168.60.41', enabled: true },
    ]);
    const body = (await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`)).body;
    expect(body.pending.filter((p: any) => p.action === 'reserve')).toEqual([]);
    const byMac = Object.fromEntries(body.own_computer.map((o: any) => [o.mac, o]));
    expect(byMac['de:ad:be:ef:00:11']).toMatchObject({ ip: '192.168.60.99', status: 'reserved' });
    expect(byMac['de:ad:be:ef:00:12']).toMatchObject({ status: 'conflict', code: 'ip_reserved' });
    expect(byMac['de:ad:be:ef:00:13']).toMatchObject({ status: 'conflict', code: 'ip_in_use' });
  });

  it('does nothing when switched off, or when the router cannot reserve', async () => {
    setOwnAdapterSource(() => [{ mac: 'de:ad:be:ef:00:21', ip: '192.168.60.50' }]);
    const off = await setup('self-res-off');
    const put = await off.a.agent.put('/api/v1/automation/router.reserve_own_address').set(CSRF).send({ enabled: false });
    expect(put.status).toBe(200);
    await read(off, []);
    expect((await off.a.agent.get(`/api/v1/routers/${off.routerId}/settings`)).body.pending).toEqual([]);

    const noCap = await setup('self-res-nocap');
    await telemetry(noCap.c, [
      result(noCap.routerId, {
        action: 'refresh',
        ok: true,
        capabilities: [{ capability: 'clients', supported: true }, { capability: 'reservations', supported: false, note: 'n/a' }],
        settings: { reservations: [] },
      }),
    ]);
    expect((await noCap.a.agent.get(`/api/v1/routers/${noCap.routerId}/settings`)).body.pending).toEqual([]);
  });

  it('tells a failed request from one removed by hand', () => {
    const done = {
      'de:ad:be:ef:00:31': { ip: '192.168.60.31', state: 'requested' as const, code: null, request_id: 'r1', at: '2026-11-28T00:00:00Z' },
      'de:ad:be:ef:00:32': { ip: '192.168.60.32', state: 'requested' as const, code: null, request_id: 'r2', at: '2026-11-28T00:00:00Z' },
    };
    const st = selfReservationStatus(done, [], new Map([['r1', 'failed'], ['r2', 'completed']]));
    expect(st.map((x) => x.status)).toEqual(['failed', 'removed']);
  });
});
