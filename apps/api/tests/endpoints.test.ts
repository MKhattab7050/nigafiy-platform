import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, addScope, app, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

describe('endpoint management and remote administration (Phases 3 & 4)', () => {
  it('enrolls an endpoint, auto-links it to its discovered LAN device, ingests health + inventory, and isolates tenants', async () => {
    const a = await newAccount('ep-a');
    const b = await newAccount('ep-b');
    const scopeId = await addScope(a, '192.168.10.0/24');
    const c = await newCollector(a);
    await heartbeat(c, { gateway_ip: '192.168.10.1' });
    await telemetry(c, [
      sweep(scopeId, [{ ip: '192.168.10.50', mac: '00:11:22:33:44:55', hostname: 'workstation-1' }]),
    ]);

    const devices = (await a.agent.get('/api/v1/devices')).body.items as { id: string; current_ip: string }[];
    const lanDevice = devices.find((d) => d.current_ip === '192.168.10.50')!;
    expect(lanDevice).toBeDefined();

    // Admin creates an endpoint
    const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({
      site_id: a.siteId,
      name: 'Accounting PC 1',
    });
    expect(created.status).toBe(201);
    const epId: string = created.body.endpoint.id;
    const token: string = created.body.enrollment_token;
    expect(token.startsWith('ldea_')).toBe(true);

    // Agent enrolls using the single-use token and gets linked to lanDevice by MAC
    const enrolled = await request(app).post('/api/v1/agent/enroll').send({
      enrollment_token: token,
      hostname: 'WORKSTATION-1',
      agent_version: '0.1.0',
      os: 'windows',
      os_version: 'Microsoft Windows 11 Pro',
      arch: 'amd64',
      cpu_model: 'Intel Core i7',
      cpu_cores: 8,
      ram_total_mb: 16384,
      primary_ip: '192.168.10.50',
      primary_mac: '00:11:22:33:44:55',
    });
    expect(enrolled.status).toBe(201);
    const cred: string = enrolled.body.credential;
    expect(cred.startsWith(`lda_${epId}.`)).toBe(true);

    // Token is single-use
    const replay = await request(app).post('/api/v1/agent/enroll').send({
      enrollment_token: token,
      hostname: 'SPOOF',
      agent_version: '0.1.0',
      os: 'windows',
      arch: 'amd64',
    });
    expect(replay.status).toBe(401);

    // Agent sends heartbeat and full inventory
    const hb = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${cred}`)
      .send({
        agent_version: '0.1.0',
        hostname: 'WORKSTATION-1',
        os: 'windows',
        arch: 'amd64',
        uptime_seconds: 7200,
        logged_in_users: ['CONTOSO\\ahmed'],
        primary_ip: '192.168.10.50',
        primary_mac: '00:11:22:33:44:55',
        cpu_pct: 18.4,
        ram_used_mb: 6144,
        ram_pct: 37.5,
        disk_used_pct: 62.0,
      });
    expect(hb.status).toBe(200);

    const inv = await request(app)
      .post('/api/v1/agent/inventory')
      .set('Authorization', `Bearer ${cred}`)
      .send({
        disks: [{ mount: 'C:', filesystem: 'NTFS', total_gb: 500, used_gb: 310, free_gb: 190, used_pct: 62 }],
        interfaces: [{ name: 'Ethernet', mac: '00:11:22:33:44:55', addresses: ['192.168.10.50/24'] }],
        processes: [{ pid: 4120, name: 'excel.exe', cpu_pct: 4.2, mem_mb: 280, user: 'ahmed' }],
        services: [{ name: 'Spooler', display_name: 'Print Spooler', state: 'running', start_mode: 'auto' }],
        software: [{ name: '7-Zip 24.08', version: '24.08', publisher: 'Igor Pavlov' }],
        connections: [{ proto: 'tcp', local_address: '192.168.10.50', local_port: 51200, remote_address: '192.168.10.1', remote_port: 443, state: 'ESTABLISHED', pid: 4120, process_name: 'excel.exe' }],
      });
    expect(inv.status).toBe(200);

    // Tenant B cannot see Tenant A's endpoint
    expect((await b.agent.get(`/api/v1/endpoints/${epId}`)).status).toBe(404);
    expect((await b.agent.get('/api/v1/endpoints')).body.items).toHaveLength(0);

    // Tenant A reads full endpoint detail and series
    const detail = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.device_id).toBe(lanDevice.id);
    expect(detail.body.connection_state).toBe('online');
    expect(detail.body.logged_in_users).toEqual(['CONTOSO\\ahmed']);
    expect(detail.body.processes).toHaveLength(1);
    expect(detail.body.services[0].name).toBe('Spooler');
    expect(detail.body.software[0].name).toBe('7-Zip 24.08');
    expect(detail.body.connections[0].process_name).toBe('excel.exe');

    const series = await a.agent.get(`/api/v1/endpoints/${epId}/series?range=1h`);
    expect(series.status).toBe(200);
    expect(series.body.points.length).toBeGreaterThanOrEqual(1);
  });

  it('enforces role permissions for remote control commands, delivers them on heartbeat, and records results + revocation', async () => {
    const a = await newAccount('ep-ctrl');
    const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Reception PC' });
    const epId: string = created.body.endpoint.id;
    const enrolled = await request(app).post('/api/v1/agent/enroll').send({
      enrollment_token: created.body.enrollment_token,
      hostname: 'RECEPTION',
      agent_version: '0.1.0',
      os: 'windows',
      arch: 'amd64',
    });
    const cred: string = enrolled.body.credential;

    await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send({
      agent_version: '0.1.0',
      hostname: 'RECEPTION',
      os: 'windows',
      arch: 'amd64',
      uptime_seconds: 100,
      cpu_pct: 5,
      ram_used_mb: 1024,
      ram_pct: 25,
    });

    // Viewer cannot run any remote command
    await setRole(a.email, a.organizationId, 'viewer');
    const viewerKill = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({
      kind: 'kill_process',
      pid: 1234,
    });
    expect(viewerKill.status).toBe(403);

    // Technician can kill a process, control a service, lock workstation, or message user, but cannot reboot/shutdown
    await setRole(a.email, a.organizationId, 'technician');
    const techReboot = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({
      kind: 'power_action',
      action: 'restart',
    });
    expect(techReboot.status).toBe(403);

    const techKill = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({
      kind: 'kill_process',
      pid: 4120,
      name: 'excel.exe',
    });
    expect(techKill.status).toBe(202);
    const cmdId: string = techKill.body.id;

    // Admin can request restart
    await setRole(a.email, a.organizationId, 'admin');
    const adminReboot = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({
      kind: 'power_action',
      action: 'restart',
      reason: 'Security patch',
    });
    expect(adminReboot.status).toBe(202);

    // Agent polls heartbeat, receives commands, and reports completion on next heartbeat
    const pollHb = await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send({
      agent_version: '0.1.0',
      hostname: 'RECEPTION',
      os: 'windows',
      arch: 'amd64',
      uptime_seconds: 120,
      cpu_pct: 5,
      ram_used_mb: 1024,
      ram_pct: 25,
    });
    expect(pollHb.body.commands.length).toBe(2);

    // At most once: the restart is not handed out again (an agent restarted by it would reboot again).
    const nextHb = await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send({
      agent_version: '0.1.0',
      hostname: 'RECEPTION',
      os: 'windows',
      arch: 'amd64',
      uptime_seconds: 5,
      cpu_pct: 5,
      ram_used_mb: 1024,
      ram_pct: 25,
    });
    expect(nextHb.body.commands).toHaveLength(0);

    await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send({
      agent_version: '0.1.0',
      hostname: 'RECEPTION',
      os: 'windows',
      arch: 'amd64',
      uptime_seconds: 140,
      cpu_pct: 4,
      ram_used_mb: 980,
      ram_pct: 24,
      command_results: [{ id: cmdId, ok: true, output: 'Terminated PID 4120' }],
    });

    const detail = await a.agent.get(`/api/v1/endpoints/${epId}`);
    const completedCmd = (detail.body.commands as { id: string; status: string; output: string }[]).find((c) => c.id === cmdId);
    expect(completedCmd?.status).toBe('completed');
    expect(completedCmd?.output).toBe('Terminated PID 4120');

    // Revoking immediately blocks the agent's credential
    const revoke = await a.agent.post(`/api/v1/endpoints/${epId}/revoke`).set(CSRF);
    expect(revoke.status).toBe(200);
    const afterRevoke = await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send({
      agent_version: '0.1.0',
      hostname: 'RECEPTION',
      os: 'windows',
      arch: 'amd64',
      uptime_seconds: 160,
      cpu_pct: 4,
      ram_used_mb: 980,
      ram_pct: 24,
    });
    expect(afterRevoke.status).toBe(401);
  });

  it('supports Remote File Manager, Remote Desktop sessions, fast /poll + /command-result, and policy restrictions', async () => {
    const a = await newAccount('ep-phase4');
    const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({
      site_id: a.siteId,
      name: 'Engineering Workstation',
      platform: 'windows',
    });
    const epId: string = created.body.endpoint.id;
    const enrolled = await request(app).post('/api/v1/agent/enroll').send({
      enrollment_token: created.body.enrollment_token,
      hostname: 'ENG-WS-01',
      agent_version: '0.2.0',
      os: 'windows',
      arch: 'amd64',
      manufacturer: 'Dell Inc.',
      model: 'Precision 5680',
      serial_number: 'DL-5680-991',
      security: { firewall_enabled: true, antivirus_enabled: true },
    });
    const cred: string = enrolled.body.credential;

    await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send({
      agent_version: '0.2.0',
      hostname: 'ENG-WS-01',
      os: 'windows',
      arch: 'amd64',
      uptime_seconds: 600,
      cpu_pct: 12,
      ram_used_mb: 4096,
      ram_pct: 25,
    });

    // Configure policy with allowed_fs_roots
    const policyRes = await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({
      allowed_fs_roots: ['C:\\Users\\Public', 'D:\\Shared'],
      remote_desktop_consent: 'unattended',
    });
    expect(policyRes.status).toBe(200);
    expect(policyRes.body.policy.allowed_fs_roots).toEqual(['C:\\Users\\Public', 'D:\\Shared']);

    // Destructive file delete without confirm_destructive is rejected with 400
    const unconfirmedDel = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({
      kind: 'fs_op',
      op: 'delete',
      path: 'C:\\Users\\Public\\old.log',
      confirm_destructive: false,
    });
    expect(unconfirmedDel.status).toBe(400);

    // Queue a file list command; policy allowed_fs_roots is automatically injected
    const listCmd = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({
      kind: 'fs_op',
      op: 'list',
      path: 'C:\\Users\\Public',
    });
    expect(listCmd.status).toBe(202);

    // Agent polls via fast /poll endpoint
    const fastPoll = await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({});
    expect(fastPoll.status).toBe(200);
    expect(fastPoll.body.commands).toHaveLength(1);
    expect(fastPoll.body.commands[0].payload.allowed_roots).toEqual(['C:\\Users\\Public', 'D:\\Shared']);

    // Agent posts structured directory listing to /command-result
    const cmdResult = await request(app)
      .post('/api/v1/agent/command-result')
      .set('Authorization', `Bearer ${cred}`)
      .send({
        command_results: [
          {
            id: listCmd.body.id,
            ok: true,
            output: 'File operation list completed',
            data: {
              op: 'list',
              path: 'C:\\Users\\Public',
              entries: [{ name: 'Documents', path: 'C:\\Users\\Public\\Documents', is_dir: true, ext: '', size: 0, mode: 'drwxr-xr-x', mod_time: new Date().toISOString(), is_hidden: false, is_system: false }],
            },
          },
        ],
      });
    expect(cmdResult.status).toBe(200);

    // No silent screen capture or input: both need a started session.
    const silentCapture = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_capture' });
    expect(silentCapture.status).toBe(409);
    expect(silentCapture.body.error.code).toBe('no_remote_session');
    const silentInput = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_input', event_kind: 'text', text: 'x' });
    expect(silentInput.status).toBe(409);

    // A policy that demands the user's consent is refused: the agent cannot ask for it.
    await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({ remote_desktop_consent: 'prompt' });
    const refused = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('consent_unavailable');
    await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({ remote_desktop_consent: 'unattended' });

    // Start a Remote Desktop session
    const rdStart = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({
      display_index: 0,
      quality: 70,
      scale: 0.75,
      recording_enabled: false,
    });
    expect(rdStart.status).toBe(200);
    expect(rdStart.body.session.operator_email).toBe(a.email);

    // Agent polls and returns a captured JPEG frame
    const rdPoll = await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({});
    const rdCmd = rdPoll.body.commands.find((c: { kind: string }) => c.kind === 'rd_capture');
    expect(rdCmd).toBeDefined();
    // The person at the screen is told who is viewing.
    const notice = rdPoll.body.commands.find((c: { kind: string }) => c.kind === 'notify_user');
    expect(notice?.payload.message).toContain(a.email);

    // Typed text and uploaded file contents never reach the audit log, events or the command history.
    const typed = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_input', event_kind: 'text', text: 'hunter2-secret' });
    expect(typed.status).toBe(202);
    const upload = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({
      kind: 'fs_op',
      op: 'upload',
      path: 'C:\\Users\\Public\\notes.txt',
      data_base64: Buffer.from('confidential-file-body').toString('base64'),
    });
    expect(upload.status).toBe(202);
    const leaks = await systemPool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM audit_logs WHERE metadata::text LIKE '%hunter2%' OR metadata::text LIKE $1)::int
            + (SELECT count(*) FROM network_events WHERE details::text LIKE '%hunter2%' OR details::text LIKE $1)::int AS n`,
      [`%${Buffer.from('confidential-file-body').toString('base64')}%`],
    );
    expect(leaks.rows[0]!.n).toBe(0);
    // …while the actions themselves are still audited (proves the query above can see these rows).
    const audited = await systemPool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs WHERE target_id = $1 AND action IN ('endpoint.rd_input', 'endpoint.fs_op') ORDER BY created_at`,
      [epId],
    );
    expect(audited.rows.find((r) => r.action === 'endpoint.rd_input')?.metadata.text).toBe('[14 characters redacted]');
    expect(audited.rows.find((r) => r.metadata.op === 'upload')?.metadata.data_bytes).toBe(22);
    const history = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(JSON.stringify(history.body.commands)).not.toContain('hunter2');

    await request(app)
      .post('/api/v1/agent/command-result')
      .set('Authorization', `Bearer ${cred}`)
      .send({
        command_results: [
          {
            id: rdCmd.id,
            ok: true,
            output: 'Captured frame 1280x720',
            data: {
              display_index: 0,
              displays: [{ index: 0, name: 'Primary Display (1)', x: 0, y: 0, width: 1920, height: 1080, primary: true }],
              width: 1280,
              height: 720,
              source_width: 1920,
              source_height: 1080,
              quality: 70,
              scale: 0.75,
              capture_ms: 14,
              byte_length: 1200,
              capture_mode: 'native_gdi',
              jpeg_base64: '/9j/4AAQSkZJRgABAQAAAQABAAD/',
              captured_at: new Date().toISOString(),
            },
          },
        ],
      });

    const detail = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.last_rd_frame?.width).toBe(1280);
    expect(detail.body.rd_session?.operator_email).toBe(a.email);
    expect(detail.body.capabilities.some((c: { key: string; enabled: boolean }) => c.key === 'remote_file_manager' && c.enabled)).toBe(true);

    // Stop Remote Desktop session
    const rdStop = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
    expect(rdStop.status).toBe(200);
  });

  it('enforces platform capability boundaries for Android Enterprise and Apple iOS MDM devices', async () => {
    const a = await newAccount('ep-mobile');

    // 1. Create Android Enterprise Device Owner endpoint
    const androidCreated = await a.agent.post('/api/v1/endpoints').set(CSRF).send({
      site_id: a.siteId,
      name: 'Warehouse Scanner Galaxy',
      platform: 'android',
      management_mode: 'android_device_owner',
    });
    expect(androidCreated.status).toBe(201);
    expect(androidCreated.body.android_provisioning).toBeDefined();
    expect(androidCreated.body.android_provisioning['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'].enrollment_token).toBe(
      androidCreated.body.enrollment_token,
    );

    const androidEnrolled = await request(app).post('/api/v1/agent/mdm/connect').send({
      enrollment_token: androidCreated.body.enrollment_token,
      device_name: 'Galaxy-Tab-Active4',
      os: 'android',
      os_version: 'Android 14',
      manufacturer: 'Samsung',
      model: 'SM-T636B',
      serial_number: 'R52W90ABC',
      security_patch_level: '2026-10-01',
      battery_pct: 84,
      battery_charging: true,
      storage_total_gb: 128,
      storage_used_gb: 42,
      device_owner: true,
      passcode_compliant: true,
      apps: [{ name: 'Warehouse WMS', version: '4.2.1', publisher: 'Internal IT' }],
    });
    expect(androidEnrolled.status).toBe(201);

    // Android rejects Windows-style service_action
    const androidSvc = await a.agent.post(`/api/v1/endpoints/${androidCreated.body.endpoint.id}/commands`).set(CSRF).send({
      kind: 'service_action',
      service: 'Spooler',
      action: 'restart',
    });
    expect(androidSvc.status).toBe(409);

    // Android Device Owner accepts mobile_action lock_device
    const androidLock = await a.agent.post(`/api/v1/endpoints/${androidCreated.body.endpoint.id}/commands`).set(CSRF).send({
      kind: 'mobile_action',
      action: 'lock_device',
    });
    expect(androidLock.status).toBe(202);

    // 2. Create Apple iOS BYOD MDM endpoint (not supervised)
    const iosCreated = await a.agent.post('/api/v1/endpoints').set(CSRF).send({
      site_id: a.siteId,
      name: 'Executive iPhone 16',
      platform: 'ios',
      management_mode: 'ios_byod_mdm',
    });
    expect(iosCreated.status).toBe(201);
    expect(iosCreated.body.apple_mdm_profile_url).toContain('.mobileconfig');

    // Download .mobileconfig profile
    const profileRes = await a.agent.get(iosCreated.body.apple_mdm_profile_url);
    expect(profileRes.status).toBe(200);
    expect(profileRes.text).toContain('PayloadType');
    expect(profileRes.text).toContain('com.apple.security.passcode');

    // Enroll iOS device via /mdm/connect
    const iosEnrolled = await request(app).post('/api/v1/agent/mdm/connect').send({
      enrollment_token: iosCreated.body.enrollment_token,
      device_name: 'iPhone-16-Pro',
      os: 'ios',
      os_version: 'iOS 18.1',
      manufacturer: 'Apple Inc.',
      model: 'iPhone17,1',
      serial_number: 'F2L99887766',
      battery_pct: 91,
      battery_charging: false,
      storage_total_gb: 256,
      storage_used_gb: 94,
      supervised: false,
      passcode_compliant: true,
    });
    expect(iosEnrolled.status).toBe(201);

    const iosId: string = iosCreated.body.endpoint.id;
    const iosDetail = await a.agent.get(`/api/v1/endpoints/${iosId}`);
    expect(iosDetail.status).toBe(200);
    const rdCap = iosDetail.body.capabilities.find((c: { key: string }) => c.key === 'remote_desktop');
    expect(rdCap?.state).toBe('unsupported_by_os');
    expect(rdCap?.enabled).toBe(false);

    // iOS strictly rejects remote desktop, file manager, and process kill
    expect(
      (await a.agent.post(`/api/v1/endpoints/${iosId}/remote-desktop/start`).set(CSRF).send({})).status,
    ).toBe(409);
    expect(
      (await a.agent.post(`/api/v1/endpoints/${iosId}/commands`).set(CSRF).send({ kind: 'fs_op', op: 'roots' })).status,
    ).toBe(409);
    expect(
      (await a.agent.post(`/api/v1/endpoints/${iosId}/commands`).set(CSRF).send({ kind: 'kill_process', pid: 100 })).status,
    ).toBe(409);

    // Non-supervised iOS rejects Managed Lost Mode (409 requires_supervision), but accepts Device Lock (202)
    expect(
      (
        await a.agent
          .post(`/api/v1/endpoints/${iosId}/commands`)
          .set(CSRF)
          .send({ kind: 'mobile_action', action: 'enable_lost_mode', lost_message: 'Return to IT' })
      ).status,
    ).toBe(409);

    expect(
      (
        await a.agent
          .post(`/api/v1/endpoints/${iosId}/commands`)
          .set(CSRF)
          .send({ kind: 'mobile_action', action: 'lock_device' })
      ).status,
    ).toBe(202);
  });
});

