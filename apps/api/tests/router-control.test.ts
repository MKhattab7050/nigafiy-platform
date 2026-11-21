import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, type TestAccount, type TestCollector, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

const PASSWORD = 'router-Admin-Secret-91';
const USERNAME = 'netadmin-user';
const PIN = 'B6:F9:AB:5E:DF:D6:B4:A4:0D:C0:79:2B:B7:4E:3F:3B:19:A2:AA:AC:43:6B:AE:B3:63:EE:16:3C:BC:23:76:D1';

const CAPS = [
  { capability: 'clients', supported: true, mechanism: 'DAL lanhosts' },
  { capability: 'dhcp_leases', supported: true },
  { capability: 'block', supported: true, mechanism: 'per-device internet blocking', note: 'blocks internet access for the device' },
  { capability: 'rate_limit', supported: false, note: 'not offered: the firmware only has global QoS classes' },
  { capability: 'schedule', supported: false, note: 'not offered: schedules exist only as parental-control profiles' },
];

interface Setup {
  a: TestAccount;
  c: TestCollector;
  scopeId: string;
  routerId: string;
  devices: Record<string, string>; // ip → device id
}

async function command(c: TestCollector, kind: string) {
  const hb = await heartbeat(c);
  expect(hb.status).toBe(200);
  return (hb.body.commands as { id: string; kind: string; payload: Record<string, unknown> }[]).filter((x) => x.kind === kind);
}

function result(routerId: string, fields: Record<string, unknown>) {
  return { type: 'router_result', ts: new Date().toISOString(), router_id: routerId, trigger: 'command', duration_ms: 12, ...fields };
}

/** An account with a scope, an online collector, three discovered devices and one router (https, ready). */
async function setup(label: string, transport = 'https'): Promise<Setup> {
  const a = await newAccount(label);
  const scopeId = await addScope(a, '192.168.50.0/24');
  const c = await newCollector(a);
  await heartbeat(c);
  const sw = await telemetry(c, [
    sweep(scopeId, [
      { ip: '192.168.50.1', mac: '00:11:22:33:44:01', hostname: 'gateway' },
      { ip: '192.168.50.20', mac: 'aa:bb:cc:00:00:20', hostname: 'laptop' },
      { ip: '192.168.50.21', mac: 'aa:bb:cc:00:00:21', hostname: 'phone' },
      { ip: '192.168.50.22', hostname: 'no-mac-thing' },
    ]),
  ]);
  expect(sw.status).toBe(200);
  const list = await a.agent.get('/api/v1/devices?page_size=50');
  const devices: Record<string, string> = {};
  for (const d of list.body.items) devices[d.current_ip] = d.id;
  const created = await a.agent.post('/api/v1/routers').set(CSRF).send({
    site_id: a.siteId,
    name: 'Main gateway',
    vendor: 'zyxel',
    address: '192.168.50.1',
    transport,
    credentials: { username: USERNAME, password: PASSWORD },
  });
  expect(created.status).toBe(201);
  return { a, c, scopeId, routerId: created.body.id, devices };
}

/** Refresh through the real command path with a client list and the blocks in effect. */
async function refresh(s: Setup, blocked: { mac: string; owner: string; managed: boolean }[] = []) {
  const q = await s.a.agent.post(`/api/v1/routers/${s.routerId}/refresh`).set(CSRF).send({});
  expect(q.status).toBe(202);
  const [cmd] = await command(s.c, 'router_refresh');
  expect(cmd!.payload).toEqual({ request_id: q.body.request_id, router_id: s.routerId });
  const t = await telemetry(s.c, [
    result(s.routerId, {
      request_id: q.body.request_id,
      action: 'refresh',
      ok: true,
      identity: { vendor: 'Zyxel', model: 'VMG3625-T50B', firmware: 'V5.50' },
      capabilities: CAPS,
      clients: [
        { mac: 'aa:bb:cc:00:00:20', ip: '192.168.50.20', hostname: 'laptop', connection: 'wifi_5ghz', signal_dbm: -51, raw: { HostName: 'laptop' } },
        { mac: 'aa:bb:cc:00:00:21', ip: '192.168.50.21', connection: 'wired', blocked: blocked.some((b) => b.mac === 'aa:bb:cc:00:00:21') },
      ],
      blocked: blocked.map((b) => ({ ...b, mechanism: 'per-device internet blocking' })),
    }),
  ]);
  expect(t.body).toMatchObject({ accepted: 1 });
  return q.body.request_id as string;
}

