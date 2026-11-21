import { describe, expect, it } from 'vitest';
import { portForwardProblem } from '../src/modules/routers/settings.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, type TestAccount, type TestCollector, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

// Router controls beyond blocking (docs/features/router-controls.md): settings ingest, Wi-Fi,
// DHCP reservations, port forwards, rename and reboot, end to end through the collector protocol.

const CAPS = [
  { capability: 'clients', supported: true },
  { capability: 'block', supported: true },
  { capability: 'overview', supported: true },
  { capability: 'wifi', supported: true },
  { capability: 'reservations', supported: true },
  { capability: 'port_forward', supported: true },
  { capability: 'rename', supported: true },
  { capability: 'reboot', supported: true },
];

const SETTINGS = {
  overview: { uptime_seconds: 86400, lan_ip: '192.168.50.1', wan: [{ name: 'ETHWAN', status: 'up', type: 'ETH', ipv4: '41.0.0.10', dns: ['8.8.8.8'] }] },
  wifi: [
    { id: '1', band: '2.4GHz', ssid: 'Home', enabled: true, main: true, guest: false, hidden: false, security: 'WPA2-Personal', client_macs: ['aa:bb:cc:00:00:21'] },
    { id: '2', band: '2.4GHz', ssid: 'Home_guest1', enabled: false, main: false, guest: true, hidden: false, client_macs: [] },
    { id: '5', band: '5GHz', ssid: 'Home5', enabled: true, main: true, guest: false, hidden: false, client_macs: ['AA-BB-CC-00-00-20'] },
  ],
  reservations: [{ id: '1', mac: 'AA:BB:CC:00:00:21', ip: '192.168.50.21', enabled: true }],
  port_forwards: [
    {
      id: '1',
      enabled: true,
      description: 'admin web cam',
      protocol: 'tcp',
      external_start: 8080,
      external_end: 8080,
      internal_start: 80,
      internal_end: 80,
      internal_ip: '192.168.50.21',
      owner: 'administrator',
    },
  ],
};

interface Setup {
  a: TestAccount;
  c: TestCollector;
  scopeId: string;
  routerId: string;
  devices: Record<string, string>; // ip → device id
}

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };

async function commands(c: TestCollector, kind: string): Promise<Cmd[]> {
  const hb = await heartbeat(c);
  expect(hb.status).toBe(200);
  return (hb.body.commands as Cmd[]).filter((x) => x.kind === kind);
}

function result(routerId: string, fields: Record<string, unknown>) {
  return { type: 'router_result', ts: new Date().toISOString(), router_id: routerId, trigger: 'command', duration_ms: 12, ...fields };
}

async function setup(label: string, caps = CAPS): Promise<Setup> {
  const a = await newAccount(label);
  const scopeId = await addScope(a, '192.168.50.0/24');
  const c = await newCollector(a);
  await heartbeat(c);
  await telemetry(c, [
    sweep(scopeId, [
      { ip: '192.168.50.1', mac: '00:11:22:33:44:01', hostname: 'gateway' },
      { ip: '192.168.50.20', mac: 'aa:bb:cc:00:00:20', hostname: 'laptop' },
      { ip: '192.168.50.21', mac: 'aa:bb:cc:00:00:21', hostname: 'phone' },
      { ip: '192.168.50.22', hostname: 'no-mac-thing' },
    ]),
  ]);
  const list = await a.agent.get('/api/v1/devices?page_size=50');
  const devices: Record<string, string> = {};
  for (const d of list.body.items) devices[d.current_ip] = d.id;
  const created = await a.agent
    .post('/api/v1/routers')
    .set(CSRF)
    .send({ site_id: a.siteId, name: 'Home router', vendor: 'zyxel', address: '192.168.50.1', transport: 'https', credentials: { username: 'u', password: 'router-pass-9z' } });
  expect(created.status).toBe(201);
  const s = { a, c, scopeId, routerId: created.body.id, devices };
  // Capabilities and clients first (a scheduled refresh), settings optional per test.
  const t = await telemetry(c, [
    result(s.routerId, {
      action: 'refresh',
      trigger: 'scheduled',
      ok: true,
      identity: { vendor: 'Zyxel', model: 'VMG3625-T50B', firmware: 'V5.50' },
      capabilities: caps,
      clients: [
        { mac: 'aa:bb:cc:00:00:20', ip: '192.168.50.20', hostname: 'laptop', connection: 'wifi_5ghz' },
        { mac: 'aa:bb:cc:00:00:21', ip: '192.168.50.21', hostname: 'phone', connection: 'wifi_2_4ghz' },
      ],
    }),
  ]);
  expect(t.body).toMatchObject({ accepted: 1 });
  return s;
}

