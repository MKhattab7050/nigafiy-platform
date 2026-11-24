import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { latestFrame } from '../src/modules/endpoints/remote-desktop/frames.ts';
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
    // Nothing reported yet: posture is unknown, not "compliant".
    expect(created.body.endpoint.compliance_status).toBe('unknown');
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

    // A policy that demands the user's consent: the session waits for the answer and nothing is
    // captured or controlled meanwhile (the consent flow itself is in fleet-pro.test.ts).
    await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({ remote_desktop_consent: 'prompt' });
    const asked = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
    expect(asked.status).toBe(200);
    expect(asked.body.session.state).toBe('waiting_consent');
    const early = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_capture' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('consent_pending');
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({})).status).toBe(200);
    await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({ remote_desktop_consent: 'unattended' });

    // Start a Remote Desktop session
    const rdStart = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({
      display_index: 0,
      quality: 70,
      scale: 0.75,
      recording_enabled: false,
      reason: 'Check the printer queue',
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
    expect(detail.body.last_rd_frame?.jpeg_base64).toBe('/9j/4AAQSkZJRgABAQAAAQABAAD/');
    expect(detail.body.rd_session?.operator_email).toBe(a.email);
    expect(detail.body.capabilities.some((c: { key: string; enabled: boolean }) => c.key === 'remote_file_manager' && c.enabled)).toBe(true);

    // The image is never written to PostgreSQL: the command row keeps the frame's metadata only,
    // and endpoints no longer has a last_rd_frame column.
    const stored = await systemPool.query<{ has_image: boolean; width: number; bytes: number }>(
      `SELECT result_data ? 'jpeg_base64' AS has_image, (result_data->>'width')::int AS width, (result_data->>'byte_length')::int AS bytes FROM endpoint_commands WHERE id = $1`,
      [rdCmd.id],
    );
    expect(stored.rows[0]).toEqual({ has_image: false, width: 1280, bytes: 1200 });
    const column = await systemPool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'endpoints' AND column_name = 'last_rd_frame'`);
    expect(column.rowCount).toBe(0);

    // A technician waiting on a capture gets the image from the transient relay.
    const frameData = (extra: Record<string, unknown>) => ({
      display_index: 0,
      displays: [{ index: 0, name: 'Primary Display (1)', x: 0, y: 0, width: 1920, height: 1080, primary: true }],
      width: 1280,
      height: 720,
      source_width: 1920,
      source_height: 1080,
      quality: 70,
      scale: 0.75,
      capture_ms: 9,
      capture_mode: 'native_gdi',
      captured_at: new Date().toISOString(),
      ...extra,
    });
    async function answerNextCapture(data: Record<string, unknown>): Promise<string> {
      for (let i = 0; i < 40; i++) {
        const poll = await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({});
        const cap = poll.body.commands.find((c: { kind: string }) => c.kind === 'rd_capture');
        if (cap) {
          await request(app).post('/api/v1/agent/command-result').set('Authorization', `Bearer ${cred}`).send({ command_results: [{ id: cap.id, ok: true, data }] });
          return cap.id as string;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no rd_capture was queued');
    }
    const bigImage = Buffer.alloc(30_000, 7).toString('base64'); // several pg_notify chunks
    const [waited, liveId] = await Promise.all([
      a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=4000`).set(CSRF).send({ kind: 'rd_capture', full_frame: true }),
      answerNextCapture(frameData({ byte_length: 30_000, jpeg_base64: bigImage })),
    ]);
    expect(waited.status).toBe(200);
    expect(waited.body.id).toBe(liveId);
    expect(waited.body.payload.full_frame).toBe(true);
    expect(waited.body.result_data.jpeg_base64).toBe(bigImage);
    const liveRow = await systemPool.query(`SELECT result_data ? 'jpeg_base64' AS has_image FROM endpoint_commands WHERE id = $1`, [liveId]);
    expect(liveRow.rows[0].has_image).toBe(false);

    // An unchanged screen: no image travels, the viewer keeps its picture.
    const [same] = await Promise.all([
      a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=4000`).set(CSRF).send({ kind: 'rd_capture' }),
      answerNextCapture(frameData({ byte_length: 0, unchanged: true })),
    ]);
    expect(same.status).toBe(200);
    expect(same.body.result_data).toMatchObject({ unchanged: true, width: 1280 });
    expect(same.body.result_data).not.toHaveProperty('jpeg_base64');

    // Viewers never get frames.
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get(`/api/v1/endpoints/${epId}`)).body.last_rd_frame).toBeNull();
    await setRole(a.email, a.organizationId, 'admin');

    // Stop Remote Desktop session: the frames are dropped, the session stays audited.
    const rdStop = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
    expect(rdStop.status).toBe(200);
    expect(latestFrame(epId)).toBeNull();
    expect((await a.agent.get(`/api/v1/endpoints/${epId}`)).body.last_rd_frame).toBeNull();
    const sessionAudit = await systemPool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1 AND action LIKE 'endpoint.remote_desktop_%' ORDER BY created_at`,
      [epId],
    );
    // The first pair is the session that waited for consent under the "prompt" policy.
    expect(sessionAudit.rows.map((r) => r.action)).toEqual(['endpoint.remote_desktop_started', 'endpoint.remote_desktop_stopped', 'endpoint.remote_desktop_started', 'endpoint.remote_desktop_stopped']);
    // A result arriving after the session ended (stop expired its capture) is not relayed.
    await request(app)
      .post('/api/v1/agent/command-result')
      .set('Authorization', `Bearer ${cred}`)
      .send({ command_results: [{ id: rdCmd.id, ok: true, data: frameData({ byte_length: 10, jpeg_base64: 'late' }) }] });
    expect(latestFrame(epId)).toBeNull();
  });

  it('supports only agent platforms, refuses option-like arguments, and keeps unmeasured security unknown', async () => {
    const a = await newAccount('ep-harden');

    // iOS/Android "MDM" was removed: neither the platforms nor the MDM routes exist.
    for (const platform of ['android', 'ios']) {
      const res = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Phone', platform });
      expect(res.status).toBe(400);
    }
    const mdm = await request(app).post('/api/v1/agent/mdm/connect').send({ enrollment_token: 'x'.repeat(30) });
    expect([403, 404]).toContain(mdm.status);

    const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Build box', platform: 'linux' });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('android_provisioning');
    expect(created.body).not.toHaveProperty('apple_mdm_profile_url');
    expect(created.body.endpoint).not.toHaveProperty('management_mode');
    const epId: string = created.body.endpoint.id;
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/apple-profile.mobileconfig`)).status).toBe(404);

    // An agent cannot claim mobile-only posture or switch to a mobile platform.
    const badEnroll = await request(app).post('/api/v1/agent/enroll').send({
      enrollment_token: created.body.enrollment_token,
      hostname: 'build-01',
      os: 'linux',
      arch: 'amd64',
      platform: 'ios',
    });
    expect(badEnroll.status).toBe(400);

    const enrolled = await request(app).post('/api/v1/agent/enroll').send({
      enrollment_token: created.body.enrollment_token,
      hostname: 'build-01',
      agent_version: '0.3.0',
      os: 'linux',
      arch: 'amd64',
    });
    expect(enrolled.status).toBe(201);
    const cred: string = enrolled.body.credential;
    const hb = (extra: Record<string, unknown>) =>
      request(app)
        .post('/api/v1/agent/heartbeat')
        .set('Authorization', `Bearer ${cred}`)
        .send({ agent_version: '0.3.0', hostname: 'build-01', os: 'linux', arch: 'amd64', cpu_pct: 3, ram_used_mb: 512, ram_pct: 10, ...extra });

    expect((await hb({ security: { rooted_or_jailbroken: true } })).status).toBe(400);

    // The firewall reported off is an attention item; once the agent stops reporting it, it is gone
    // (the posture is replaced, not merged with an old answer).
    expect((await hb({ security: { firewall_enabled: false } })).status).toBe(200);
    let detail = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(detail.body.compliance_status).toBe('attention');
    expect((await hb({ security: {} })).status).toBe(200);
    detail = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(detail.body.security).toEqual({});
    // Nothing measured: unknown, and every unmeasured item says so (never "compliant").
    expect(detail.body.compliance_status).toBe('unknown');
    expect(detail.body.compliance_reasons).toEqual([
      'Host firewall not measured: not reported by the agent',
      'Disk encryption not measured: not reported by the agent',
      'OS / security updates not measured: not reported by the agent',
      'Free disk space not measured: not reported by the agent',
    ]);

    // Values that would reach the agent as program arguments can never look like options.
    const send = (body: Record<string, unknown>) => a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send(body);
    expect((await send({ kind: 'software_action', action: 'install', package_id: '--allow-unauthenticated' })).status).toBe(400);
    expect((await send({ kind: 'service_action', service: '--force', action: 'stop' })).status).toBe(400);
    expect((await send({ kind: 'diagnostic_command', tool: 'nslookup', target: '-type=any' })).status).toBe(400);
    expect((await send({ kind: 'mobile_action', action: 'lock_device' })).status).toBe(400);

    // What this platform's agent cannot do is refused up front (sign-out now works on Linux: loginctl).
    expect((await send({ kind: 'power_action', action: 'logoff' })).status).toBe(202);
    expect((await send({ kind: 'diagnostic_command', tool: 'gpresult' })).status).toBe(409);
    expect((await send({ kind: 'diagnostic_command', tool: 'nslookup', target: 'example.com' })).status).toBe(202);

    // Uploading overwrites files on the endpoint, so it needs the same role as deleting them.
    await setRole(a.email, a.organizationId, 'technician');
    const techUpload = await send({ kind: 'fs_op', op: 'upload', path: '/tmp/x.txt', data_base64: 'aGk=' });
    expect(techUpload.status).toBe(403);
    expect((await send({ kind: 'fs_op', op: 'list', path: '/tmp' })).status).toBe(202);
  });
});

