import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { dispatchInstalls, runRebootTimers } from '../src/modules/endpoints/fleet-patches/service.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Fleet Pro (migration 043): patches. The agent reports what is missing; admins approve or decline
// (or a policy approves whole classifications); installs run only inside an open window, one per
// computer; the reboot policy then asks the person (with postponements up to a deadline), forces at
// the end of the window, or only shows "restart needed". Everything is audited; history stays.

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };

const pollFor = async (cred: string): Promise<Cmd[]> => (await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({})).body.commands;
const pending = async (epId: string, kind: string) =>
  (await systemPool.query<{ id: string; payload: Record<string, unknown>; status: string }>(`SELECT id, payload, status FROM endpoint_commands WHERE endpoint_id = $1 AND kind = $2 ORDER BY created_at, id`, [epId, kind])).rows;

async function answer(cred: string, id: string, ok: boolean, data?: Record<string, unknown>, error?: string) {
  const r = await request(app)
    .post('/api/v1/agent/command-result')
    .set('Authorization', `Bearer ${cred}`)
    .send({ command_results: [{ id, ok, output: '', ...(data ? { data } : {}), ...(error ? { error } : {}) }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const heartbeat = (cred: string, uptime = 3600) =>
  request(app)
    .post('/api/v1/agent/heartbeat')
    .set('Authorization', `Bearer ${cred}`)
    .send({ agent_version: '0.3.0', hostname: 'PATCH-PC', os: 'windows', arch: 'amd64', uptime_seconds: uptime, cpu_pct: 5, ram_used_mb: 1000, ram_pct: 20 });

const audits = async (orgId: string, action: string) =>
  (await systemPool.query<{ metadata: Record<string, unknown>; user_email: string | null }>(`SELECT metadata, user_email FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;

async function addMember(owner: TestAccount, role: 'admin' | 'technician' | 'viewer'): Promise<TestAccount> {
  const other = await newAccount(`patch-${role}`);
  const user = await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [other.email]);
  await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)`, [user.rows[0]!.id, owner.organizationId, role]);
  expect((await other.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: owner.organizationId })).status).toBe(200);
  return { ...other, organizationId: owner.organizationId, siteId: owner.siteId };
}

const UPDATES = [
  { update_id: '11111111-aaaa-4bbb-8ccc-000000000001', title: '2026-11 Cumulative Update for Windows 11 (KB5050001)', kb: 'KB5050001', classification: 'security', severity: 'Critical', size_bytes: 812345678, reboot_required: true },
  { update_id: '11111111-aaaa-4bbb-8ccc-000000000002', title: 'Security Intelligence Update for Microsoft Defender Antivirus - KB2267602', kb: 'KB2267602', classification: 'definition', size_bytes: 1582738008, reboot_required: false },
  { update_id: '11111111-aaaa-4bbb-8ccc-000000000003', title: 'Contoso driver update', classification: 'driver', reboot_required: true },
  { update_id: '11111111-aaaa-4bbb-8ccc-000000000004', title: 'Feature update to Windows 11, version 25H2', classification: 'upgrade', reboot_required: true },
];

const report = (cred: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/v1/agent/patch-status')
    .set('Authorization', `Bearer ${cred}`)
    .send({ source: 'wua', install_supported: true, scanned_at: new Date().toISOString(), reboot_pending: false, updates: UPDATES, ...extra });

/** A weekly group window that is open now (UTC, every day, started 10 minutes ago, 60 minutes). */
function openWindow() {
  const start = new Date(Date.now() - 10 * 60_000);
  const hh = String(start.getUTCHours()).padStart(2, '0');
  const mm = String(start.getUTCMinutes()).padStart(2, '0');
  return { window_kind: 'group', window_weekdays: [0, 1, 2, 3, 4, 5, 6], window_start: `${hh}:${mm}`, window_minutes: 60, window_timezone: 'UTC' };
}

const policy = (body: Record<string, unknown>) => ({ fleet_group_id: null, enabled: true, auto_approve: ['security'], reboot_policy: 'ask', max_postponements: 2, postpone_minutes: 30, reboot_deadline_hours: 8, ...openWindow(), ...body });

describe('fleet: patches', () => {
  it('stores the scan, shows decisions per update, and lets technicians ask for a scan (viewers read only)', async () => {
    const a = await newAccount('patch-read');
    const { epId, cred } = await onlineEndpoint(a, 'PATCH-PC');
    const viewer = await addMember(a, 'viewer');
    const tech = await addMember(a, 'technician');
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/patches`)).body.status).toBeNull();

    expect((await report(cred, { product_key: 'X' })).status).toBe(400);
    expect((await report(cred, { updates: [{ ...UPDATES[0], kb: 'KB12; rm' }] })).status).toBe(400);
    expect((await request(app).post('/api/v1/agent/patch-status').send({})).status).toBe(401);
    const r = await report(cred);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const d = (await viewer.agent.get(`/api/v1/endpoints/${epId}/patches`)).body;
    expect(d.status.source).toBe('wua');
    expect(d.status.updates.map((u: { approval: string }) => u.approval)).toEqual(['not_approved', 'not_approved', 'not_approved', 'not_approved']);
    expect(d.policy.enabled).toBe(false);
    const cat = (await viewer.agent.get('/api/v1/fleet/patches/catalog')).body.updates;
    expect(cat[0]).toMatchObject({ kb: 'KB5050001', missing_on: 1, source: 'wua' });

    expect((await viewer.agent.post(`/api/v1/endpoints/${epId}/patches/scan`).set(CSRF)).status).toBe(403);
    const scan = await tech.agent.post(`/api/v1/endpoints/${epId}/patches/scan`).set(CSRF);
    expect(scan.status).toBe(202);
    expect((await pending(epId, 'patch_scan'))).toHaveLength(1);
    expect((await audits(a.organizationId, 'endpoint.patch_scan_requested'))[0]!.user_email).toBe(tech.email);
    // A failed scan keeps the last list and shows the error.
    await report(cred, { updates: [], scan_error: 'Windows Update Agent: HRESULT 0x8024402C' });
    const after = (await a.agent.get(`/api/v1/endpoints/${epId}/patches`)).body.status;
    expect(after.updates).toHaveLength(4);
    expect(after.scan_error).toMatch(/0x8024402C/);
  });

  it('admins approve and decline (all groups or one); the details come from the agents; audited', async () => {
    const a = await newAccount('patch-approve');
    const { cred } = await onlineEndpoint(a, 'PATCH-PC');
    const tech = await addMember(a, 'technician');
    await report(cred);
    expect((await tech.agent.post('/api/v1/fleet/patches/approvals').set(CSRF).send({ update_id: UPDATES[2]!.update_id, decision: 'approved' })).status).toBe(403);
    expect((await a.agent.post('/api/v1/fleet/patches/approvals').set(CSRF).send({ update_id: 'never-seen', decision: 'approved' })).status).toBe(404);
    expect((await a.agent.post('/api/v1/fleet/patches/approvals').set(CSRF).send({ update_id: UPDATES[2]!.update_id, decision: 'approved', title: 'spoofed' })).status).toBe(400);
    const ok = await a.agent.post('/api/v1/fleet/patches/approvals').set(CSRF).send({ update_id: UPDATES[2]!.update_id, decision: 'approved' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.title).toBe('Contoso driver update');
    const g = (await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Servers' })).body.group;
    const declined = await a.agent.post('/api/v1/fleet/patches/approvals').set(CSRF).send({ update_id: UPDATES[2]!.update_id, decision: 'declined', fleet_group_id: g.id });
    expect(declined.status).toBe(201);
    const cat = (await a.agent.get('/api/v1/fleet/patches/catalog')).body.updates.find((u: { update_id: string }) => u.update_id === UPDATES[2]!.update_id);
    expect(cat.approvals.map((x: { decision: string }) => x.decision).sort()).toEqual(['approved', 'declined']);
    expect((await a.agent.delete(`/api/v1/fleet/patches/approvals/${declined.body.id}`).set(CSRF)).status).toBe(204);
    expect((await audits(a.organizationId, 'fleet.patch_approved'))[0]!.metadata).toMatchObject({ kb: null, title: 'Contoso driver update' });
    expect(await audits(a.organizationId, 'fleet.patch_declined')).toHaveLength(1);
    expect(await audits(a.organizationId, 'fleet.patch_approval_removed')).toHaveLength(1);
  });

  it('validates policies; group windows need every field; admins only', async () => {
    const a = await newAccount('patch-policy');
    const viewer = await addMember(a, 'viewer');
    expect((await viewer.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({}))).status).toBe(403);
    expect((await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({ window_start: null }))).status).toBe(400);
    expect((await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({ window_timezone: 'Mars/Olympus' }))).status).toBe(400);
    expect((await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({ auto_approve: ['everything'] }))).status).toBe(400);
    const ok = await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({ window_kind: 'maintenance' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.window_start).toBeNull();
    const again = await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({}));
    expect(again.body.window_kind).toBe('group');
    const list = (await viewer.agent.get('/api/v1/fleet/patches/policies')).body;
    expect(list.policies).toHaveLength(1);
    expect(await audits(a.organizationId, 'fleet.patch_policy_updated')).toHaveLength(2);
  });

  it('installs approved updates only inside the window, then asks before restarting; postponements end in a restart', async () => {
    const a = await newAccount('patch-flow');
    const { epId, cred } = await onlineEndpoint(a, 'PATCH-PC');
    await report(cred);
    // Not enabled yet, and no window: nothing.
    expect(await dispatchInstalls(a.organizationId)).toBe(0);
    await a.agent.post('/api/v1/fleet/patches/approvals').set(CSRF).send({ update_id: UPDATES[2]!.update_id, decision: 'approved' });
    await a.agent.post('/api/v1/fleet/patches/approvals').set(CSRF).send({ update_id: UPDATES[0]!.update_id, decision: 'declined' });
    // Maintenance windows: none on this site, so nothing is installed.
    await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({ window_kind: 'maintenance', auto_approve: ['security', 'definition'] }));
    expect(await dispatchInstalls(a.organizationId)).toBe(0);
    // An open group window: the approved driver and the auto-approved definition; never the declined
    // security update (a decline beats the policy) nor the unapproved upgrade.
    await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({ auto_approve: ['security', 'definition'] }));
    expect(await dispatchInstalls(a.organizationId)).toBe(1);
    expect(await dispatchInstalls(a.organizationId)).toBe(0); // one install per computer at a time
    const cmds = await pollFor(cred);
    const install = cmds.find((c) => c.kind === 'patch_install')!;
    expect((install.payload.updates as { update_id: string }[]).map((u) => u.update_id).sort()).toEqual([UPDATES[1]!.update_id, UPDATES[2]!.update_id]);
    const installId = install.payload.install_id as string;
    await runRebootTimers(a.organizationId);
    let row = (await a.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${epId}`)).body.installs[0];
    expect(row).toMatchObject({ state: 'installing', why: 'approved', reboot_policy: 'ask' });
    expect(row.window_label).toMatch(/Patch window/);

    await answer(cred, install.id, true, {
      results: [
        { update_id: UPDATES[1]!.update_id, result: 'succeeded' },
        { update_id: UPDATES[2]!.update_id, result: 'succeeded', reboot_required: true },
      ],
      reboot_required: true,
    });
    row = (await a.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${epId}`)).body.installs[0];
    expect(row).toMatchObject({ state: 'succeeded', reboot_required: true, reboot_state: 'asking', postponements: 0, max_postponements: 2 });
    expect(row.reboot_deadline).toBeTruthy();
    // The question shown by the agent's desktop helper, in English and Arabic.
    let prompt = (await pending(epId, 'patch_reboot_prompt'))[0]!;
    expect(prompt.payload.can_postpone).toBe(true);
    expect(prompt.payload.text).toMatch(/2 postponements left/);
    expect(prompt.payload.text).toMatch(/التأجيلات المتبقية: 2/);
    await pollFor(cred);
    await answer(cred, prompt.id, true, { answer: 'postpone' });
    row = (await a.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${epId}`)).body.installs[0];
    expect(row).toMatchObject({ reboot_state: 'postponed', postponements: 1 });
    // Postponement over: asked again with one left.
    await systemPool.query(`UPDATE fleet_patch_installs SET next_prompt_at = now() - interval '1 minute' WHERE id = $1`, [installId]);
    await runRebootTimers(a.organizationId);
    prompt = (await pending(epId, 'patch_reboot_prompt'))[1]!;
    expect(prompt.payload.text).toMatch(/1 postponement left/);
    await pollFor(cred);
    await answer(cred, prompt.id, true, { answer: 'postpone' });
    await systemPool.query(`UPDATE fleet_patch_installs SET next_prompt_at = now() - interval '1 minute' WHERE id = $1`, [installId]);
    await runRebootTimers(a.organizationId);
    // No postponement left: the restart starts, with the notice.
    row = (await a.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${epId}`)).body.installs[0];
    expect(row).toMatchObject({ reboot_state: 'restarting', postponements: 2 });
    const reboot = (await pending(epId, 'patch_reboot'))[0]!;
    expect(reboot.payload).toMatchObject({ install_id: installId, notice_s: 300 });
    expect(reboot.payload.message).toMatch(/^Nigafiy: this computer restarts/);
    await pollFor(cred);
    await answer(cred, reboot.id, true);
    // The computer comes back (booted after the restart started): done.
    await systemPool.query(`UPDATE endpoint_commands SET created_at = now() - interval '2 minutes' WHERE id = $1`, [reboot.id]);
    await heartbeat(cred, 3600);
    expect((await a.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${epId}`)).body.installs[0].reboot_state).toBe('restarting');
    await heartbeat(cred, 30);
    row = (await a.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${epId}`)).body.installs[0];
    expect(row.reboot_state).toBe('done');
    expect(row.rebooted_at).toBeTruthy();
    // Waits for a fresh scan before installing again.
    expect(await dispatchInstalls(a.organizationId)).toBe(0);
    for (const action of ['fleet.patch_install_queued', 'fleet.patch_install_finished', 'fleet.patch_restart_asked', 'fleet.patch_restart_answer', 'fleet.patch_restart', 'fleet.patch_restart_done']) {
      expect((await audits(a.organizationId, action)).length, action).toBeGreaterThan(0);
    }
    // The history cannot be deleted by the application role.
    await expect(systemPool.query(`SET ROLE lan_app; DELETE FROM fleet_patch_installs WHERE id = '${installId}'`)).rejects.toThrow();
    await systemPool.query('RESET ROLE');
  });

  it('force restarts at the end of the window; never only shows it; restart now and nobody signed in restart', async () => {
    const a = await newAccount('patch-force');
    const { epId, cred } = await onlineEndpoint(a, 'PATCH-PC');
    await report(cred);
    await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({ reboot_policy: 'force' }));
    expect(await dispatchInstalls(a.organizationId)).toBe(1);
    const install = (await pollFor(cred)).find((c) => c.kind === 'patch_install')!;
    await answer(cred, install.id, true, { results: [{ update_id: UPDATES[0]!.update_id, result: 'succeeded', reboot_required: true }], reboot_required: true });
    let row = (await a.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${epId}`)).body.installs[0];
    expect(row.reboot_state).toBe('scheduled');
    expect(new Date(row.reboot_deadline).getTime()).toBe(new Date(row.window_ends_at).getTime());
    await runRebootTimers(a.organizationId);
    expect(await pending(epId, 'patch_reboot')).toHaveLength(0);
    await systemPool.query(`UPDATE fleet_patch_installs SET reboot_deadline = now() - interval '1 second' WHERE id = $1`, [install.payload.install_id]);
    await runRebootTimers(a.organizationId);
    expect(await pending(epId, 'patch_reboot')).toHaveLength(1);

    // Never: "restart needed" only.
    const b = await newAccount('patch-never');
    const nb = await onlineEndpoint(b, 'PATCH-PC');
    await report(nb.cred);
    await b.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({ reboot_policy: 'never' }));
    await dispatchInstalls(b.organizationId);
    const ib = (await pollFor(nb.cred)).find((c) => c.kind === 'patch_install')!;
    await answer(nb.cred, ib.id, true, { results: [{ update_id: UPDATES[0]!.update_id, result: 'failed', hresult: '0x80240022' }], reboot_required: true });
    row = (await b.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${nb.epId}`)).body.installs[0];
    expect(row).toMatchObject({ state: 'failed', reboot_state: 'pending' });
    expect(row.results[0].hresult).toBe('0x80240022');

    // Ask: "restart now" restarts at once (15 s notice).
    const c = await newAccount('patch-now');
    const nc = await onlineEndpoint(c, 'PATCH-PC');
    await report(nc.cred);
    await c.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({}));
    await dispatchInstalls(c.organizationId);
    const ic = (await pollFor(nc.cred)).find((x) => x.kind === 'patch_install')!;
    await answer(nc.cred, ic.id, true, { results: [{ update_id: UPDATES[0]!.update_id, result: 'succeeded' }], reboot_required: true });
    const q = (await pollFor(nc.cred)).find((x) => x.kind === 'patch_reboot_prompt')!;
    await answer(nc.cred, q.id, true, { answer: 'restart' });
    expect((await pending(nc.epId, 'patch_reboot'))[0]!.payload.notice_s).toBe(15);
  });

  it('refuses installs the agent cannot do, cancels before delivery only, and fails an install the agent never answered', async () => {
    const a = await newAccount('patch-edge');
    const { epId, cred } = await onlineEndpoint(a, 'PATCH-PC');
    await report(cred, { install_supported: false });
    await a.agent.put('/api/v1/fleet/patches/policies').set(CSRF).send(policy({}));
    expect(await dispatchInstalls(a.organizationId)).toBe(0);
    await report(cred);
    expect(await dispatchInstalls(a.organizationId)).toBe(1);
    const inst = (await a.agent.get('/api/v1/fleet/patches/installs?open=1')).body.installs[0];
    const tech = await addMember(a, 'technician');
    expect((await tech.agent.post(`/api/v1/fleet/patches/installs/${inst.id}/cancel`).set(CSRF)).status).toBe(403);
    const cancelled = await a.agent.post(`/api/v1/fleet/patches/installs/${inst.id}/cancel`).set(CSRF);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    expect(await pollFor(cred)).toEqual([]);
    // Queued again (a new scan), taken by the agent: cannot be cancelled any more.
    await report(cred);
    expect(await dispatchInstalls(a.organizationId)).toBe(1);
    const second = (await a.agent.get('/api/v1/fleet/patches/installs?open=1')).body.installs[0];
    const taken = (await pollFor(cred)).find((c) => c.kind === 'patch_install');
    expect(taken).toBeTruthy();
    expect((await a.agent.post(`/api/v1/fleet/patches/installs/${second.id}/cancel`).set(CSRF)).status).toBe(409);
    // Still running past the stale-command expiry (the heartbeat keeps a delivered install).
    await systemPool.query(`UPDATE endpoint_commands SET created_at = now() - interval '30 minutes' WHERE endpoint_id = $1 AND kind = 'patch_install'`, [epId]);
    await heartbeat(cred);
    // Both commands now share created_at, so the taken one is looked up by id, not by order.
    expect((await pending(epId, 'patch_install')).find((c) => c.id === taken!.id)!.status).toBe('delivered');
    // No answer for 4 hours: failed.
    await systemPool.query(`UPDATE fleet_patch_installs SET queued_at = now() - interval '5 hours' WHERE id = $1`, [second.id]);
    await runRebootTimers(a.organizationId);
    const failed = (await a.agent.get(`/api/v1/fleet/patches/installs?endpoint_id=${epId}`)).body.installs.find((i: { id: string }) => i.id === second.id);
    expect(failed, JSON.stringify(failed)).toMatchObject({ state: 'failed', error: 'No answer from the agent within 4 hours' });
    // Another organization sees nothing.
    const other = await newAccount('patch-other');
    expect((await other.agent.get('/api/v1/fleet/patches/installs')).body.installs).toHaveLength(0);
    expect((await other.agent.get(`/api/v1/endpoints/${epId}/patches`)).status).toBe(404);
  });
});