describe('router control', () => {
  it('enforces roles, authorized scope, tenant isolation and never reveals credentials', async () => {
    const s = await setup('rc-roles');
    const { a } = s;
    // Address must be inside an authorized scope of the site (and therefore private).
    const outside = await a.agent.post('/api/v1/routers').set(CSRF).send({ site_id: a.siteId, name: 'x', vendor: 'zyxel', address: '10.9.9.1', credentials: { username: 'u', password: 'p' } });
    expect(outside.status).toBe(422);
    expect(outside.body.error.code).toBe('not_in_scope');
    const pub = await a.agent.post('/api/v1/routers').set(CSRF).send({ site_id: a.siteId, name: 'x', vendor: 'zyxel', address: '8.8.8.8', credentials: { username: 'u', password: 'p' } });
    expect(pub.status).toBe(422);

    // Credentials never come back: list, detail, update.
    const list = await a.agent.get('/api/v1/routers');
    const detail = await a.agent.get(`/api/v1/routers/${s.routerId}`);
    const patched = await a.agent.patch(`/api/v1/routers/${s.routerId}`).set(CSRF).send({ credentials: { username: USERNAME, password: `${PASSWORD}-2` } });
    expect(patched.status).toBe(200);
    for (const body of [list.body, detail.body, patched.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(USERNAME);
      expect(text).not.toContain('secret_enc');
    }
    expect(detail.body.credentials.set).toBe(true);
    // …nor in the audit trail.
    const auditRows = await systemPool.query(`SELECT action, metadata::text AS m FROM audit_logs WHERE organization_id = $1 AND action LIKE 'router.%'`, [a.organizationId]);
    expect(auditRows.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['router.add', 'router.update']));
    for (const r of auditRows.rows) {
      expect(r.m).not.toContain(PASSWORD);
      expect(r.m).not.toContain(USERNAME);
    }
    // …nor at rest in clear text.
    const stored = await systemPool.query(`SELECT secret_enc FROM site_routers WHERE id = $1`, [s.routerId]);
    expect(stored.rows[0].secret_enc).not.toContain(PASSWORD);

    // Only the site's own collector receives them, in its heartbeat configuration.
    const hb = await heartbeat(s.c);
    expect(hb.body.config.routers.targets).toEqual([
      expect.objectContaining({ id: s.routerId, vendor: 'zyxel', address: '192.168.50.1', transport: 'https', username: USERNAME, password: `${PASSWORD}-2` }),
    ]);
    const other = await setup('rc-other');
    const hbOther = await heartbeat(other.c);
    expect(JSON.stringify(hbOther.body.config.routers)).not.toContain(`${PASSWORD}-2`);
    expect(JSON.stringify(hbOther.body.config.routers)).not.toContain(s.routerId);
    expect(hbOther.body.config.routers.targets.map((t: { id: string }) => t.id)).toEqual([other.routerId]);

    // Tenant isolation.
    expect((await other.a.agent.get(`/api/v1/routers/${s.routerId}`)).status).toBe(404);
    expect((await other.a.agent.get('/api/v1/routers')).body.items.map((r: { id: string }) => r.id)).toEqual([other.routerId]);
    expect((await other.a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({ device_ids: [s.devices['192.168.50.20']] })).status).toBe(404);
    expect((await other.a.agent.get(`/api/v1/devices/${s.devices['192.168.50.20']}/controls`)).status).toBe(404);
    // A collector cannot report results for another tenant's router.
    const forged = await telemetry(other.c, [result(s.routerId, { action: 'refresh', trigger: 'scheduled', ok: true, capabilities: CAPS })]);
    expect(forged.body.rejected).toHaveLength(1);

    // Roles: viewers read, technicians refresh, only admins configure and block.
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get('/api/v1/routers')).status).toBe(200);
    expect((await a.agent.post(`/api/v1/routers/${s.routerId}/refresh`).set(CSRF).send({})).status).toBe(403);
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.post(`/api/v1/routers/${s.routerId}/refresh`).set(CSRF).send({})).status).toBe(202);
    expect((await a.agent.patch(`/api/v1/routers/${s.routerId}`).set(CSRF).send({ name: 'x' })).status).toBe(403);
    expect((await a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({ device_ids: [s.devices['192.168.50.20']] })).status).toBe(403);
    expect((await a.agent.post(`/api/v1/routers/${s.routerId}/certificate/fetch`).set(CSRF).send({})).status).toBe(403);
    expect((await a.agent.delete(`/api/v1/routers/${s.routerId}`).set(CSRF)).status).toBe(403);
    await setRole(a.email, a.organizationId, 'admin');
  });

  it('trusts a certificate only after the administrator confirms the fingerprint the collector saw', async () => {
    const s = await setup('rc-tofu', 'https-pinned');
    // No pin yet: the router is not delivered to the collector, and control is refused.
    let hb = await heartbeat(s.c);
    expect(hb.body.config.routers.targets).toEqual([]);
    expect((await s.a.agent.get(`/api/v1/routers/${s.routerId}`)).body.delivery).toBe('awaiting_certificate');
    const early = await s.a.agent.post(`/api/v1/routers/${s.routerId}/refresh`).set(CSRF).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('router_awaiting_certificate');
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/certificate/trust`).set(CSRF).send({ sha256: PIN })).body.error.code).toBe('no_certificate');

    const fetch = await s.a.agent.post(`/api/v1/routers/${s.routerId}/certificate/fetch`).set(CSRF).send({});
    expect(fetch.status).toBe(202);
    const [cmd] = await command(s.c, 'router_fetch_certificate');
    expect(cmd!.payload).toEqual({ request_id: fetch.body.request_id, router_id: s.routerId, address: '192.168.50.1', port: 443 });
    const cert = {
      sha256: PIN,
      subject: 'CN=VMG3625-T50B',
      issuer: 'CN=VMG3625-T50B',
      not_before: '2019-01-01T00:00:00Z',
      not_after: '2021-01-01T00:00:00Z',
      self_signed: true,
      expired: true,
      system_trust: false,
    };
    await telemetry(s.c, [result(s.routerId, { request_id: fetch.body.request_id, action: 'fetch_certificate', ok: true, certificate: cert })]);
    const detail = await s.a.agent.get(`/api/v1/routers/${s.routerId}`);
    expect(detail.body.certificate.fetched).toMatchObject({ sha256: PIN, expired: true, self_signed: true });
    expect(detail.body.certificate.pinned).toBeNull();
    expect((await s.a.agent.get(`/api/v1/router-requests/${fetch.body.request_id}`)).body.status).toBe('completed');
    // Still not trusted automatically.
    hb = await heartbeat(s.c);
    expect(hb.body.config.routers.targets).toEqual([]);

    const wrong = await s.a.agent.post(`/api/v1/routers/${s.routerId}/certificate/trust`).set(CSRF).send({ sha256: PIN.replace('B6', 'B7') });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('fingerprint_mismatch');
    const ok = await s.a.agent.post(`/api/v1/routers/${s.routerId}/certificate/trust`).set(CSRF).send({ sha256: PIN.replaceAll(':', '').toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ transport: 'https-pinned', pin_sha256: PIN, delivery: 'active' });
    hb = await heartbeat(s.c);
    expect(hb.body.config.routers.targets).toEqual([expect.objectContaining({ id: s.routerId, transport: 'https-pinned', pin_sha256: PIN })]);
  });

  it('blocks and unblocks through the collector, keeps a ledger and never claims a pre-existing block', async () => {
    const s = await setup('rc-block');
    const laptop = s.devices['192.168.50.20']!;
    const phone = s.devices['192.168.50.21']!;
    // Before a refresh nothing is known about what the router supports.
    const unknown = await s.a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({ device_ids: [laptop] });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.code).toBe('capabilities_unknown');

    // The phone is already blocked on the router by the administrator.
    await refresh(s, [{ mac: 'aa:bb:cc:00:00:21', owner: 'unknown', managed: true }]);
    const clients = await s.a.agent.get(`/api/v1/routers/${s.routerId}/clients`);
    expect(clients.body.items).toHaveLength(2);
    expect(clients.body.items[0]).toMatchObject({ mac: 'aa:bb:cc:00:00:20', device_id: laptop, device_link: 'inferred_by_mac', signal_dbm: -51 });

    const bulk = await s.a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({
      device_ids: [laptop, phone, s.devices['192.168.50.1'], s.devices['192.168.50.22'], randomUUID()],
    });
    expect(bulk.status).toBe(202);
    const byId = Object.fromEntries(bulk.body.results.map((r: { device_id: string }) => [r.device_id, r]));
    expect(byId[laptop]).toMatchObject({ status: 'queued' });
    expect(byId[phone]).toMatchObject({ status: 'queued' }); // the product does not know yet; the router will tell
    expect(byId[s.devices['192.168.50.1']!]).toMatchObject({ status: 'refused', code: 'gateway' });
    expect(byId[s.devices['192.168.50.22']!]).toMatchObject({ status: 'refused', code: 'no_mac' });
    expect(bulk.body.queued).toBe(2);

    const cmds = await command(s.c, 'router_block');
    expect(cmds.map((c) => c.payload.mac).sort()).toEqual(['aa:bb:cc:00:00:20', 'aa:bb:cc:00:00:21']);
    const reqFor = (mac: string) => cmds.find((c) => c.payload.mac === mac)!.payload.request_id;
    const change = (mac: string, already: boolean) => ({
      action: 'block',
      mac,
      mechanism: 'per-device internet blocking',
      applied: !already,
      already_in_effect: already,
      detail: already ? 'already blocked' : 'internet blocked',
      undo: 'Unblock in LAN Detective, or switch Internet Blocking off on the router',
    });
    const t = await telemetry(s.c, [
      result(s.routerId, { request_id: reqFor('aa:bb:cc:00:00:20'), action: 'block', ok: true, mac: 'aa:bb:cc:00:00:20', change: change('aa:bb:cc:00:00:20', false) }),
      result(s.routerId, { request_id: reqFor('aa:bb:cc:00:00:21'), action: 'block', ok: true, mac: 'aa:bb:cc:00:00:21', change: change('aa:bb:cc:00:00:21', true) }),
    ]);
    expect(t.body).toMatchObject({ accepted: 2 });

    const ledger = (await s.a.agent.get(`/api/v1/routers/${s.routerId}`)).body.blocks;
    const laptopRow = ledger.find((b: { mac: string }) => b.mac === 'aa:bb:cc:00:00:20');
    const phoneRow = ledger.find((b: { mac: string }) => b.mac === 'aa:bb:cc:00:00:21');
    expect(laptopRow).toMatchObject({ pre_existing: false, applied_by_email: s.a.email, released_at: null });
    expect(phoneRow).toMatchObject({ pre_existing: true, applied_by_email: null });

    // The administrator's block is read-only for the product.
    const unPhone = await s.a.agent.post(`/api/v1/routers/${s.routerId}/unblock`).set(CSRF).send({ device_ids: [phone] });
    expect(unPhone.body.results[0]).toMatchObject({ status: 'refused', code: 'not_applied_by_product' });
    const again = await s.a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({ device_ids: [laptop] });
    expect(again.body.results[0]).toMatchObject({ status: 'refused', code: 'already_blocked' });

    const controls = await s.a.agent.get(`/api/v1/devices/${laptop}/controls`);
    const rc = controls.body.sections.router.routers[0];
    expect(rc.block_state).toMatchObject({ state: 'blocked', by: 'lan-detective', applied_by_email: s.a.email });
    expect(rc.actions.unblock.possible).toBe(true);
    const phoneControls = await s.a.agent.get(`/api/v1/devices/${phone}/controls`);
    expect(phoneControls.body.sections.router.routers[0].block_state.by).toBe('administrator');
    expect(phoneControls.body.sections.router.routers[0].actions.unblock).toMatchObject({ possible: false, reason: 'blocked_by_administrator' });

    const un = await s.a.agent.post(`/api/v1/routers/${s.routerId}/unblock`).set(CSRF).send({ device_ids: [laptop] });
    expect(un.body.results[0]).toMatchObject({ status: 'queued' });
    const [ucmd] = await command(s.c, 'router_unblock');
    await telemetry(s.c, [
      result(s.routerId, {
        request_id: ucmd!.payload.request_id,
        action: 'unblock',
        ok: true,
        mac: 'aa:bb:cc:00:00:20',
        change: { ...change('aa:bb:cc:00:00:20', false), action: 'unblock', detail: 'internet allowed' },
      }),
    ]);
    const after = (await s.a.agent.get(`/api/v1/routers/${s.routerId}`)).body.blocks.find((b: { mac: string; released_at: string | null }) => b.mac === 'aa:bb:cc:00:00:20');
    expect(after).toMatchObject({ released_via: 'product', released_by_email: s.a.email });
    expect(after.released_at).not.toBeNull();

    const events = await s.a.agent.get('/api/v1/events?page_size=100');
    const types = events.body.items.map((e: { type: string }) => e.type);
    expect(types.filter((x: string) => x === 'device_blocked')).toHaveLength(1);
    expect(types.filter((x: string) => x === 'device_unblocked')).toHaveLength(1);
    const audits = await systemPool.query(`SELECT action, user_email FROM audit_logs WHERE organization_id = $1 AND action IN ('router.block','router.unblock')`, [s.a.organizationId]);
    expect(audits.rows.map((r) => r.action).sort()).toEqual(['router.block', 'router.block', 'router.unblock']);
    expect(audits.rows.every((r) => r.user_email === s.a.email)).toBe(true);
  });

  it('refuses to block the collector host and passes through rate limit/schedule only when supported', async () => {
    const s = await setup('rc-guard');
    await refresh(s);
    // The collector host reports itself from its own interface.
    await telemetry(s.c, [
      {
        ...sweep(s.scopeId, []),
        hosts: [{ ip: '192.168.50.30', mac: 'aa:bb:cc:00:00:30', sources: ['local_interface'] }],
      },
    ]);
    const list = await s.a.agent.get('/api/v1/devices?q=192.168.50.30');
    const host = list.body.items[0].id;
    const r = await s.a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({ device_ids: [host] });
    expect(r.body.results[0]).toMatchObject({ status: 'refused', code: 'collector_host' });

    const laptop = s.devices['192.168.50.20']!;
    const rl = await s.a.agent.post(`/api/v1/routers/${s.routerId}/rate-limit`).set(CSRF).send({ device_id: laptop, limit: { down_kbps: 2000, up_kbps: 500 } });
    expect(rl.status).toBe(409);
    expect(rl.body.error.code).toBe('unsupported_on_router');
    expect(rl.body.error.details.note).toContain('global QoS');
    // A router that can block but not schedule: LAN Detective stores the schedule and enforces it with the block
    // (tests/router-product-schedule.test.ts); nothing is sent to the router as a schedule.
    const sc = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: [{ days: [1, 2], start: '22:00', end: '06:00' }] });
    expect(sc.status).toBe(202);
    expect(sc.body).toMatchObject({ mode: 'product', schedule: { timezone: 'UTC' } });
    expect((await command(s.c, 'router_schedule')).length).toBe(0);
    const scOff = await s.a.agent.post(`/api/v1/routers/${s.routerId}/schedule`).set(CSRF).send({ device_id: laptop, windows: null });
    expect(scOff.status).toBe(202);
    expect((await command(s.c, 'router_rate_limit')).length).toBe(0);

    // A driver that does support it: the request passes through to the collector.
    await systemPool.query(`UPDATE site_routers SET capabilities = jsonb_set(capabilities, '{3}', '{"capability":"rate_limit","supported":true}') WHERE id = $1`, [s.routerId]);
    const ok = await s.a.agent.post(`/api/v1/routers/${s.routerId}/rate-limit`).set(CSRF).send({ device_id: laptop, limit: { down_kbps: 2000, up_kbps: 500 } });
    expect(ok.status).toBe(202);
    const [cmd] = await command(s.c, 'router_rate_limit');
    expect(cmd!.payload).toMatchObject({ router_id: s.routerId, mac: 'aa:bb:cc:00:00:20', limit: { down_kbps: 2000, up_kbps: 500 } });
    const clear = await s.a.agent.post(`/api/v1/routers/${s.routerId}/rate-limit`).set(CSRF).send({ device_id: laptop, limit: null });
    expect(clear.status).toBe(202);
    const cmds = await command(s.c, 'router_rate_limit');
    expect(cmds.find((x) => x.payload.request_id === clear.body.request_id)!.payload.clear).toBe(true);
  });

  it('stops logging in after rejected credentials or a lock-out, with one event, until credentials change', async () => {
    const s = await setup('rc-lockout');
    await refresh(s);
    // Scheduled refresh: the router rejects the password.
    const bad = await telemetry(s.c, [
      result(s.routerId, { action: 'refresh', trigger: 'scheduled', ok: false, error: { kind: 'bad_credentials', message: 'login: the router rejected the user name or password' } }),
    ]);
    expect(bad.body).toMatchObject({ accepted: 1 });
    let detail = (await s.a.agent.get(`/api/v1/routers/${s.routerId}`)).body;
    expect(detail).toMatchObject({ status: 'login_failed', login_paused: true, login_paused_reason: 'bad_credentials', delivery: 'login_paused' });
    // Left out of the collector configuration: no further login attempts.
    expect((await heartbeat(s.c)).body.config.routers.targets).toEqual([]);
    const refused = await s.a.agent.post(`/api/v1/routers/${s.routerId}/refresh`).set(CSRF).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('router_login_paused');
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/block`).set(CSRF).send({ device_ids: [s.devices['192.168.50.20']] })).body.error.code).toBe('router_login_paused');
    // The collector's own guard reports later attempts as suspended: no second event.
    await telemetry(s.c, [result(s.routerId, { action: 'refresh', trigger: 'scheduled', ok: false, error: { kind: 'login_suspended', message: 'logins paused' } })]);
    let events = (await s.a.agent.get('/api/v1/events?page_size=100')).body.items.map((e: { type: string }) => e.type);
    expect(events.filter((x: string) => x === 'router_login_failed')).toHaveLength(1);

    // New credentials lift the pause.
    await s.a.agent.patch(`/api/v1/routers/${s.routerId}`).set(CSRF).send({ credentials: { username: USERNAME, password: 'new-password-1' } });
    expect((await heartbeat(s.c)).body.config.routers.targets).toHaveLength(1);

    // A lock-out pauses logins for the router's stated wait.
    await telemetry(s.c, [
      result(s.routerId, { action: 'refresh', trigger: 'scheduled', ok: false, error: { kind: 'locked_out', message: 'login: locked', retry_after_seconds: 600 } }),
    ]);
    detail = (await s.a.agent.get(`/api/v1/routers/${s.routerId}`)).body;
    expect(detail).toMatchObject({ status: 'locked_out', login_paused: true, login_paused_reason: 'locked_out' });
    const until = new Date(detail.login_paused_until).getTime();
    expect(until).toBeGreaterThan(Date.now() + 500_000);
    expect((await heartbeat(s.c)).body.config.routers.targets).toEqual([]);
    events = (await s.a.agent.get('/api/v1/events?page_size=100')).body.items.map((e: { type: string }) => e.type);
    expect(events.filter((x: string) => x === 'router_login_failed')).toHaveLength(1); // still in a login-failure state: not repeated
    // Once the wait has passed it is delivered again.
    await systemPool.query(`UPDATE site_routers SET login_paused_until = now() - interval '1 second' WHERE id = $1`, [s.routerId]);
    expect((await heartbeat(s.c)).body.config.routers.targets).toHaveLength(1);
    // Recovery closes the state with one event.
    await telemetry(s.c, [result(s.routerId, { action: 'refresh', trigger: 'scheduled', ok: true, capabilities: CAPS })]);
    events = (await s.a.agent.get('/api/v1/events?page_size=100')).body.items.map((e: { type: string }) => e.type);
    expect(events.filter((x: string) => x === 'router_reachable')).toHaveLength(1);
    // Unreachable opens once, not on every poll.
    for (let i = 0; i < 3; i++) {
      await telemetry(s.c, [result(s.routerId, { action: 'refresh', trigger: 'scheduled', ok: false, error: { kind: 'unreachable', message: 'tls: connection refused' } })]);
    }
    events = (await s.a.agent.get('/api/v1/events?page_size=100')).body.items.map((e: { type: string }) => e.type);
    expect(events.filter((x: string) => x === 'router_unreachable')).toHaveLength(1);
  });

  it('describes every control of a device in one response, isolating a failing section', async () => {
    const s = await setup('rc-controls');
    await refresh(s);
    const laptop = s.devices['192.168.50.20']!;
    const res = await s.a.agent.get(`/api/v1/devices/${laptop}/controls`);
    expect(res.status).toBe(200);
    const sec = res.body.sections;
    for (const k of ['trust', 'alerts', 'monitoring', 'wake_on_lan', 'dns_filter', 'switch_port', 'endpoint_agent', 'router']) expect(sec[k].available).toBe(true);
    expect(sec.trust.trust).toBe('unreviewed');
    expect(sec.wake_on_lan.possible).toBe(true);
    expect(sec.dns_filter).toMatchObject({ filter_enabled: false, pause: { possible: false, reason: 'filter_off' } });
    expect(sec.switch_port.reason).toBe('no_switches');
    expect(sec.endpoint_agent.linked).toBe(false);
    const r = sec.router.routers[0];
    expect(r.sees_device).toMatchObject({ ip: '192.168.50.20', link: 'inferred_by_mac' });
    expect(r.actions.block).toMatchObject({ possible: true, href: `/api/v1/routers/${s.routerId}/block` });
    expect(r.actions.rate_limit).toMatchObject({ possible: false, reason: 'unsupported_on_router' });
    expect(r.actions.rate_limit.note).toContain('global QoS');
    const gw = await s.a.agent.get(`/api/v1/devices/${s.devices['192.168.50.1']}/controls`);
    expect(gw.body.sections.router.routers[0].actions.block).toMatchObject({ possible: false, reason: 'gateway' });

    // One module's data cannot be read: only that section reports it.
    await systemPool.query('REVOKE SELECT ON endpoints FROM lan_app');
    try {
      const partial = await s.a.agent.get(`/api/v1/devices/${laptop}/controls`);
      expect(partial.status).toBe(200);
      expect(partial.body.sections.endpoint_agent).toEqual({ available: false, error: { code: 'section_failed', message: expect.any(String) } });
      expect(partial.body.sections.router.available).toBe(true);
      expect(partial.body.sections.trust.available).toBe(true);
    } finally {
      await systemPool.query('GRANT SELECT ON endpoints TO lan_app');
    }
  });

  it('proposes blocking an unwanted online device on a capable router, without acting', async () => {
    const s = await setup('rc-insight');
    await refresh(s);
    const laptop = s.devices['192.168.50.20']!;
    await s.a.agent.patch(`/api/v1/devices/${laptop}`).set(CSRF).send({ trust: 'unwanted' });
    const insights = await s.a.agent.get('/api/v1/insights');
    const i = insights.body.insights.find((x: { code: string }) => x.code === 'unwanted_blockable');
    expect(i).toBeTruthy();
    expect(i.actions).toEqual([expect.objectContaining({ kind: 'api', href: `/api/v1/routers/${s.routerId}/block`, body: { device_ids: [laptop] } })]);
    // Nothing was queued by looking at insights.
    expect(await command(s.c, 'router_block')).toHaveLength(0);
  });

  it('accepts the timezone the collector reports for access control', async () => {
    const a = await newAccount('rc-tz');
    const c = await newCollector(a);
    const hb = await heartbeat(c, { access_status: { enabled: true, listening: true, timezone: 'Africa/Cairo' } });
    expect(hb.status).toBe(200);
    // Older collectors without the field keep working.
    expect((await heartbeat(c, { access_status: { enabled: true, listening: true } })).status).toBe(200);
  });

  it('accepts all shipped router vendor drivers and rejects unknown vendors', async () => {
    const a = await newAccount('rc-vendors');
    await addScope(a, '192.168.60.0/24');
    const vendors = [
      'mikrotik',
      'huawei',
      'huawei_lte',
      'zte',
      'tplink_archer',
      'tenda',
      'dlink',
      'asus',
      'zyxel',
      'unifi',
      'omada',
      'openwrt',
      'opnsense',
      'pfsense',
      'fortigate',
      'cisco_xe',
    ];
    for (let i = 0; i < vendors.length; i++) {
      const res = await a.agent.post('/api/v1/routers').set(CSRF).send({
        site_id: a.siteId,
        name: `Router ${vendors[i]}`,
        vendor: vendors[i],
        address: `192.168.60.${i + 1}`,
        transport: 'https',
        credentials: { username: 'admin', password: PASSWORD },
      });
      expect(res.status, `vendor ${vendors[i]}`).toBe(201);
      expect(res.body.vendor).toBe(vendors[i]);
    }
    const bad = await a.agent.post('/api/v1/routers').set(CSRF).send({
      site_id: a.siteId,
      name: 'Unknown',
      vendor: 'not-a-vendor',
      address: '192.168.60.99',
      transport: 'https',
      credentials: { username: 'admin', password: PASSWORD },
    });
    expect(bad.status).toBe(400);
  });
});
