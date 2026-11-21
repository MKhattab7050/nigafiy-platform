import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { expectedForFinding } from '../src/modules/security/routes.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

const at = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();

function dhcpRun(offers: { server_id: string; routers?: string[]; server_mac?: string }[], secondsAgo = 0, trigger = 'scheduled') {
  return {
    type: 'smart_check',
    ts: at(secondsAgo),
    run_id: randomUUID(),
    check: 'rogue_dhcp',
    trigger,
    ok: true,
    duration_ms: 4000,
    dhcp: {
      interfaces: [
        {
          name: 'Ethernet',
          address: '192.168.1.20',
          mac: '00:11:22:33:44:55',
          listen_seconds: 4,
          offers: offers.map((o) => ({ server_id: o.server_id, source_ip: o.server_id, offered_ip: '192.168.1.77', routers: o.routers ?? [o.server_id], dns: ['192.168.1.1'], lease_seconds: 86400, ...(o.server_mac ? { server_mac: o.server_mac } : {}) })),
        },
      ],
    },
  };
}

describe('smart checks (Phase 5)', () => {
  it('delivers the schedule and run-now requests in the heartbeat, with roles and an online collector required', async () => {
    const a = await newAccount('smart-sched');
    const none = await a.agent.post('/api/v1/security/run').set(CSRF).send({ site_id: a.siteId, checks: ['upnp'] });
    expect(none.status).toBe(409);

    const c = await newCollector(a);
    const hb = await heartbeat(c, { gateway_ip: '192.168.1.1' });
    expect(hb.status).toBe(200);
    const smart = hb.body.config.smart_checks;
    expect(smart.rogue_dhcp).toMatchObject({ enabled: true, interval_seconds: 900, listen_seconds: 4 });
    expect(smart.upnp).toMatchObject({ enabled: true, interval_seconds: 3600 });
    expect(smart.wifi).toMatchObject({ enabled: true, interval_seconds: 600 });
    expect(smart.banners.ports).toEqual([80, 443, 8080, 8443]);
    expect(smart.run_now).toEqual([]);

    const bad = await a.agent.post('/api/v1/security/run').set(CSRF).send({ site_id: a.siteId, checks: ['dhcp_fingerprints'] });
    expect(bad.status).toBe(400);
    const run = await a.agent.post('/api/v1/security/run').set(CSRF).send({ site_id: a.siteId, checks: ['upnp', 'wifi'] });
    expect(run.status).toBe(202);
    const hb2 = await heartbeat(c);
    expect(hb2.body.config.smart_checks.run_now.map((r: { check: string }) => r.check)).toEqual(['upnp', 'wifi']);

    // A run of the check answers the request.
    const upnp = { type: 'smart_check', ts: at(), run_id: randomUUID(), check: 'upnp', trigger: 'manual', ok: true, upnp: { gateways: [] } };
    expect((await telemetry(c, [upnp])).body.accepted).toBe(1);
    const hb3 = await heartbeat(c);
    expect(hb3.body.config.smart_checks.run_now.map((r: { check: string }) => r.check)).toEqual(['wifi']);

    // The schedule follows the automation settings.
    const put = await a.agent.put('/api/v1/automation/smart.wifi_analyzer').set(CSRF).send({ site_id: a.siteId, enabled: false });
    expect(put.status).toBe(200);
    const schedule = await a.agent.get(`/api/v1/security/schedule?site_id=${a.siteId}`);
    expect(schedule.body.items.find((i: { check: string }) => i.check === 'wifi')).toMatchObject({ enabled: false, automation_key: 'smart.wifi_analyzer' });

    const audit = await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action = 'security.run_now'`, [a.organizationId]);
    expect(audit.rowCount).toBe(1);

    await setRole(a.email, a.organizationId, 'viewer');
    const viewer = await a.agent.post('/api/v1/security/run').set(CSRF).send({ site_id: a.siteId, checks: ['upnp'] });
    expect(viewer.status).toBe(403);
  });

  it('detects a rogue DHCP server, opens an incident, and clears it when marked as expected', async () => {
    const a = await newAccount('smart-dhcp');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.1.1' });

    // First probe: only the gateway answers → expected (it is the gateway), nothing to report.
    expect((await telemetry(c, [dhcpRun([{ server_id: '192.168.1.1' }], 120)])).body.accepted).toBe(1);
    let view = await a.agent.get(`/api/v1/security?site_id=${a.siteId}`);
    expect(view.status).toBe(200);
    expect(view.body.dhcp.servers).toHaveLength(1);
    expect(view.body.dhcp.servers[0]).toMatchObject({ server_id: '192.168.1.1', expected: 'gateway' });
    expect(view.body.findings).toHaveLength(0);
    expect(view.body.runs[0]).toMatchObject({ check_kind: 'rogue_dhcp', ok: true });

    // A second server answers, handing out itself as gateway.
    await telemetry(c, [dhcpRun([{ server_id: '192.168.1.1' }, { server_id: '192.168.1.66', server_mac: 'AA-BB-CC-00-11-22' }], 60)]);
    view = await a.agent.get(`/api/v1/security?site_id=${a.siteId}`);
    const rogue = view.body.findings.find((f: { kind: string }) => f.kind === 'dhcp_rogue_server');
    expect(rogue).toMatchObject({ severity: 'critical', key: '192.168.1.66', status: 'open' });
    expect(rogue.details.gateway_mismatch).toBe(true);
    const incident = await systemPool.query(`SELECT id, status FROM incidents WHERE organization_id = $1 AND kind = 'dhcp'`, [a.organizationId]);
    expect(incident.rows[0]?.status).toBe('open');

    // Network Doctor surfaces it.
    const doctor = await a.agent.get(`/api/v1/doctor?site_id=${a.siteId}`);
    expect(doctor.body.items[0].smart.map((d: { rule: string }) => d.rule)).toContain('dhcp-rogue-server');

    // Acknowledge (technician) then approve (admin only).
    const ack = await a.agent.post(`/api/v1/security/findings/${rogue.id}/acknowledge`).set(CSRF).send({});
    expect(ack.status).toBe(200);
    const approve = await a.agent.post(`/api/v1/security/findings/${rogue.id}/expected`).set(CSRF).send({ note: 'Guest Wi-Fi router' });
    expect(approve.status).toBe(201);
    expect(approve.body).toMatchObject({ kind: 'dhcp_server', value: '192.168.1.66' });
    view = await a.agent.get(`/api/v1/security?site_id=${a.siteId}`);
    expect(view.body.findings.filter((f: { kind: string }) => f.kind === 'dhcp_rogue_server')).toHaveLength(0);
    expect(view.body.dhcp.servers.find((s: { server_id: string }) => s.server_id === '192.168.1.66')).toMatchObject({ expected: 'admin', rogue_open: false });
    const after = await systemPool.query(`SELECT status FROM incidents WHERE id = $1`, [incident.rows[0]!.id]);
    expect(after.rows[0]!.status).toBe('resolved');

    // Withdrawing the approval makes it a rogue again.
    const del = await a.agent.delete(`/api/v1/security/expected/${approve.body.id}`).set(CSRF);
    expect(del.status).toBe(200);
    const reopened = await a.agent.get(`/api/v1/security/findings?site_id=${a.siteId}&category=dhcp`);
    expect(reopened.body.items.map((f: { key: string }) => f.key)).toContain('192.168.1.66');

    const actions = await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'security.%' ORDER BY created_at`, [a.organizationId]);
    expect(actions.rows.map((r) => r.action)).toEqual(['security.finding_acknowledge', 'security.expected_add', 'security.expected_remove']);

    // Tenant isolation: another organization can neither see nor change it.
    const other = await newAccount('smart-other');
    const peek = await other.agent.get(`/api/v1/security/findings?site_id=${a.siteId}`);
    expect(peek.body.items).toHaveLength(0);
    const steal = await other.agent.post(`/api/v1/security/findings/${rogue.id}/resolve`).set(CSRF).send({});
    expect(steal.status).toBe(404);
  });

  it('reports "no DHCP offer" after two silent probes and records a probe that could not listen without judging', async () => {
    const a = await newAccount('smart-nooffer');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.1.1' });
    await telemetry(c, [dhcpRun([{ server_id: '192.168.1.1' }], 300)]);
    const failed = {
      type: 'smart_check',
      ts: at(250),
      run_id: randomUUID(),
      check: 'rogue_dhcp',
      trigger: 'scheduled',
      ok: false,
      error: { kind: 'listen_failed', message: 'bind udp 0.0.0.0:68: address in use' },
      dhcp: { interfaces: [{ name: 'Ethernet', address: '192.168.1.20', listen_error: 'address in use', offers: [] }] },
    };
    expect((await telemetry(c, [failed])).body.accepted).toBe(1);
    let state = await systemPool.query(`SELECT consecutive_no_offer, probes FROM dhcp_probe_state WHERE site_id = $1`, [a.siteId]);
    expect(state.rows[0]).toMatchObject({ consecutive_no_offer: 0, probes: 1 });

    await telemetry(c, [dhcpRun([], 200), dhcpRun([], 100)]);
    let findings = await a.agent.get(`/api/v1/security/findings?site_id=${a.siteId}`);
    expect(findings.body.items.map((f: { kind: string }) => f.kind)).toEqual(['dhcp_no_offer']);
    const events = await systemPool.query(`SELECT type FROM network_events WHERE organization_id = $1 AND type LIKE 'dhcp%'`, [a.organizationId]);
    expect(events.rows.map((r) => r.type)).toEqual(['dhcp_no_offer']);

    await telemetry(c, [dhcpRun([{ server_id: '192.168.1.1' }], 50)]);
    findings = await a.agent.get(`/api/v1/security/findings?site_id=${a.siteId}`);
    expect(findings.body.items).toHaveLength(0);
    state = await systemPool.query(`SELECT no_offer_open FROM dhcp_probe_state WHERE site_id = $1`, [a.siteId]);
    expect(state.rows[0]!.no_offer_open).toBe(false);
  });

  it('audits UPnP port forwards, flags risky ones and resolves them when they disappear', async () => {
    const a = await newAccount('smart-upnp');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.1.1' });
    const report = (mappings: unknown[]) => ({
      type: 'smart_check',
      ts: at(),
      run_id: randomUUID(),
      check: 'upnp',
      trigger: 'scheduled',
      ok: true,
      upnp: { gateways: [{ address: '192.168.1.1', friendly_name: 'Office router', external_ip: '203.0.113.9', service_type: 'urn:schemas-upnp-org:service:WANIPConnection:1', mappings }] },
    });
    const rdp = { protocol: 'TCP', external_port: 3389, internal_client: '192.168.1.50', internal_port: 3389, description: 'rdp', enabled: true };
    const game = { protocol: 'UDP', external_port: 3074, internal_client: '192.168.1.60', internal_port: 3074, description: 'Xbox', enabled: true };
    expect((await telemetry(c, [report([rdp, game])])).body.accepted).toBe(1);
    let view = await a.agent.get(`/api/v1/security?site_id=${a.siteId}`);
    expect(view.body.upnp.gateways[0].mappings).toHaveLength(2);
    expect(view.body.upnp.gateways[0].mappings[0]).toMatchObject({ external_port: 3389, risk: 'critical' });
    const kinds = view.body.findings.map((f: { kind: string; severity: string }) => `${f.kind}:${f.severity}`).sort();
    expect(kinds).toEqual(['upnp_igd_enabled:info', 'upnp_risky_mapping:critical']);
    const risky = view.body.findings.find((f: { kind: string }) => f.kind === 'upnp_risky_mapping');
    expect(expectedForFinding(risky)).toEqual({ kind: 'upnp_mapping', value: '192.168.1.1|TCP|3389|192.168.1.50:3389' });

    await telemetry(c, [report([game])]);
    view = await a.agent.get(`/api/v1/security?site_id=${a.siteId}`);
    expect(view.body.upnp.gateways[0].mappings).toHaveLength(1);
    expect(view.body.findings.map((f: { kind: string }) => f.kind)).toEqual(['upnp_igd_enabled']);
    const resolved = await a.agent.get(`/api/v1/security/findings?site_id=${a.siteId}&status=resolved`);
    expect(resolved.body.items[0]).toMatchObject({ kind: 'upnp_risky_mapping', resolution: 'No longer listed by the gateway' });

    // Rejected by the protocol: a mapping to a non-IPv4 client.
    const bad = await telemetry(c, [report([{ ...rdp, internal_client: 'evil.example' }])]);
    expect(bad.status).toBe(400);
  });

  it('analyses the collector’s Wi-Fi: weak signal, congestion and a look-alike access point', async () => {
    const a = await newAccount('smart-wifi');
    const c = await newCollector(a);
    await heartbeat(c);
    const neighbours = Array.from({ length: 6 }, (_, i) => ({ ssid: `Neighbour-${i}`, bssid: `10:20:30:40:50:${(i + 16).toString(16)}`, channel: 6, band: '2.4', signal_pct: 80, security: 'WPA2-Personal', auth: 'WPA2-PSK', cipher: 'CCMP' }));
    const item = {
      type: 'smart_check',
      ts: at(),
      run_id: randomUUID(),
      check: 'wifi',
      trigger: 'scheduled',
      ok: true,
      wifi: {
        platform: 'windows',
        interface: 'Wi-Fi',
        connected: true,
        link: { ssid: 'Office', bssid: '00:11:22:33:44:55', channel: 6, band: '2.4', signal_pct: 30, rssi_dbm: -85, rx_mbps: 6, tx_mbps: 6, security: 'WPA2-Personal', auth: 'WPA2-PSK', cipher: 'CCMP', phy: '802.11n' },
        networks: [...neighbours, { ssid: 'Office', bssid: '02:aa:bb:cc:dd:ee', channel: 1, band: '2.4', signal_pct: 70, security: 'Open', auth: 'Open', cipher: 'None' }],
      },
    };
    expect((await telemetry(c, [item])).body.accepted).toBe(1);
    const view = await a.agent.get(`/api/v1/security?site_id=${a.siteId}`);
    expect(view.body.wifi[0]).toMatchObject({ ssid: 'Office', channel: 6, rssi_dbm: -85 });
    expect(view.body.wifi[0].networks).toHaveLength(7);
    const kinds = view.body.findings.map((f: { kind: string }) => f.kind).sort();
    expect(kinds).toEqual(['wifi_congested_channel', 'wifi_evil_twin', 'wifi_low_rate', 'wifi_weak_signal']);
    const twin = view.body.findings.find((f: { kind: string }) => f.kind === 'wifi_evil_twin');
    expect(twin.severity).toBe('critical');
    expect(twin.details.collector).toBe('edge-1');

    const approve = await a.agent.post(`/api/v1/security/findings/${twin.id}/expected`).set(CSRF).send({});
    expect(approve.body).toMatchObject({ kind: 'wifi_bssid', value: '02:aa:bb:cc:dd:ee' });
    const left = await a.agent.get(`/api/v1/security/findings?site_id=${a.siteId}&category=wifi`);
    expect(left.body.items.map((f: { kind: string }) => f.kind)).not.toContain('wifi_evil_twin');

    const doctor = await a.agent.get(`/api/v1/doctor?site_id=${a.siteId}`);
    expect(doctor.body.items[0].smart.map((d: { rule: string }) => d.rule)).toEqual(expect.arrayContaining(['wifi-weak-signal', 'wifi-congested-channel']));

    // A collector without Wi-Fi reports that it could not measure; nothing is judged.
    const none = { type: 'smart_check', ts: at(), run_id: randomUUID(), check: 'wifi', trigger: 'scheduled', ok: false, error: { kind: 'no_interface', message: 'No Wi-Fi adapter' } };
    expect((await telemetry(c, [none])).body.accepted).toBe(1);
    const still = await a.agent.get(`/api/v1/security/findings?site_id=${a.siteId}&category=wifi`);
    expect(still.body.items.length).toBeGreaterThan(0);
  });

  it('identifies devices from web banners and DHCP fingerprints, never over a manual type', async () => {
    const a = await newAccount('smart-ident');
    const scopeId = await addScope(a, '192.168.1.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.1.1' });
    await telemetry(c, [
      sweep(scopeId, [
        { ip: '192.168.1.40', mac: '00:11:32:aa:bb:cc' },
        { ip: '192.168.1.41', mac: '00:1b:21:00:00:01' },
        { ip: '192.168.1.42', mac: '00:1b:21:00:00:02' },
      ]),
    ]);
    const hb = await heartbeat(c, { gateway_ip: '192.168.1.1' });
    expect(hb.body.config.smart_checks.banners.targets).toEqual(expect.arrayContaining(['192.168.1.40', '192.168.1.41', '192.168.1.42']));

    const devices = await systemPool.query<{ id: string; ip: string }>(`SELECT id, host(current_ip) AS ip FROM devices WHERE organization_id = $1`, [a.organizationId]);
    const id42 = devices.rows.find((d) => d.ip === '192.168.1.42')!.id;
    await systemPool.query(`UPDATE devices SET device_type = 'server', type_source = 'manual' WHERE id = $1`, [id42]);

    const banners = {
      type: 'smart_check',
      ts: at(),
      run_id: randomUUID(),
      check: 'banners',
      trigger: 'scheduled',
      ok: true,
      banners: {
        probed: ['192.168.1.40', '192.168.1.41', '192.168.1.42'],
        results: [
          { ip: '192.168.1.40', port: 5000, scheme: 'http', status: 200, title: 'Synology DiskStation', server: 'nginx' },
          { ip: '192.168.1.42', port: 80, scheme: 'http', status: 200, title: 'HP LaserJet MFP' },
        ],
      },
    };
    expect((await telemetry(c, [banners])).body.accepted).toBe(1);
    const typed = await systemPool.query<{ ip: string; device_type: string; type_source: string }>(
      `SELECT host(current_ip) AS ip, device_type, type_source FROM devices WHERE organization_id = $1 ORDER BY current_ip`,
      [a.organizationId],
    );
    expect(typed.rows.find((d) => d.ip === '192.168.1.40')).toMatchObject({ device_type: 'nas', type_source: 'inferred' });
    expect(typed.rows.find((d) => d.ip === '192.168.1.42')).toMatchObject({ device_type: 'server', type_source: 'manual' });
    // Probed devices are not handed out again within a day.
    const hb2 = await heartbeat(c, { gateway_ip: '192.168.1.1' });
    expect(hb2.body.config.smart_checks.banners.targets).toEqual([]);

    const fp = {
      type: 'smart_check',
      ts: at(),
      run_id: randomUUID(),
      check: 'dhcp_fingerprints',
      trigger: 'scheduled',
      ok: true,
      dhcp_fingerprints: {
        clients: [{ mac: '00:1b:21:00:00:01', prl: '1,3,6,15,31,33,43,44,46,47,119,121,249,252', vendor_class: 'MSFT 5.0', hostname: 'OFFICE-PC', server_id: '192.168.1.1', seen_at: at() }],
      },
    };
    expect((await telemetry(c, [fp])).body.accepted).toBe(1);
    const pc = await systemPool.query(`SELECT device_type, type_confidence FROM devices WHERE organization_id = $1 AND current_ip = '192.168.1.41'`, [a.organizationId]);
    expect(pc.rows[0]).toMatchObject({ device_type: 'windows_computer', type_confidence: 'high' });
    const view = await a.agent.get(`/api/v1/security?site_id=${a.siteId}`);
    expect(view.body.fingerprints[0]).toMatchObject({ mac: '00:1b:21:00:00:01', os_family: 'windows', confidence: 'high' });
    expect(view.body.dhcp.servers[0]).toMatchObject({ server_id: '192.168.1.1', clients_choosing: 1, expected: 'gateway' });
    expect(view.body.banners.map((b: { title: string }) => b.title)).toEqual(expect.arrayContaining(['Synology DiskStation']));

    const badPrl = { ...fp, run_id: randomUUID(), dhcp_fingerprints: { clients: [{ ...fp.dhcp_fingerprints.clients[0], prl: '1;rm -rf' }] } };
    expect((await telemetry(c, [badPrl])).status).toBe(400);
  });
});
