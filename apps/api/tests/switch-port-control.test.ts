import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { playbookTick } from '../src/modules/playbooks/index.ts';
import { runQuarantineAutoRelease } from '../src/modules/ports/index.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry, type TestCollector } from './helpers.ts';

// Phase 5: switch port control (admin status, description, access VLAN), write credentials,
// risk checks, TTL, read-back verification, device quarantine and release.

const READ = 'read-community-77';
const WRITE = 'write-community-secret-42';
const HOSTS = [
  { ip: '192.168.7.1', mac: '00:0c:29:77:00:01', hostname: 'gw.lan' },
  { ip: '192.168.7.2', mac: '00:0c:29:77:00:02', hostname: 'sw-core' },
  { ip: '192.168.7.10', mac: '00:0c:29:77:00:10', hostname: 'nas' },
  { ip: '192.168.7.11', mac: '00:0c:29:77:00:11', hostname: 'printer' },
];

const port = (i: number, extra: Record<string, unknown> = {}) => ({
  if_index: i, name: `Gi0/${i}`, admin_up: true, oper_up: true, speed_mbps: 1000,
  in_errors: 0, out_errors: 0, in_discards: 0, out_discards: 0, in_octets: 0, out_octets: 0, ...extra,
});

const now = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function poll(targetId: string) {
  return {
    type: 'snmp_poll', ts: now(-60_000), target_id: targetId, ok: true, sys_name: 'sw-core', sys_descr: 'Test switch',
    ports: [port(1), port(2), port(3, { oper_up: false }), port(4), port(8)],
    fdb: [
      { mac: '00:0c:29:77:00:10', if_index: 1, vlan: 10 }, // nas, alone
      { mac: '00:0c:29:77:00:11', if_index: 2, vlan: 10 }, // printer, alone
      { mac: '00:0c:29:77:00:01', if_index: 4, vlan: 10 }, // the gateway
      ...['31', '32', '33', '34', '35', '36'].map((x) => ({ mac: `00:0c:29:77:00:${x}`, if_index: 8, vlan: 0 })),
    ],
    lldp: [],
  };
}

function vlans(targetId: string, ts = now(-30_000)) {
  return {
    type: 'switch_vlans', ts, target_id: targetId, sys_object_id: '.1.3.6.1.4.1.11.2.3.7.11.1',
    vlans: [{ id: 1, name: 'default', source: 'qbridge' }, { id: 10, name: 'Office', source: 'qbridge' }, { id: 20, name: 'Guests', source: 'qbridge' }, { id: 99, name: 'Quarantine', source: 'qbridge' }],
    ports: [
      { if_index: 1, access_vlan: 10, mode: 'access', source: 'qbridge' },
      { if_index: 2, access_vlan: 10, mode: 'access', source: 'qbridge' },
      { if_index: 3, access_vlan: 1, mode: 'access', source: 'qbridge' },
      { if_index: 4, access_vlan: 10, mode: 'access', source: 'qbridge' },
      { if_index: 8, mode: 'trunk', source: 'qbridge' },
    ],
    methods: ['qbridge'],
  };
}

async function office() {
  const a = await newAccount('portctl');
  const scopeId = await addScope(a, '192.168.7.0/24');
  const c = await newCollector(a);
  await heartbeat(c, { gateway_ip: '192.168.7.1' });
  await telemetry(c, [sweep(scopeId, HOSTS, 30)]);
  const created = await a.agent.post('/api/v1/switches').set(CSRF).send({ site_id: a.siteId, host: '192.168.7.2', credentials: { version: '2c', community: READ } });
  const sw = created.body.id as string;
  expect((await telemetry(c, [poll(sw), vlans(sw)])).body).toMatchObject({ accepted: 2, rejected: [] });
  const devices = (await a.agent.get('/api/v1/devices?sort=ip')).body.items as Record<string, any>[];
  const byIp = (ip: string) => devices.find((d) => d.current_ip === ip)!;
  return { a, c, sw, byIp };
}

/** The set_switch_port commands the collector receives on its next heartbeat. */
async function portCommands(c: TestCollector) {
  const hb = (await heartbeat(c, { gateway_ip: '192.168.7.1' })).body;
  return { hb, cmds: (hb.commands as any[]).filter((x) => x.kind === 'set_switch_port') };
}