async function reportSettings(s: Setup, settings: unknown = SETTINGS) {
  const t = await telemetry(s.c, [result(s.routerId, { action: 'refresh', trigger: 'scheduled', ok: true, settings })]);
  expect(t.body).toMatchObject({ accepted: 1 });
}

/** Completes a queued request the way the collector does, with the settings it re-read. */
async function complete(s: Setup, requestId: string, action: string, fields: Record<string, unknown> = {}) {
  const t = await telemetry(s.c, [
    result(s.routerId, {
      request_id: requestId,
      action,
      ok: true,
      change: { action, mac: '', mechanism: 'test', applied: true, already_in_effect: false, detail: 'done', undo: 'reverse it' },
      ...fields,
    }),
  ]);
  expect(t.body).toMatchObject({ accepted: 1 });
  expect((await s.a.agent.get(`/api/v1/router-requests/${requestId}`)).body.status).toBe('completed');
}

describe('router settings and controls', () => {
  it('stores the settings a refresh reports, part by part, never a secret, and shows them with device names', async () => {
    const s = await setup('rs-ingest');
    // Not read yet.
    let g = await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ settings_at: null, overview: null, wifi: null, reservations: null, port_forwards: null });

    await reportSettings(s);
    g = await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`);
    expect(g.body.overview).toMatchObject({ uptime_seconds: 86400, lan_ip: '192.168.50.1' });
    expect(g.body.lan).toMatchObject({ cidr: '192.168.50.0/24' });
    expect(g.body.wifi).toHaveLength(3);
    expect(g.body.wifi[2]).toMatchObject({ id: '5', client_macs: ['aa:bb:cc:00:00:20'], client_count: 1 });
    expect(g.body.reservations[0]).toMatchObject({ mac: 'aa:bb:cc:00:00:21', device_id: s.devices['192.168.50.21'] });
    expect(g.body.port_forwards[0]).toMatchObject({ id: '1', owner: 'administrator', device_id: s.devices['192.168.50.21'] });

    // A part not reported keeps its last value; a reported part (even empty) replaces it.
    await reportSettings(s, { reservations: [] });
    g = await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`);
    expect(g.body.reservations).toEqual([]);
    expect(g.body.wifi).toHaveLength(3);
    expect(g.body.port_forwards).toHaveLength(1);

    // A field that could carry a secret is not part of the protocol: the whole result is refused.
    const bad = await telemetry(s.c, [
      result(s.routerId, { action: 'refresh', trigger: 'scheduled', ok: true, settings: { wifi: [{ ...SETTINGS.wifi[0], psk_value: 'secret-key-1' }] } }),
    ]);
    expect(bad.status).toBe(400);
    const stored = await systemPool.query(`SELECT settings::text AS t FROM site_routers WHERE id = $1`, [s.routerId]);
    expect(stored.rows[0].t).not.toContain('secret-key-1');

    // Viewers read the settings.
    await setRole(s.a.email, s.a.organizationId, 'viewer');
    expect((await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`)).status).toBe(200);
    // Tenant isolation.
    const other = await setup('rs-ingest-other');
    expect((await other.a.agent.get(`/api/v1/routers/${s.routerId}/settings`)).status).toBe(404);
  });

  it('renames a device on the router through the collector, audited, and stores the re-read settings', async () => {
    const s = await setup('rs-rename');
    const laptop = s.devices['192.168.50.20']!;
    const r = await s.a.agent.post(`/api/v1/routers/${s.routerId}/rename`).set(CSRF).send({ device_id: laptop, name: '  Study laptop ' });
    expect(r.status).toBe(202);
    const [cmd] = await commands(s.c, 'router_rename');
    expect(cmd!.payload).toEqual({ request_id: r.body.request_id, router_id: s.routerId, mac: 'aa:bb:cc:00:00:20', name: 'Study laptop' });
    // One at a time per device.
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/rename`).set(CSRF).send({ device_id: laptop, name: 'x' })).body.error.code).toBe('already_requested');
    await complete(s, r.body.request_id, 'rename', { settings: { wifi: SETTINGS.wifi } });
    expect((await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`)).body.wifi).toHaveLength(3);

    // Refusals: control characters, a device the router does not list, a device without a MAC.
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/rename`).set(CSRF).send({ device_id: laptop, name: 'bad\u0007name' })).status).toBe(400);
    const gw = await s.a.agent.post(`/api/v1/routers/${s.routerId}/rename`).set(CSRF).send({ device_id: s.devices['192.168.50.1'], name: 'x' });
    expect(gw.body.error.code).toBe('not_on_router');
    const nomac = await s.a.agent.post(`/api/v1/routers/${s.routerId}/rename`).set(CSRF).send({ device_id: s.devices['192.168.50.22'], name: 'x' });
    expect(nomac.body.error.code).toBe('no_mac');

    const audit = await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'router.rename'`, [s.a.organizationId]);
    expect(audit.rows[0].metadata).toMatchObject({ mac: 'aa:bb:cc:00:00:20', name: 'Study laptop', request_id: r.body.request_id });
  });

  it('turns Wi-Fi networks on and off with the guards: collector host, own machine, main-network confirmation', async () => {
    const s = await setup('rs-wifi');
    // Nothing read yet.
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '2', enabled: true })).body.error.code).toBe('settings_unknown');
    await reportSettings(s);
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '9', enabled: true })).status).toBe(404);

    // Guest on.
    const on = await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '2', enabled: true });
    expect(on.status).toBe(202);
    const [cmd] = await commands(s.c, 'router_wifi');
    expect(cmd!.payload).toEqual({ request_id: on.body.request_id, router_id: s.routerId, wifi_id: '2', enabled: true });
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '2', enabled: false })).body.error.code).toBe('already_requested');
    await complete(s, on.body.request_id, 'wifi');

    // Main off needs confirmation.
    const noConfirm = await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '1', enabled: false });
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.body.error).toMatchObject({ code: 'confirm_required', details: { clients: 1 } });
    const off = await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '1', enabled: false, confirm: true });
    expect(off.status).toBe(202);
    const audit = await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'router.wifi' ORDER BY created_at`, [s.a.organizationId]);
    expect(audit.rows.at(-1).metadata).toMatchObject({ wifi_id: '1', ssid: 'Home', enabled: false, confirmed: true });

    // A guest network while its band's main network is off is refused.
    await reportSettings(s, { wifi: SETTINGS.wifi.map((w) => (w.id === '1' ? { ...w, enabled: false } : w)) });
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '2', enabled: true })).body.error.code).toBe('main_network_off');

    // The collector host is on the 5 GHz network: never turned off from the product.
    await telemetry(s.c, [{ ...sweep(s.scopeId, []), hosts: [{ ip: '192.168.50.30', mac: 'aa:bb:cc:00:00:30', sources: ['local_interface'] }] }]);
    await reportSettings(s, { wifi: SETTINGS.wifi.map((w) => (w.id === '5' ? { ...w, client_macs: ['aa:bb:cc:00:00:30'] } : w)) });
    const host = await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '5', enabled: false, confirm: true });
    expect(host.body.error.code).toBe('collector_host');

    // The requesting machine (the test client connects from loopback) is on the guest network.
    await systemPool.query(`UPDATE router_clients SET ip = '127.0.0.1' WHERE router_id = $1 AND mac = 'aa:bb:cc:00:00:20'`, [s.routerId]);
    await reportSettings(s, { wifi: SETTINGS.wifi.map((w) => (w.id === '2' ? { ...w, enabled: true, client_macs: ['aa:bb:cc:00:00:20'] } : w)) });
    const own = await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '2', enabled: false });
    expect(own.body.error.code).toBe('own_machine');
  });

  it('reserves and releases DHCP addresses, checked against the LAN and the router’s list', async () => {
    const s = await setup('rs-reserve');
    const laptop = s.devices['192.168.50.20']!;
    const phone = s.devices['192.168.50.21']!;
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/reservations`).set(CSRF).send({ device_id: laptop, ip: '192.168.50.60' })).body.error.code).toBe(
      'settings_unknown',
    );
    await reportSettings(s);
    const post = (ip: string, device = laptop) => s.a.agent.post(`/api/v1/routers/${s.routerId}/reservations`).set(CSRF).send({ device_id: device, ip });
    expect((await post('10.0.0.5')).body.error.code).toBe('outside_lan');
    expect((await post('192.168.50.1')).body.error.code).toBe('router_address');
    expect((await post('192.168.50.255')).body.error.code).toBe('reserved_address');
    expect((await post('192.168.50.21')).body.error.code).toBe('ip_reserved');
    await reportSettings(s, { reservations: [] });
    expect((await post('192.168.50.21')).body.error.code).toBe('ip_in_use');

    const ok = await post('192.168.50.60');
    expect(ok.status).toBe(202);
    const [cmd] = await commands(s.c, 'router_reservation');
    expect(cmd!.payload).toEqual({ request_id: ok.body.request_id, router_id: s.routerId, mac: 'aa:bb:cc:00:00:20', ip: '192.168.50.60' });
    await complete(s, ok.body.request_id, 'reserve', { settings: { reservations: [{ id: '7', mac: 'aa:bb:cc:00:00:20', ip: '192.168.50.60', enabled: true }] } });

    // Device controls describe it.
    const controls = await s.a.agent.get(`/api/v1/devices/${laptop}/controls`);
    const item = controls.body.sections.router.routers[0];
    expect(item.reservation).toMatchObject({ ip: '192.168.50.60' });
    expect(item.actions.unreserve).toMatchObject({ possible: true, method: 'DELETE' });
    expect(item.actions.rename).toMatchObject({ possible: true });

    expect((await s.a.agent.delete(`/api/v1/routers/${s.routerId}/reservations/${phone}`).set(CSRF)).body.error.code).toBe('not_reserved');
    const del = await s.a.agent.delete(`/api/v1/routers/${s.routerId}/reservations/${laptop}`).set(CSRF);
    expect(del.status).toBe(202);
    const cmds = await commands(s.c, 'router_reservation');
    expect(cmds.find((x) => x.payload.request_id === del.body.request_id)!.payload).toEqual({
      request_id: del.body.request_id,
      router_id: s.routerId,
      mac: 'aa:bb:cc:00:00:20',
      clear: true,
    });
    const audit = await systemPool.query(`SELECT action, metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'router.%reserve' ORDER BY created_at`, [
      s.a.organizationId,
    ]);
    expect(audit.rows.map((x) => x.action)).toEqual(['router.reserve', 'router.unreserve']);
    expect(audit.rows[1].metadata).toMatchObject({ ip: '192.168.50.60' });
  });

  it('adds and removes port forwards, never to the router or the collector host, never on management ports', async () => {
    const s = await setup('rs-forward');
    const laptop = s.devices['192.168.50.20']!;
    await reportSettings(s);
    const post = (body: Record<string, unknown>) =>
      s.a.agent
        .post(`/api/v1/routers/${s.routerId}/port-forwards`)
        .set(CSRF)
        .send({ device_id: laptop, description: 'game', protocol: 'tcp', ...body });
    expect((await post({ external_start: 443 })).body.error.code).toBe('management_port');
    expect((await post({ external_start: 8000, external_end: 8100 })).body.error.code).toBe('port_overlap');
    expect((await post({ external_start: 9000, external_end: 8990 })).body.error.code).toBe('invalid_range');
    expect((await post({ external_start: 9000, external_end: 9010, internal_start: 100, internal_end: 105 })).body.error.code).toBe('invalid_range');
    expect((await post({ external_start: 20, external_end: 25 })).body.error.code).toBe('management_port');
    expect((await post({ device_id: s.devices['192.168.50.1'], external_start: 45678 })).body.error.code).toBe('gateway');
    expect((await post({ external_start: 45678, description: '' })).status).toBe(400);

    const ok = await post({ external_start: 45678 });
    expect(ok.status).toBe(202);
    const [cmd] = await commands(s.c, 'router_port_forward');
    expect(cmd!.payload).toEqual({
      request_id: ok.body.request_id,
      router_id: s.routerId,
      port_forward: { description: 'game', protocol: 'tcp', external_start: 45678, external_end: 45678, internal_start: 45678, internal_end: 45678, internal_ip: '192.168.50.20' },
    });
    expect((await post({ external_start: 45000 })).body.error.code).toBe('already_requested');
    const added = {
      id: '9',
      enabled: true,
      description: 'LAN Detective: game',
      protocol: 'tcp',
      external_start: 45678,
      external_end: 45678,
      internal_start: 45678,
      internal_end: 45678,
      internal_ip: '192.168.50.20',
      owner: 'lan-detective',
    };
    await complete(s, ok.body.request_id, 'add_port_forward', { settings: { port_forwards: [...SETTINGS.port_forwards, added] } });

    const controls = await s.a.agent.get(`/api/v1/devices/${laptop}/controls`);
    expect(controls.body.sections.router.routers[0].port_forwards).toEqual([expect.objectContaining({ id: '9', actions: { remove: expect.objectContaining({ method: 'DELETE' }) } })]);

    expect((await s.a.agent.delete(`/api/v1/routers/${s.routerId}/port-forwards/42`).set(CSRF)).status).toBe(404);
    const del = await s.a.agent.delete(`/api/v1/routers/${s.routerId}/port-forwards/9`).set(CSRF);
    expect(del.status).toBe(202);
    const cmds = await commands(s.c, 'router_port_forward');
    expect(cmds.find((x) => x.payload.request_id === del.body.request_id)!.payload).toEqual({ request_id: del.body.request_id, router_id: s.routerId, clear: true, port_forward: added });

    // The collector host is never exposed either.
    await complete(s, del.body.request_id, 'remove_port_forward', { settings: { port_forwards: SETTINGS.port_forwards } });
    await telemetry(s.c, [{ ...sweep(s.scopeId, []), hosts: [{ ip: '192.168.50.30', mac: 'aa:bb:cc:00:00:30', sources: ['local_interface'] }] }]);
    const list = await s.a.agent.get('/api/v1/devices?q=192.168.50.30');
    expect((await post({ device_id: list.body.items[0].id, external_start: 45678 })).body.error.code).toBe('collector_host');

    const audit = await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'router.%port_forward' ORDER BY created_at`, [s.a.organizationId]);
    expect(audit.rows.map((x) => x.action)).toEqual(['router.add_port_forward', 'router.remove_port_forward']);
  });

  it('forwards ports to a device whose MAC address is unknown (keyed by its LAN address)', async () => {
    const s = await setup('rs-forward-nomac');
    await reportSettings(s);
    const noMac = s.devices['192.168.50.22']!;
    // The device page offers it (it needs only the IP) …
    const controls = await s.a.agent.get(`/api/v1/devices/${noMac}/controls`);
    expect(controls.body.sections.router.routers[0].actions.port_forward).toMatchObject({ possible: true, method: 'POST' });
    // … and the request is accepted, not refused with no_mac.
    const ok = await s.a.agent.post(`/api/v1/routers/${s.routerId}/port-forwards`).set(CSRF).send({ device_id: noMac, description: 'nas', protocol: 'tcp', external_start: 45679 });
    expect(ok.status).toBe(202);
    const [cmd] = await commands(s.c, 'router_port_forward');
    expect(cmd!.payload).toMatchObject({ request_id: ok.body.request_id, port_forward: { internal_ip: '192.168.50.22', external_start: 45679 } });
    expect(cmd!.payload).not.toHaveProperty('mac');
    const audit = await systemPool.query(`SELECT target_id, metadata FROM audit_logs WHERE organization_id = $1 AND action = 'router.add_port_forward'`, [s.a.organizationId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ target_id: noMac, metadata: { internal_ip: '192.168.50.22' } });
    // A device of another site is still not found, and MAC-keyed controls still need the MAC.
    const other = await setup('rs-forward-other');
    const foreign = other.devices['192.168.50.20']!;
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/port-forwards`).set(CSRF).send({ device_id: foreign, description: 'x', protocol: 'tcp', external_start: 45680 })).status).toBe(404);
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/reservations`).set(CSRF).send({ device_id: noMac, ip: '192.168.50.61' })).body.error.code).toBe('no_mac');
  });

  it('removes a router reservation whose MAC matches no device record, by MAC, admin only, audited', async () => {
    const s = await setup('rs-unreserve-mac');
    const stray = { id: '8', mac: 'DE-AD-BE-EF-00-01', ip: '192.168.50.88', enabled: true };
    await reportSettings(s, { ...SETTINGS, reservations: [...SETTINGS.reservations, stray] });
    const g = await s.a.agent.get(`/api/v1/routers/${s.routerId}/settings`);
    expect(g.body.reservations.find((x: { mac: string }) => x.mac === 'de:ad:be:ef:00:01')).toMatchObject({ device_id: null, ip: '192.168.50.88' });

    const url = (mac: string) => `/api/v1/routers/${s.routerId}/reservations/by-mac/${encodeURIComponent(mac)}`;
    expect((await s.a.agent.delete(url('not-a-mac')).set(CSRF)).status).toBe(400);
    expect((await s.a.agent.delete(url('de:ad:be:ef:00:99')).set(CSRF)).body.error.code).toBe('not_reserved');

    await setRole(s.a.email, s.a.organizationId, 'technician');
    expect((await s.a.agent.delete(url('de:ad:be:ef:00:01')).set(CSRF)).status).toBe(403);
    await setRole(s.a.email, s.a.organizationId, 'admin');

    const del = await s.a.agent.delete(url('DE-AD-BE-EF-00-01')).set(CSRF);
    expect(del.status).toBe(202);
    const [cmd] = await commands(s.c, 'router_reservation');
    expect(cmd!.payload).toEqual({ request_id: del.body.request_id, router_id: s.routerId, mac: 'de:ad:be:ef:00:01', clear: true });
    expect((await s.a.agent.delete(url('de:ad:be:ef:00:01')).set(CSRF)).body.error.code).toBe('already_requested');
    await complete(s, del.body.request_id, 'unreserve', { settings: { reservations: SETTINGS.reservations } });

    const audit = await systemPool.query(`SELECT target_type, target_id, metadata FROM audit_logs WHERE organization_id = $1 AND action = 'router.unreserve'`, [s.a.organizationId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ target_type: 'router', target_id: s.routerId, metadata: { mac: 'de:ad:be:ef:00:01', ip: '192.168.50.88', device_id: null } });

    // By MAC also works for a reservation that does belong to a known device; the request is linked to it.
    const phone = s.devices['192.168.50.21']!;
    const linked = await s.a.agent.delete(url('aa:bb:cc:00:00:21')).set(CSRF);
    expect(linked.status).toBe(202);
    const req = await systemPool.query(`SELECT device_id FROM router_requests WHERE id = $1`, [linked.body.request_id]);
    expect(req.rows[0].device_id).toBe(phone);
  });

  it('reboots only on explicit confirmation, and only administrators change anything', async () => {
    const s = await setup('rs-reboot');
    await reportSettings(s);
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/reboot`).set(CSRF).send({})).status).toBe(400);
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/reboot`).set(CSRF).send({ confirm: 'yes' })).status).toBe(400);
    const ok = await s.a.agent.post(`/api/v1/routers/${s.routerId}/reboot`).set(CSRF).send({ confirm: 'reboot' });
    expect(ok.status).toBe(202);
    const [cmd] = await commands(s.c, 'router_reboot');
    expect(cmd!.payload).toEqual({ request_id: ok.body.request_id, router_id: s.routerId });
    expect((await s.a.agent.post(`/api/v1/routers/${s.routerId}/reboot`).set(CSRF).send({ confirm: 'reboot' })).body.error.code).toBe('already_requested');
    await complete(s, ok.body.request_id, 'reboot');

    const laptop = s.devices['192.168.50.20']!;
    await setRole(s.a.email, s.a.organizationId, 'technician');
    const tries = [
      s.a.agent.post(`/api/v1/routers/${s.routerId}/reboot`).set(CSRF).send({ confirm: 'reboot' }),
      s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '2', enabled: true }),
      s.a.agent.post(`/api/v1/routers/${s.routerId}/rename`).set(CSRF).send({ device_id: laptop, name: 'x' }),
      s.a.agent.post(`/api/v1/routers/${s.routerId}/reservations`).set(CSRF).send({ device_id: laptop, ip: '192.168.50.60' }),
      s.a.agent.delete(`/api/v1/routers/${s.routerId}/reservations/${laptop}`).set(CSRF),
      s.a.agent.post(`/api/v1/routers/${s.routerId}/port-forwards`).set(CSRF).send({ device_id: laptop, description: 'x', protocol: 'tcp', external_start: 45678 }),
      s.a.agent.delete(`/api/v1/routers/${s.routerId}/port-forwards/1`).set(CSRF),
    ];
    for (const t of await Promise.all(tries)) expect(t.status).toBe(403);
    await setRole(s.a.email, s.a.organizationId, 'admin');
  });

  it('offers a control only when the router reports the capability', async () => {
    const s = await setup('rs-caps', CAPS.filter((c) => !['wifi', 'reboot', 'port_forward'].includes(c.capability)));
    await reportSettings(s);
    for (const r of [
      await s.a.agent.post(`/api/v1/routers/${s.routerId}/wifi`).set(CSRF).send({ wifi_id: '2', enabled: true }),
      await s.a.agent.post(`/api/v1/routers/${s.routerId}/reboot`).set(CSRF).send({ confirm: 'reboot' }),
      await s.a.agent.post(`/api/v1/routers/${s.routerId}/port-forwards`).set(CSRF).send({ device_id: s.devices['192.168.50.20'], description: 'x', protocol: 'tcp', external_start: 45678 }),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('unsupported_on_router');
    }
    const controls = await s.a.agent.get(`/api/v1/devices/${s.devices['192.168.50.20']}/controls`);
    expect(controls.body.sections.router.routers[0].actions.port_forward.possible).toBe(false);
    expect(controls.body.sections.router.routers[0].actions.reserve.possible).toBe(true);
  });

  it('validates port-forward rules', () => {
    const rule = (es: number, ee: number, is = es, ie = is + (ee - es), protocol: 'tcp' | 'udp' | 'both' = 'tcp') => ({
      protocol,
      external_start: es,
      external_end: ee,
      internal_start: is,
      internal_end: ie,
    });
    const existing = [{ ...SETTINGS.port_forwards[0]!, protocol: 'udp' as const, owner: 'administrator' as const }];
    expect(portForwardProblem(rule(8080, 8080), existing)).toBeNull(); // different protocol
    expect(portForwardProblem(rule(8080, 8080, 80, 80, 'both'), existing)?.code).toBe('port_overlap');
    expect(portForwardProblem(rule(7547, 7547), [])?.code).toBe('management_port');
    expect(portForwardProblem(rule(10000, 11000), [])?.code).toBe('too_many_ports');
    expect(portForwardProblem(rule(65000, 65010, 65530, 65540), [])?.code).toBe('invalid_range');
    expect(portForwardProblem(rule(10000, 10999), [])).toBeNull();
  });
});