function result(cmd: any, over: Record<string, unknown> = {}) {
  const p = cmd.payload;
  return { type: 'switch_port_result', ts: now(), request_id: p.request_id, target_id: p.target_id, if_index: p.if_index, op: p.op, ok: true, verified: true, duration_ms: 120, ...over };
}

const action = (a: any, sw: string, ifIndex: number, body: Record<string, unknown>) => a.agent.post(`/api/v1/switches/${sw}/ports/${ifIndex}/actions`).set(CSRF).send(body);

describe('switch port control', () => {
  it('stores VLANs read by the collector and keeps write credentials sealed and write-only', async () => {
    const { a, c, sw } = await office();
    const ctl = (await a.agent.get(`/api/v1/switches/${sw}/control`)).body;
    expect(ctl.vlans.map((v: any) => v.id)).toEqual([1, 10, 20, 99]);
    expect(ctl.vlan_methods).toEqual(['qbridge']);
    expect(ctl.ports.find((p: any) => p.if_index === 8)).toMatchObject({ mode: 'trunk', access_vlan: null });
    expect(ctl.write).toMatchObject({ configured: false });

    // An older VLAN read arriving late does not overwrite the newer one.
    await telemetry(c, [{ ...vlans(sw, now(-3_600_000)), vlans: [{ id: 1, source: 'qbridge' }] }]);
    expect((await a.agent.get(`/api/v1/switches/${sw}/control`)).body.vlans).toHaveLength(4);

    // Another organization's collector cannot report VLANs for this switch.
    const other = await newAccount('portctl-other');
    await addScope(other, '192.168.7.0/24');
    const oc = await newCollector(other);
    expect((await telemetry(oc, [vlans(sw)])).body.rejected).toHaveLength(1);

    // Without write credentials no change is possible.
    expect((await action(a, sw, 2, { op: 'alias', alias: 'Printer', confirm: true })).body.error.code).toBe('write_not_configured');

    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } })).status).toBe(403);
    expect((await action(a, sw, 2, { op: 'alias', alias: 'x', confirm: true })).status).toBe(403);
    await setRole(a.email, a.organizationId, 'admin');

    expect((await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } })).status).toBe(200);
    const after = (await a.agent.get(`/api/v1/switches/${sw}/control`)).body;
    expect(after.write).toMatchObject({ configured: true, version: '2c' });
    expect(JSON.stringify(after)).not.toContain(WRITE);
    const stored = (await systemPool.query(`SELECT write_secret_enc FROM snmp_targets WHERE id = $1`, [sw])).rows[0];
    expect(stored.write_secret_enc).toMatch(/^v1:/);
    const audits = await systemPool.query(`SELECT action, metadata::text AS m FROM audit_logs WHERE organization_id = $1`, [a.organizationId]);
    expect(audits.rows.map((r) => r.action)).toContain('switch.write_credentials.set');
    expect(JSON.stringify(audits.rows)).not.toContain(WRITE);

    // Nothing pending: the collector does not receive the write credentials.
    const hb = (await heartbeat(c)).body;
    expect(hb.config.snmp.targets[0]).not.toHaveProperty('write');
    expect(JSON.stringify(hb)).not.toContain(WRITE);

    expect((await a.agent.delete(`/api/v1/switches/${sw}/write-credentials`).set(CSRF)).status).toBe(204);
    expect((await a.agent.get(`/api/v1/switches/${sw}/control`)).body.write.configured).toBe(false);
  });

  it('runs a confirmed change through the collector and records the verified before / after', async () => {
    const { a, c, sw } = await office();
    await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } });

    expect((await action(a, sw, 2, { op: 'alias', alias: 'Printer' })).status).toBe(400); // no explicit confirmation
    expect((await action(a, sw, 2, { op: 'alias', alias: 'Ünïcode', confirm: true })).status).toBe(400);
    expect((await action(a, sw, 2, { op: 'shutdown', confirm: true })).status).toBe(400);
    expect((await action(a, sw, 77, { op: 'alias', alias: 'x', confirm: true })).status).toBe(404);

    const queued = await action(a, sw, 2, { op: 'alias', alias: '  Printer 2F ', confirm: true });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ status: 'pending', risks: [] });
    expect((await action(a, sw, 2, { op: 'admin_status', admin_up: true, confirm: true })).body.error.code).toBe('change_pending'); // one at a time per port

    // The collector that got the command receives the write credentials, only while it is pending.
    const { hb, cmds } = await portCommands(c);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].payload).toMatchObject({ request_id: queued.body.request_id, target_id: sw, if_index: 2, op: 'alias', alias: 'Printer 2F', override: false });
    expect(Date.parse(cmds[0].payload.expires_at)).toBeGreaterThan(Date.now());
    expect(hb.config.snmp.targets[0].write).toEqual({ version: '2c', community: WRITE });
    const second = await newCollector(a, 'edge-2');
    await heartbeat(second);
    expect((await heartbeat(second)).body.config.snmp.targets[0]).not.toHaveProperty('write'); // another collector of the site
    // ...and a collector the change was not sent to cannot report it.
    expect((await telemetry(second, [result(cmds[0])])).body.rejected).toHaveLength(1);

    const r = await telemetry(c, [result(cmds[0], { method: 'ifmib', before: { alias: '' }, after: { alias: 'Printer 2F' }, steps: ['ifAlias.2: "" → "Printer 2F"'] })]);
    expect(r.body).toMatchObject({ accepted: 1, rejected: [] });
    const req = (await a.agent.get(`/api/v1/port-requests/${queued.body.request_id}`)).body;
    expect(req).toMatchObject({ status: 'verified', op: 'alias', method: 'ifmib', params: { alias: 'Printer 2F' }, result: { before: { alias: '' }, after: { alias: 'Printer 2F' }, verified: true } });
    expect(req.before_known).toMatchObject({ source: 'last_read', admin_up: true, vlan: 10 });
    const detail = (await a.agent.get(`/api/v1/switches/${sw}`)).body;
    expect(detail.ports.find((p: any) => p.if_index === 2).alias).toBe('Printer 2F');
    expect((await heartbeat(c)).body.config.snmp.targets[0]).not.toHaveProperty('write'); // nothing pending any more
    expect((await a.agent.get('/api/v1/events?type=switch_port_changed&limit=5')).body.items).toHaveLength(1);
    const audits = await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'switch_port.%'`, [a.organizationId]);
    expect(audits.rows.map((x) => x.action)).toEqual(['switch_port.alias']);

    // A replayed result changes nothing; a failed change is recorded with its reason.
    expect((await telemetry(c, [result(cmds[0])])).body.accepted).toBe(1);
    const down = await action(a, sw, 2, { op: 'admin_status', admin_up: false, confirm: true });
    expect(down.status).toBe(202);
    const cmd2 = (await portCommands(c)).cmds.find((x) => x.payload.request_id === down.body.request_id)!;
    expect(cmd2.payload).toMatchObject({ op: 'admin_status', admin_up: false });
    await telemetry(c, [result(cmd2, { ok: false, verified: false, before: { admin_up: true }, error: { kind: 'write_rejected', message: 'the switch refused the write (noAccess)' } })]);
    const failed = (await a.agent.get(`/api/v1/port-requests?target_id=${sw}&if_index=2`)).body.items;
    expect(failed[0]).toMatchObject({ status: 'failed', error_kind: 'write_rejected' });
    expect(failed).toHaveLength(2);
    expect((await a.agent.get('/api/v1/events?type=switch_port_change_failed&limit=5')).body.items).toHaveLength(1);
  });

  it('refuses disruptive changes on risky ports unless a reason is given, and validates VLANs', async () => {
    const { a, c, sw } = await office();
    await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } });

    const ctl = (await a.agent.get(`/api/v1/switches/${sw}/ports/8/control`)).body;
    expect(ctl.risks.map((r: any) => r.code).sort()).toEqual(['many_devices', 'trunk']);
    expect(ctl.actions.access_vlan).toMatchObject({ possible: true });

    const risky = await action(a, sw, 8, { op: 'admin_status', admin_up: false, confirm: true });
    expect(risky.status).toBe(409);
    expect(risky.body.error.code).toBe('risky_port');
    const gw = await action(a, sw, 4, { op: 'access_vlan', vlan: 20, confirm: true });
    expect(gw.body.error.code).toBe('risky_port');
    expect(gw.body.error.details.risks).toEqual([expect.objectContaining({ code: 'gateway_port', source: 'observed' })]);
    // Enabling a port or changing a description is never disruptive.
    expect((await action(a, sw, 8, { op: 'alias', alias: 'Uplink to floor 2', confirm: true })).status).toBe(202);
    expect((await action(a, sw, 4, { op: 'access_vlan', vlan: 20, override_reason: 'short', confirm: true })).status).toBe(400);
    const overridden = await action(a, sw, 4, { op: 'access_vlan', vlan: 20, override_reason: 'Moving the old gateway to the guest VLAN on purpose', confirm: true });
    expect(overridden.status).toBe(202);
    const cmd = (await portCommands(c)).cmds.find((x) => x.payload.request_id === overridden.body.request_id)!;
    expect(cmd.payload).toMatchObject({ op: 'access_vlan', vlan: 20, method: 'qbridge', override: true });
    const stored = (await a.agent.get(`/api/v1/port-requests/${overridden.body.request_id}`)).body;
    expect(stored.override_reason).toContain('guest VLAN');
    expect(stored.risks[0].code).toBe('gateway_port');

    expect((await action(a, sw, 1, { op: 'access_vlan', vlan: 300, confirm: true })).body.error.code).toBe('vlan_not_found');
    expect((await action(a, sw, 1, { op: 'access_vlan', vlan: 10, confirm: true })).body.error.code).toBe('no_change');
    expect((await action(a, sw, 1, { op: 'access_vlan', vlan: 5000, confirm: true })).status).toBe(400);
  });

  it('expires a change the collector did not answer in time', async () => {
    const { a, c, sw } = await office();
    await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } });
    const q = await action(a, sw, 1, { op: 'access_vlan', vlan: 20, confirm: true });
    expect(q.status).toBe(202);
    await systemPool.query(`UPDATE switch_port_requests SET expires_at = now() - interval '1 second' WHERE id = $1`, [q.body.request_id]);
    expect((await heartbeat(c)).body.config.snmp.targets[0]).not.toHaveProperty('write');
    expect((await a.agent.get(`/api/v1/port-requests/${q.body.request_id}`)).body).toMatchObject({ status: 'expired', error_kind: 'expired' });
    const cmd = await systemPool.query(`SELECT status FROM collector_commands WHERE payload->>'request_id' = $1`, [q.body.request_id]);
    expect(cmd.rows[0].status).toBe('completed');
    // The port is free again.
    expect((await action(a, sw, 1, { op: 'access_vlan', vlan: 20, confirm: true })).status).toBe(202);
  });

  it('quarantines a device to the quarantine VLAN and releases it to its original VLAN', async () => {
    const { a, c, sw, byIp } = await office();
    const nas = byIp('192.168.7.10').id as string;
    let view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    expect(view.plan).toMatchObject({ possible: false, reason: 'no_quarantine_vlan', port_name: 'Gi0/1', current_vlan: 10 });

    expect((await a.agent.put(`/api/v1/sites/${a.siteId}/port-control`).set(CSRF).send({ quarantine_vlan: 99 })).status).toBe(200);
    const site = (await a.agent.get(`/api/v1/sites/${a.siteId}/port-control`)).body;
    expect(site).toMatchObject({ quarantine_vlan: 99 });
    expect(site.switches[0]).toMatchObject({ write_configured: false, quarantine_vlan_present: true });
    expect((await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body.plan.reason).toBe('write_not_configured');
    await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } });
    view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    expect(view.plan).toMatchObject({ possible: true, quarantine_vlan: 99, quarantine_vlan_source: 'site', location: { kind: 'direct' } });

    // A per-switch quarantine VLAN must exist on that switch.
    expect((await a.agent.put(`/api/v1/switches/${sw}/quarantine-vlan`).set(CSRF).send({ vlan: 444 })).body.error.code).toBe('vlan_not_found');

    // The gateway is on its own port but quarantining it is refused (it is Nigafiy's path).
    const gw = await a.agent.post(`/api/v1/devices/${byIp('192.168.7.1').id}/quarantine`).set(CSRF).send({ confirm: true });
    expect(gw.body.error.code).toBe('risky_port');

    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.post(`/api/v1/devices/${nas}/quarantine`).set(CSRF).send({ confirm: true })).status).toBe(403);
    await setRole(a.email, a.organizationId, 'admin');
    expect((await a.agent.post(`/api/v1/devices/${nas}/quarantine`).set(CSRF).send({})).status).toBe(400);

    const qd = await a.agent.post(`/api/v1/devices/${nas}/quarantine`).set(CSRF).send({ reason: 'Suspicious traffic', confirm: true });
    expect(qd.status).toBe(202);
    expect((await a.agent.post(`/api/v1/devices/${nas}/quarantine`).set(CSRF).send({ confirm: true })).body.error.code).toBe('already_quarantined');
    const cmd = (await portCommands(c)).cmds.find((x) => x.payload.request_id === qd.body.request_id)!;
    expect(cmd.payload).toMatchObject({ op: 'access_vlan', vlan: 99, if_index: 1, method: 'qbridge' });
    // Manual VLAN changes on a quarantined port are refused.
    // (The quarantine's own change is still pending, so the port is busy anyway.)
    await telemetry(c, [result(cmd, { method: 'qbridge', before: { vlan: 10 }, after: { vlan: 99 } })]);
    view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    expect(view.current).toMatchObject({ status: 'active', original_vlan: 10, quarantine_vlan: 99, reason: 'Suspicious traffic' });
    expect(view.plan).toMatchObject({ possible: false, reason: 'already_quarantined' });
    expect((await action(a, sw, 1, { op: 'access_vlan', vlan: 20, confirm: true })).body.error.code).toBe('port_quarantined');
    expect((await a.agent.get(`/api/v1/switches/${sw}/control`)).body.quarantines).toHaveLength(1);

    const rel = await a.agent.post(`/api/v1/quarantines/${view.current.id}/release`).set(CSRF).send({ confirm: true });
    expect(rel.status).toBe(202);
    expect((await a.agent.post(`/api/v1/quarantines/${view.current.id}/release`).set(CSRF).send({ confirm: true })).body.error.code).toBe('not_active');
    const relCmd = (await portCommands(c)).cmds.find((x) => x.payload.request_id === rel.body.request_id)!;
    expect(relCmd.payload).toMatchObject({ op: 'access_vlan', vlan: 10, if_index: 1 });
    await telemetry(c, [result(relCmd, { method: 'qbridge', before: { vlan: 99 }, after: { vlan: 10 } })]);
    view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    expect(view.current).toBeNull();
    expect(view.history[0]).toMatchObject({ status: 'released', released_by_email: a.email });
    const hist = (await a.agent.get(`/api/v1/port-requests?device_id=${nas}`)).body.items;
    expect(hist.map((h: any) => h.purpose)).toEqual(['release', 'quarantine']);
    const audits = await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'device.quarantine%' ORDER BY created_at`, [a.organizationId]);
    expect(audits.rows.map((x) => x.action)).toEqual(['device.quarantine', 'device.quarantine.release']);

    // Other organizations see nothing.
    const other = await newAccount('portctl-q-other');
    expect((await other.agent.get(`/api/v1/devices/${nas}/quarantine`)).status).toBe(404);
    expect((await other.agent.post(`/api/v1/quarantines/${view.history[0].id}/release`).set(CSRF).send({ confirm: true })).status).toBe(404);
    expect((await other.agent.get(`/api/v1/port-requests/${rel.body.request_id}`)).status).toBe(404);
  });

  it('marks a quarantine failed when the collector cannot verify it', async () => {
    const { a, c, sw, byIp } = await office();
    await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } });
    await a.agent.put(`/api/v1/switches/${sw}/quarantine-vlan`).set(CSRF).send({ vlan: 99 });
    const printer = byIp('192.168.7.11').id as string;
    const qd = await a.agent.post(`/api/v1/devices/${printer}/quarantine`).set(CSRF).send({ confirm: true });
    expect(qd.status).toBe(202);
    const cmd = (await portCommands(c)).cmds.find((x) => x.payload.request_id === qd.body.request_id)!;
    await telemetry(c, [result(cmd, { ok: false, verified: false, rolled_back: true, error: { kind: 'readback_mismatch', message: 'the PVID is not the new VLAN' } })]);
    const view = (await a.agent.get(`/api/v1/devices/${printer}/quarantine`)).body;
    expect(view.current).toBeNull();
    expect(view.history[0]).toMatchObject({ status: 'failed', last_error: 'the PVID is not the new VLAN' });
    expect(view.plan).toMatchObject({ possible: true, quarantine_vlan_source: 'switch' }); // can be tried again
  });

  it('releases a quarantine automatically when its optional auto-release time has passed (fail closed, retried, audited)', async () => {
    const { a, c, sw, byIp } = await office();
    await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } });
    await a.agent.put(`/api/v1/switches/${sw}/quarantine-vlan`).set(CSRF).send({ vlan: 99 });
    const nas = byIp('192.168.7.10').id as string;
    // Validation: 5 minutes to 30 days, whole minutes.
    for (const bad of [2, 43_201, 1.5, '60']) {
      expect((await a.agent.post(`/api/v1/devices/${nas}/quarantine`).set(CSRF).send({ release_after_minutes: bad, confirm: true })).status, String(bad)).toBe(400);
    }
    const qd = await a.agent.post(`/api/v1/devices/${nas}/quarantine`).set(CSRF).send({ reason: 'Contain until checked', release_after_minutes: 60, confirm: true });
    expect(qd.status).toBe(202);
    let view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    // Not verified yet: no release time.
    expect(view.current).toMatchObject({ status: 'requested', auto_release_minutes: 60, auto_release_at: null });
    const cmd = (await portCommands(c)).cmds.find((x) => x.payload.request_id === qd.body.request_id)!;
    await telemetry(c, [result(cmd, { method: 'qbridge', before: { vlan: 10 }, after: { vlan: 99 } })]);
    view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    expect(view.current.status).toBe('active');
    expect(new Date(view.current.auto_release_at).getTime() - new Date(view.current.activated_at).getTime()).toBe(60 * 60_000);
    const qid = view.current.id as string;

    await runQuarantineAutoRelease();
    expect((await systemPool.query(`SELECT status FROM device_quarantines WHERE id = $1`, [qid])).rows[0].status).toBe('active'); // not due

    // Due, but the switch is disabled: the device stays quarantined, the reason is shown and audited.
    await systemPool.query(`UPDATE device_quarantines SET activated_at = now() - interval '61 minutes' WHERE id = $1`, [qid]);
    await systemPool.query(`UPDATE snmp_targets SET enabled = false WHERE id = $1`, [sw]);
    await runQuarantineAutoRelease();
    view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    expect(view.current).toMatchObject({ id: qid, status: 'active' });
    expect(view.current.last_error).toMatch(/^Automatic release not possible: This switch is disabled/);
    await systemPool.query(`UPDATE snmp_targets SET enabled = true WHERE id = $1`, [sw]);
    // Retried only after the retry interval.
    await runQuarantineAutoRelease();
    expect((await systemPool.query(`SELECT status FROM device_quarantines WHERE id = $1`, [qid])).rows[0].status).toBe('active');
    await systemPool.query(`UPDATE device_quarantines SET auto_release_attempted_at = now() - interval '16 minutes' WHERE id = $1`, [qid]);
    await runQuarantineAutoRelease();
    view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    expect(view.current).toMatchObject({ id: qid, status: 'releasing', last_error: null });
    const relReq = await systemPool.query(`SELECT requested_via, created_by, created_by_email, purpose FROM switch_port_requests WHERE id = $1`, [view.current.release_request_id]);
    expect(relReq.rows[0]).toEqual({ requested_via: 'auto_release', created_by: null, created_by_email: null, purpose: 'release' });
    const relCmd = (await portCommands(c)).cmds.find((x) => x.payload.request_id === view.current.release_request_id)!;
    expect(relCmd.payload).toMatchObject({ op: 'access_vlan', vlan: 10, if_index: 1 });
    await telemetry(c, [result(relCmd, { method: 'qbridge', before: { vlan: 99 }, after: { vlan: 10 } })]);
    view = (await a.agent.get(`/api/v1/devices/${nas}/quarantine`)).body;
    expect(view.current).toBeNull();
    expect(view.history[0]).toMatchObject({ id: qid, status: 'released', auto_released: true, released_by_email: null });

    const audits = await systemPool.query(
      `SELECT action, actor, user_id, metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'device.quarantine%' ORDER BY created_at`,
      [a.organizationId],
    );
    expect(audits.rows.map((x) => [x.action, x.actor])).toEqual([
      ['device.quarantine', 'user'],
      ['device.quarantine.auto_release_failed', 'system'],
      ['device.quarantine.release', 'system'],
    ]);
    expect(audits.rows[0].metadata).toMatchObject({ auto_release_minutes: 60 });
    expect(audits.rows[1].metadata).toMatchObject({ quarantine_id: qid, error: 'switch_disabled', automation: 'quarantine_auto_release' });
    expect(audits.rows[2].metadata).toMatchObject({ quarantine_id: qid, auto_release: true, from_vlan: 99, to_vlan: 10 });
    expect(audits.rows[2].user_id).toBeNull();
  });

  it('playbook steps disable / quarantine a device port only at an administrator approval, with the same protections', async () => {
    const { a, c, sw, byIp } = await office();
    await a.agent.put(`/api/v1/switches/${sw}/write-credentials`).set(CSRF).send({ credentials: { version: '2c', community: WRITE } });
    await a.agent.put(`/api/v1/sites/${a.siteId}/port-control`).set(CSRF).send({ quarantine_vlan: 99 });
    const nas = byIp('192.168.7.10').id as string;
    const printer = byIp('192.168.7.11').id as string;
    const gw = byIp('192.168.7.1').id as string;
    const pb = await a.agent
      .post('/api/v1/playbooks')
      .set(CSRF)
      .send({ name: 'cut off', site_id: a.siteId, trigger: { kind: 'manual' }, approval_mode: 'run_automatically', auto_run_confirmed: true, steps: [{ key: 'off', action: 'switch_port_disable', params: {} }] });
    expect(pb.status, JSON.stringify(pb.body)).toBe(201);

    // Even "run automatically" waits for an administrator; nothing is queued before the approval.
    let run = await a.agent.post(`/api/v1/playbooks/${pb.body.id}/run`).set(CSRF).send({ device_id: nas });
    expect(run.body.status).toBe('awaiting_approval');
    expect((await portCommands(c)).cmds).toHaveLength(0);
    const step = run.body.steps[0];
    const approved = await a.agent.post(`/api/v1/playbook-runs/${run.body.id}/steps/${step.id}/decision`).set(CSRF).send({ decision: 'approve' });
    expect(approved.status).toBe(200);
    expect(approved.body.steps[0]).toMatchObject({ status: 'running', actor_email: a.email });
    const { cmds } = await portCommands(c);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].payload).toMatchObject({ if_index: 1, op: 'admin_status', admin_up: false });
    expect((await telemetry(c, [result(cmds[0], { after: { admin_up: false } })])).body.rejected).toEqual([]);
    await systemPool.query(`UPDATE playbook_runs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [run.body.id]);
    await playbookTick();
    run = await a.agent.get(`/api/v1/playbook-runs/${run.body.id}`);
    expect(run.body.status).toBe('succeeded');
    expect(run.body.steps[0].output).toMatchObject({ requests: [{ status: 'verified' }] });
    const audit = await systemPool.query(`SELECT 1 FROM audit_logs WHERE organization_id = $1 AND action = 'switch_port.admin_status'`, [a.organizationId]);
    expect(audit.rowCount).toBe(1);

    // The gateway's port is Nigafiy's own path: refused at approval, no override, nothing queued.
    const gwRun = await a.agent.post(`/api/v1/playbooks/${pb.body.id}/run`).set(CSRF).send({ device_id: gw });
    const gwDecided = await a.agent.post(`/api/v1/playbook-runs/${gwRun.body.id}/steps/${gwRun.body.steps[0].id}/decision`).set(CSRF).send({ decision: 'approve' });
    expect(gwDecided.body.status).toBe('failed');
    expect(gwDecided.body.steps[0].error).toContain('risky_port');
    expect((await portCommands(c)).cmds.filter((x: any) => x.payload.if_index === 4)).toHaveLength(0);
    expect((await systemPool.query(`SELECT 1 FROM switch_port_requests WHERE target_id = $1 AND if_index = 4`, [sw])).rowCount).toBe(0);

    // Quarantine through a playbook: the quarantine record, its VLAN change and the reason.
    const qpb = await a.agent
      .post('/api/v1/playbooks')
      .set(CSRF)
      .send({ name: 'isolate', site_id: a.siteId, trigger: { kind: 'manual' }, steps: [{ key: 'iso', action: 'switch_port_quarantine', params: { reason: 'Isolated by playbook' } }] });
    const qrun = await a.agent.post(`/api/v1/playbooks/${qpb.body.id}/run`).set(CSRF).send({ device_id: printer });
    await a.agent.post(`/api/v1/playbook-runs/${qrun.body.id}/steps/${qrun.body.steps[0].id}/decision`).set(CSRF).send({ decision: 'approve' });
    const q = await systemPool.query(`SELECT status, reason, quarantine_vlan FROM device_quarantines WHERE device_id = $1`, [printer]);
    expect(q.rows[0]).toMatchObject({ status: 'requested', reason: 'Isolated by playbook', quarantine_vlan: 99 });
    const qc = (await portCommands(c)).cmds.find((x: any) => x.payload.if_index === 2);
    expect(qc.payload).toMatchObject({ if_index: 2, op: 'access_vlan', vlan: 99 });
  });
});
