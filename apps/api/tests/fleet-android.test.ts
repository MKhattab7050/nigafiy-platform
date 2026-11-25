import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { LocalFileStore, filesRoot } from '../src/infrastructure/file-store.ts';
import { base32Decode, totp } from '../src/modules/auth/totp.ts';
import { runApkFileSweep } from '../src/modules/endpoints/fleet-android/apks.ts';
import { measure } from '../src/modules/endpoints/fleet-monitoring/evaluate.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Android phones as Fleet endpoints (migration 045, docs/features/android.md). The agent side is
// driven with the exact bodies agents/android-agent core/Protocol.kt builds; no phone is involved.

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };
const now = () => new Date().toISOString();

function checks(over: Partial<Record<string, 'pass' | 'fail' | 'unknown'>> = {}) {
  const at = now();
  const st = (k: string, d: 'pass' | 'fail' | 'unknown' = 'pass') => over[k] ?? d;
  return [
    { check: 'screen_lock', subject: 'Screen lock', state: st('screen_lock'), value: 'PIN, pattern or password set', source: 'KeyguardManager.isDeviceSecure', measured_at: at },
    { check: 'disk_encryption', subject: 'Storage', state: st('disk_encryption'), value: 'file-based encryption (per user)', source: 'DevicePolicyManager.getStorageEncryptionStatus', measured_at: at },
    { check: 'os_updates', subject: 'Security patch level', state: st('os_updates'), value: '2026-11-01 (24 days old)', source: 'Build.VERSION.SECURITY_PATCH', measured_at: at },
    { check: 'developer_options', subject: 'Developer options', state: st('developer_options'), value: 'off', source: 'Settings.Global.DEVELOPMENT_SETTINGS_ENABLED', measured_at: at },
    { check: 'usb_debugging', subject: 'USB debugging', state: st('usb_debugging'), value: 'off', source: 'Settings.Global.ADB_ENABLED', measured_at: at },
    { check: 'unknown_sources', subject: 'Install unknown apps', state: st('unknown_sources'), value: 'no app may install unknown apps', source: 'AppOpsManager request_install_packages', measured_at: at },
  ];
}

const identity = (name: string) => ({
  agent_version: '0.1.0',
  hostname: name,
  platform: 'android',
  os: 'android',
  os_version: 'Android 15 (API 35)',
  arch: 'arm64-v8a',
  manufacturer: 'Google',
  model: 'Pixel 8',
  ram_total_mb: 7790,
});

function heartbeatBody(name: string, mode: 'regular' | 'device_owner', extra: Record<string, unknown> = {}) {
  return {
    ...identity(name),
    uptime_seconds: 3600,
    ram_used_mb: 4100,
    ram_pct: 52.6,
    disk_used_pct: 41.3,
    disks: [{ mount: '/data', filesystem: 'internal storage', total_gb: 119.2, used_gb: 49.23, free_gb: 69.97, used_pct: 41.3 }],
    interfaces: [{ name: 'wlan0', addresses: ['10.20.0.15/24'] }],
    software: [
      { name: 'Chrome', version: '131.0', package_id: 'com.android.chrome', publisher: 'system app' },
      { name: 'Nigafiy', version: '0.1.0', package_id: 'com.nigafiy.agent' },
    ],
    security: { checks: checks(), measured_at: now() },
    android: { mode, sdk_int: 35, release: '15', security_patch: '2026-11-01', battery_pct: 81, charging: false, network: 'wifi', notifications_allowed: true, apps_count: 2 },
    ...extra,
  };
}

/** A phone enrolled the way the app does it, then one heartbeat in `mode`. */
async function phone(a: TestAccount, mode: 'regular' | 'device_owner', name = 'Pixel-Reception') {
  const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name, platform: 'android' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.enrollment_token).toMatch(/^ldea_/);
  const enrolled = await request(app)
    .post('/api/v1/agent/enroll')
    .send({ enrollment_token: created.body.enrollment_token, ...identity(name), security: { checks: checks(), measured_at: now() } });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  const cred: string = enrolled.body.credential;
  expect(cred).toMatch(/^lda_/);
  const hb = await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send(heartbeatBody(name, mode));
  expect(hb.status, JSON.stringify(hb.body)).toBe(200);
  return { epId: created.body.endpoint.id as string, cred };
}

const heartbeat = (cred: string, name: string, mode: 'regular' | 'device_owner') =>
  request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send(heartbeatBody(name, mode));

async function poll(cred: string): Promise<Cmd[]> {
  const r = await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({});
  expect(r.status).toBe(200);
  return r.body.commands;
}

const act = (a: TestAccount, epId: string, body: Record<string, unknown>) => a.agent.post(`/api/v1/endpoints/${epId}/android/actions`).set(CSRF).send(body);

async function audits(orgId: string, action: string): Promise<Array<{ metadata: Record<string, unknown>; user_email: string | null }>> {
  return (await systemPool.query(`SELECT metadata, user_email FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;
}

async function addMember(owner: TestAccount, role: 'admin' | 'technician' | 'viewer'): Promise<TestAccount> {
  const other = await newAccount(`android-${role}`);
  const user = await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [other.email]);
  await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)`, [user.rows[0]!.id, owner.organizationId, role]);
  const sw = await other.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: owner.organizationId });
  expect(sw.status).toBe(200);
  return { ...other, organizationId: owner.organizationId, siteId: owner.siteId };
}

async function enableMfa(a: TestAccount): Promise<string> {
  const setup = await a.agent.post('/api/v1/auth/mfa/setup').set(CSRF).send({});
  expect(setup.status).toBe(200);
  const confirm = await a.agent.post('/api/v1/auth/mfa/confirm').set(CSRF).send({ code: totp(base32Decode(setup.body.secret), Date.now()) });
  expect(confirm.status).toBe(200);
  return setup.body.secret;
}

/**
 * A fresh step-up token. A code is accepted once (mfa_last_step); the test forgets the last used step
 * so several step-ups fit inside one 30-second window.
 */
async function stepUp(a: TestAccount, secret: string): Promise<string> {
  await systemPool.query(`UPDATE users SET mfa_last_step = NULL WHERE lower(email) = $1`, [a.email]);
  const r = await a.agent.post('/api/v1/fleet/step-up').set(CSRF).send({ code: totp(base32Decode(secret), Date.now()) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.step_up_token;
}

async function groupFor(a: TestAccount, epId: string, policy: Record<string, unknown>): Promise<string> {
  const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: `Phones-${Math.random().toString(36).slice(2, 8)}`, ...policy });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  expect((await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.body.group.id })).status).toBe(200);
  return g.body.group.id;
}

/** A minimal ZIP local-file header, enough for the APK sniff (an APK is a ZIP archive). */
function fakeApk(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26, 0), Buffer.from(`AndroidManifest.xml ${seed}`)]);
}

describe('Android phones: enrollment, heartbeat and the endpoint view', () => {
  it('enrolls with an ldea_ token, stores the Android block, judges the Android checks and never invents a CPU load', async () => {
    const a = await newAccount('android-enroll');
    const { epId } = await phone(a, 'regular');
    const ep = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(ep.status).toBe(200);
    const e = ep.body.endpoint ?? ep.body;
    expect(e).toMatchObject({ platform: 'android', status: 'active', os_version: 'Android 15 (API 35)', model: 'Pixel 8', cpu_pct: null, compliance_status: 'compliant' });
    expect(e.android).toMatchObject({ mode: 'regular', sdk_int: 35, battery_pct: 81, network: 'wifi' });
    expect(typeof e.android.reported_at).toBe('string');
    expect(e.software.find((s: { package_id?: string }) => s.package_id === 'com.android.chrome')).toBeTruthy();

    const samples = await systemPool.query(`SELECT cpu_pct, ram_pct FROM endpoint_samples WHERE endpoint_id = $1`, [epId]);
    expect(samples.rows[0]).toMatchObject({ cpu_pct: null, ram_pct: 52.6 });

    const list = await a.agent.get('/api/v1/endpoints?platform=android');
    expect(list.status).toBe(200);
    const items = list.body.items ?? list.body.endpoints ?? list.body;
    expect(items.map((x: { id: string }) => x.id)).toContain(epId);
  });

  it('a failed Android check makes the phone non-compliant with the reason; a missing one is "not measured"', async () => {
    const a = await newAccount('android-compliance');
    const { epId, cred } = await phone(a, 'regular');
    const body = heartbeatBody('Pixel-Reception', 'regular', { security: { checks: checks({ screen_lock: 'fail', usb_debugging: 'fail' }), measured_at: now() } });
    expect((await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send(body)).status).toBe(200);
    const e = (await a.agent.get(`/api/v1/endpoints/${epId}`)).body;
    const ep = e.endpoint ?? e;
    expect(ep.compliance_status).toBe('non_compliant');
    expect(ep.compliance_reasons).toEqual(expect.arrayContaining(['No screen lock (PIN, pattern or password) protects the phone', 'USB debugging (adb) is switched on']));

    const partial = heartbeatBody('Pixel-Reception', 'regular', { security: { checks: checks().filter((c) => c.check !== 'unknown_sources'), measured_at: now() } });
    expect((await request(app).post('/api/v1/agent/heartbeat').set('Authorization', `Bearer ${cred}`).send(partial)).status).toBe(200);
    const p = (await a.agent.get(`/api/v1/endpoints/${epId}`)).body;
    expect((p.endpoint ?? p).compliance_status).toBe('unknown');
  });

  it('a CPU monitoring rule on a phone is "not measured", never a breach of 0 %', () => {
    const m = measure({ kind: 'cpu', threshold: 90 } as Parameters<typeof measure>[0], { cpuPct: null, ramPct: 40, disks: null, monitor: undefined });
    expect(m.breach).toBeNull();
    expect(m.value).toMatch(/not available/);
  });

  it('generic commands: only an inventory refresh goes to a phone', async () => {
    const a = await newAccount('android-generic');
    const { epId, cred } = await phone(a, 'device_owner');
    const kill = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'power_action', action: 'lock' });
    expect(kill.status).toBe(409);
    expect(kill.body.error.code).toBe('unsupported_by_platform');
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'refresh_inventory' })).status).toBe(202);
    expect((await poll(cred)).map((c) => c.kind)).toEqual(['refresh_inventory']);
  });
});

describe('Android actions: Device Owner, roles, policy, MFA, approvals, audit', () => {
  it('a regular app gets no Device Owner action (refused and audited); Device Owner mode allows them', async () => {
    const a = await newAccount('android-mode');
    const { epId, cred } = await phone(a, 'regular');
    const r = await act(a, epId, { action: 'lock' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('android_requires_device_owner');
    const refused = await audits(a.organizationId, 'fleet.policy_refused');
    expect(refused.at(-1)?.metadata).toMatchObject({ code: 'android_requires_device_owner', what: 'android_lock' });

    expect((await heartbeat(cred, 'Pixel-Reception', 'device_owner')).status).toBe(200);
    const ok = await act(a, epId, { action: 'lock' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect(ok.body).toMatchObject({ state: 'queued', command: { kind: 'android_lock', status: 'pending' } });
    const cmds = await poll(cred);
    expect(cmds).toEqual([{ id: ok.body.command.id, kind: 'android_lock', payload: {} }]);
    // The agent's result closes the command.
    const res = await request(app).post('/api/v1/agent/command-result').set('Authorization', `Bearer ${cred}`).send({ command_results: [{ id: ok.body.command.id, ok: true, output: 'locked' }] });
    expect(res.status).toBe(200);
    const row = await systemPool.query(`SELECT status, output FROM endpoint_commands WHERE id = $1`, [ok.body.command.id]);
    expect(row.rows[0]).toMatchObject({ status: 'completed', output: 'locked' });
    expect((await audits(a.organizationId, 'endpoint.android_lock')).length).toBe(1);
  });

  it('roles: viewer nothing, technician lock / camera / password, admin installs, removals and wipes', async () => {
    const a = await newAccount('android-roles');
    const { epId, cred } = await phone(a, 'device_owner');
    const viewer = await addMember(a, 'viewer');
    const tech = await addMember(a, 'technician');
    expect((await act(viewer, epId, { action: 'lock' })).status).toBe(403);
    expect((await act(tech, epId, { action: 'camera', disabled: true })).status).toBe(202);
    expect((await act(tech, epId, { action: 'password_policy', complexity: 'medium' })).status).toBe(202);
    const un = await act(tech, epId, { action: 'uninstall', package: 'com.example.game' });
    expect(un.status).toBe(403);
    expect(un.body.error.code).toBe('android_admin_only');
    expect((await act(tech, epId, { action: 'wipe', reason: 'lost phone' })).body.error.code).toBe('android_admin_only');
    const cmds = await poll(cred);
    expect(cmds.map((c) => [c.kind, c.payload])).toEqual(
      expect.arrayContaining([
        ['android_camera', { disabled: true }],
        ['android_password_policy', { complexity: 'medium' }],
      ]),
    );
    // Validation: a package name is a package name; the agent itself is never uninstalled.
    expect((await act(a, epId, { action: 'uninstall', package: '../../etc' })).status).toBe(400);
    const self = await act(a, epId, { action: 'uninstall', package: 'com.nigafiy.agent' });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('android_self_uninstall');
    expect((await act(a, epId, { action: 'uninstall', package: 'com.example.game' })).status).toBe(202);
  });

  it('wipe and stop management always need a verification code; with it the command carries the reason', async () => {
    const a = await newAccount('android-wipe');
    const { epId, cred } = await phone(a, 'device_owner');
    expect((await act(a, epId, { action: 'wipe', reason: 'lost on the train' })).body.error.code).toBe('policy_mfa_not_enrolled');
    const secret = await enableMfa(a);
    expect((await act(a, epId, { action: 'wipe', reason: 'lost on the train' })).body.error.code).toBe('policy_mfa_required');
    expect((await act(a, epId, { action: 'wipe', reason: 'lost on the train', step_up_token: `fsu1.9999999999.${'a'.repeat(64)}` })).body.error.code).toBe('policy_mfa_invalid');
    expect((await act(a, epId, { action: 'wipe', reason: 'x' })).status).toBe(400);
    const token = await stepUp(a, secret);
    const ok = await act(a, epId, { action: 'wipe', reason: 'lost on the train', step_up_token: token });
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect((await poll(cred)).find((c) => c.kind === 'android_wipe')?.payload).toEqual({ reason: 'lost on the train' });
    const row = (await audits(a.organizationId, 'endpoint.android_wipe'))[0]!;
    expect(row.metadata).toMatchObject({ reason: 'lost on the train', mfa_verified: true });
    // The step-up token is never written to the audit log.
    const all = await systemPool.query(`SELECT metadata::text AS m FROM audit_logs WHERE organization_id = $1`, [a.organizationId]);
    expect(all.rows.some((r) => String(r.m).includes(token))).toBe(false);

    const rel = await act(a, epId, { action: 'release', reason: 'phone returned to the shop', step_up_token: await stepUp(a, secret) });
    expect(rel.status).toBe(202);
    expect(rel.body.command.kind).toBe('android_release');
  });

  it('a group that asks for MFA asks it for every Android action; its role list and address list apply', async () => {
    const a = await newAccount('android-group');
    const { epId } = await phone(a, 'device_owner');
    const tech = await addMember(a, 'technician');
    const gid = await groupFor(a, epId, { access_mode: 'unattended', mfa_required: true });
    expect((await act(a, epId, { action: 'lock' })).body.error.code).toBe('policy_mfa_not_enrolled');
    const secret = await enableMfa(a);
    expect((await act(a, epId, { action: 'lock' })).body.error.code).toBe('policy_mfa_required');
    expect((await act(a, epId, { action: 'lock', step_up_token: await stepUp(a, secret) })).status).toBe(202);

    await a.agent.patch(`/api/v1/fleet/groups/${gid}`).set(CSRF).send({ mfa_required: false, allowed_roles: ['owner', 'admin'] });
    expect((await act(tech, epId, { action: 'lock' })).body.error.code).toBe('policy_role_not_allowed');
    await a.agent.patch(`/api/v1/fleet/groups/${gid}`).set(CSRF).send({ allowed_roles: ['owner', 'admin', 'technician'], ip_allowlist: ['203.0.113.0/24'] });
    expect((await act(tech, epId, { action: 'lock' })).body.error.code).toBe('policy_ip_not_allowed');
  });

  it('second-admin approval for a wipe: nothing reaches the phone before it, self-approval refused, approve, deny, expiry', async () => {
    const a = await newAccount('android-approval');
    const { epId, cred } = await phone(a, 'device_owner');
    await groupFor(a, epId, { access_mode: 'unattended', approval_required: true, approval_ttl_minutes: 5 });
    const second = await addMember(a, 'admin');
    const tech = await addMember(a, 'technician');
    const secret = await enableMfa(a);

    const r = await act(a, epId, { action: 'wipe', reason: 'stolen, police report 4411', step_up_token: await stepUp(a, secret) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ state: 'waiting_approval', request: { action: 'wipe', state: 'pending', requested_email: a.email, mfa_verified: true } });
    expect((await poll(cred)).filter((c) => c.kind === 'android_wipe')).toEqual([]);
    const reqId: string = r.body.request.id;

    expect((await tech.agent.get('/api/v1/fleet/android/requests')).status).toBe(403);
    const pending = await second.agent.get('/api/v1/fleet/android/requests');
    expect(pending.body.requests.map((x: { id: string }) => x.id)).toEqual([reqId]);
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/android/requests`)).body.requests[0]).toMatchObject({ id: reqId, endpoint_name: 'Pixel-Reception' });

    const self = await a.agent.post(`/api/v1/fleet/android/requests/${reqId}/approve`).set(CSRF).send({});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('approval_self');
    const ok = await second.agent.post(`/api/v1/fleet/android/requests/${reqId}/approve`).set(CSRF).send({ note: 'confirmed with the owner' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.command).toMatchObject({ kind: 'android_wipe', created_by_name: a.email });
    expect((await poll(cred)).find((c) => c.kind === 'android_wipe')?.payload).toEqual({ reason: 'stolen, police report 4411' });
    expect((await second.agent.post(`/api/v1/fleet/android/requests/${reqId}/approve`).set(CSRF).send({})).body.error.code).toBe('approval_not_pending');
    expect((await audits(a.organizationId, 'fleet.android_request_approved'))[0]).toMatchObject({ user_email: second.email, metadata: { requester: a.email, note: 'confirmed with the owner' } });
    expect((await audits(a.organizationId, 'endpoint.android_wipe'))[0]?.metadata).toMatchObject({ requested_by: a.email, approved_by: second.email });

    // Deny.
    const r2 = await act(a, epId, { action: 'release', reason: 'returning the phone', step_up_token: await stepUp(a, secret) });
    expect(r2.body.state).toBe('waiting_approval');
    expect((await second.agent.post(`/api/v1/fleet/android/requests/${r2.body.request.id}/deny`).set(CSRF).send({ note: 'not yet' })).status).toBe(200);
    expect((await poll(cred)).filter((c) => c.kind === 'android_release')).toEqual([]);
    expect((await audits(a.organizationId, 'fleet.android_request_denied')).length).toBe(1);

    // Expiry.
    const r3 = await act(a, epId, { action: 'wipe', reason: 'second try', step_up_token: await stepUp(a, secret) });
    await systemPool.query(`UPDATE fleet_android_requests SET expires_at = now() - interval '1 second' WHERE id = $1`, [r3.body.request.id]);
    const late = await second.agent.post(`/api/v1/fleet/android/requests/${r3.body.request.id}/approve`).set(CSRF).send({});
    expect(late.body.error.code).toBe('approval_expired');
    const decided = await second.agent.get('/api/v1/fleet/android/requests?state=decided');
    expect(decided.body.requests.map((x: { state: string }) => x.state).sort()).toEqual(['approved', 'denied', 'expired']);
    expect((await audits(a.organizationId, 'fleet.android_request_expired')).length).toBe(1);
    // Evidence is kept: the app role cannot delete a request.
    await expect(systemPool.query(`SET ROLE lan_app; DELETE FROM fleet_android_requests; RESET ROLE`)).rejects.toThrow();
    await systemPool.query('RESET ROLE');
  });

  it('another organization can neither act on the phone nor see or decide its requests', async () => {
    const a = await newAccount('android-iso-a');
    const b = await newAccount('android-iso-b');
    const { epId } = await phone(a, 'device_owner');
    await groupFor(a, epId, { access_mode: 'unattended', approval_required: true });
    const secret = await enableMfa(a);
    const r = await act(a, epId, { action: 'wipe', reason: 'tenant test', step_up_token: await stepUp(a, secret) });
    expect(r.body.state).toBe('waiting_approval');
    expect((await act(b, epId, { action: 'lock' })).status).toBe(404);
    expect((await b.agent.get('/api/v1/fleet/android/requests')).body.requests).toEqual([]);
    expect((await b.agent.post(`/api/v1/fleet/android/requests/${r.body.request.id}/approve`).set(CSRF).send({})).status).toBe(404);
  });

  it('a phone that is offline gets nothing queued', async () => {
    const a = await newAccount('android-offline');
    const { epId } = await phone(a, 'device_owner');
    await systemPool.query(`UPDATE endpoints SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [epId]);
    expect((await act(a, epId, { action: 'lock' })).body.error.code).toBe('endpoint_offline');
  });
});

describe('APKs pushed from Fleet', () => {
  it('upload (admin, APK only, no duplicates), install command with size and SHA-256, download only for that command', async () => {
    const a = await newAccount('android-apk');
    const tech = await addMember(a, 'technician');
    const { epId, cred } = await phone(a, 'device_owner', 'Pixel-A');
    const other = await phone(a, 'device_owner', 'Pixel-B');
    const bytes = fakeApk('v1');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const up = (who: TestAccount, body: Buffer, q = 'name=Field%20app&file_name=field-app.apk') =>
      who.agent.post(`/api/v1/fleet/android/apks?${q}`).set(CSRF).set('Content-Type', 'application/vnd.android.package-archive').send(body);

    expect((await up(tech, bytes)).status).toBe(403);
    expect((await up(a, Buffer.from('not a zip file at all, just text'))).body.error.code).toBe('apk_invalid');
    expect((await up(a, bytes, 'name=x&file_name=..%2F..%2Fevil.apk')).status).toBe(400);
    const created = await up(a, bytes);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.apk).toMatchObject({ name: 'Field app', file_name: 'field-app.apk', size_bytes: bytes.length, sha256: sha, uploaded_by_email: a.email });
    expect((await up(a, bytes)).body.error.code).toBe('apk_exists');
    expect((await tech.agent.get('/api/v1/fleet/android/apks')).body.apks).toHaveLength(1);
    const apkId: string = created.body.apk.id;
    // Name, size and SHA-256 are audited; never the bytes.
    expect((await audits(a.organizationId, 'fleet.android_apk_uploaded'))[0]?.metadata).toEqual({ name: 'Field app', file_name: 'field-app.apk', size_bytes: bytes.length, sha256: sha });

    // No command yet: the agent cannot fetch it.
    const dl = (c: string) => request(app).get(`/api/v1/agent/android/apks/${apkId}`).set('Authorization', `Bearer ${c}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect((await dl(cred)).status).toBe(404);
    expect((await act(tech, epId, { action: 'install_apk', apk_id: apkId })).body.error.code).toBe('android_admin_only');
    const inst = await act(a, epId, { action: 'install_apk', apk_id: apkId });
    expect(inst.status).toBe(202);
    const cmd = (await poll(cred)).find((c) => c.kind === 'android_install_apk')!;
    expect(cmd.payload).toEqual({ apk_id: apkId, name: 'Field app', file_name: 'field-app.apk', size_bytes: bytes.length, sha256: sha });
    const got = await dl(cred);
    expect(got.status).toBe(200);
    expect(got.headers['x-content-sha256']).toBe(sha);
    expect(Buffer.compare(got.body as Buffer, bytes)).toBe(0);
    // Another phone without the command cannot fetch it.
    expect((await dl(other.cred)).status).toBe(404);
    // After the result the download is closed again.
    await request(app).post('/api/v1/agent/command-result').set('Authorization', `Bearer ${cred}`).send({ command_results: [{ id: cmd.id, ok: true, output: 'installed com.example.field' }] });
    expect((await dl(cred)).status).toBe(404);

    expect((await tech.agent.delete(`/api/v1/fleet/android/apks/${apkId}`).set(CSRF)).status).toBe(403);
    expect((await a.agent.delete(`/api/v1/fleet/android/apks/${apkId}`).set(CSRF)).status).toBe(200);
    expect((await act(a, epId, { action: 'install_apk', apk_id: apkId })).status).toBe(404);
  });
});

describe('APK files in the file store (migration 048)', () => {
  const store = new LocalFileStore();
  const up = (who: TestAccount, body: Buffer, q = 'name=Store%20app&file_name=store-app.apk') =>
    who.agent.post(`/api/v1/fleet/android/apks?${q}`).set(CSRF).set('Content-Type', 'application/vnd.android.package-archive').send(body);
  const fileOf = (orgId: string, sha: string) => path.join(filesRoot(), 'apks', orgId, sha);
  const orgFiles = (orgId: string) => (existsSync(path.join(filesRoot(), 'apks', orgId)) ? readdirSync(path.join(filesRoot(), 'apks', orgId)) : []);

  /** Downloads through a real socket: an aborted body rejects instead of looking complete. */
  async function fetchFile(urlPath: string, headers: Record<string, string>): Promise<{ status: number; body: Buffer | null; aborted: boolean; json: unknown }> {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${urlPath}`, { headers });
      if (res.headers.get('content-type')?.includes('json')) return { status: res.status, body: null, aborted: false, json: await res.json() };
      try {
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()), aborted: false, json: null };
      } catch {
        return { status: res.status, body: null, aborted: true, json: null };
      }
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }
  /** The session cookie the test agent holds, for fetch(). */
  const cookieOf = (a: TestAccount) => {
    const jar = (a.agent as unknown as { jar: { getCookies: (o: unknown) => Array<{ name: string; value: string }> } }).jar;
    return jar
      .getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false })
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  };

  it('upload streams to <files>/apks/<org>/<sha256>; same bytes are one file; delete removes it; roles and organizations are enforced', async () => {
    const a = await newAccount('apk-files-a');
    const b = await newAccount('apk-files-b');
    const tech = await addMember(a, 'technician');
    const viewer = await addMember(a, 'viewer');
    const bytes = fakeApk('stored');
    const sha = createHash('sha256').update(bytes).digest('hex');

    // Viewer and technician cannot upload.
    expect((await up(viewer, bytes)).status).toBe(403);
    expect((await up(tech, bytes)).status).toBe(403);
    expect(orgFiles(a.organizationId)).toEqual([]);

    const created = await up(a, bytes);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id: string = created.body.apk.id;
    expect(statSync(fileOf(a.organizationId, sha)).size).toBe(bytes.length);
    const row = (await systemPool.query(`SELECT storage_key, size_bytes::int AS size, sha256 FROM fleet_android_apks WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ storage_key: `apks/${a.organizationId}/${sha}`, size: bytes.length, sha256: sha });
    // The bytes are no longer in the database at all.
    expect((await systemPool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'fleet_android_apks' AND column_name = 'content'`)).rowCount).toBe(0);

    // Same bytes again in the same organization: refused, still one file, no temporary file left.
    expect((await up(a, bytes, 'name=Again&file_name=again.apk')).body.error.code).toBe('apk_exists');
    expect(orgFiles(a.organizationId)).toEqual([sha]);
    // The same bytes in another organization: its own row and its own folder.
    expect((await up(b, bytes)).status).toBe(201);
    expect(orgFiles(b.organizationId)).toEqual([sha]);

    // Empty or wrongly typed bodies leave nothing behind either.
    expect((await up(a, Buffer.alloc(0))).body.error.code).toBe('apk_empty');
    expect((await a.agent.post('/api/v1/fleet/android/apks?name=x&file_name=x.apk').set(CSRF).set('Content-Type', 'text/plain').send('PK')).body.error.code).toBe('apk_empty');
    expect((await up(a, Buffer.from('not a zip file at all, just text'))).body.error.code).toBe('apk_invalid');
    expect(orgFiles(a.organizationId)).toEqual([sha]);

    // Admin download: the exact bytes, audited; technician and viewer refused; another organization sees nothing.
    const dl = await fetchFile(`/api/v1/fleet/android/apks/${id}/file`, { cookie: cookieOf(a) });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body!, bytes)).toBe(0);
    expect((await audits(a.organizationId, 'fleet.android_apk_downloaded'))[0]?.metadata).toEqual({ name: 'Store app', sha256: sha });
    expect((await tech.agent.get(`/api/v1/fleet/android/apks/${id}/file`)).status).toBe(403);
    expect((await viewer.agent.get(`/api/v1/fleet/android/apks/${id}/file`)).status).toBe(403);
    expect((await b.agent.get(`/api/v1/fleet/android/apks/${id}/file`)).status).toBe(404);
    expect((await b.agent.delete(`/api/v1/fleet/android/apks/${id}`).set(CSRF)).status).toBe(404);
    expect((await viewer.agent.delete(`/api/v1/fleet/android/apks/${id}`).set(CSRF)).status).toBe(403);
    expect((await tech.agent.delete(`/api/v1/fleet/android/apks/${id}`).set(CSRF)).status).toBe(403);
    expect(existsSync(fileOf(a.organizationId, sha))).toBe(true);

    // Delete: row and file go; the other organization's copy stays.
    expect((await a.agent.delete(`/api/v1/fleet/android/apks/${id}`).set(CSRF)).status).toBe(200);
    expect(existsSync(fileOf(a.organizationId, sha))).toBe(false);
    expect(existsSync(fileOf(b.organizationId, sha))).toBe(true);
    expect((await audits(a.organizationId, 'fleet.android_apk_deleted'))[0]?.metadata).toEqual({ name: 'Store app', sha256: sha, file_removed: true });
  });

  it('a missing or damaged file is a clear, audited error and never a complete download', async () => {
    const a = await newAccount('apk-files-bad');
    const { epId, cred } = await phone(a, 'device_owner', 'Pixel-Files');
    const bytes = Buffer.concat([fakeApk('damaged'), Buffer.alloc(300_000, 7)]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const id: string = (await up(a, bytes)).body.apk.id;
    const file = fileOf(a.organizationId, sha);
    const cookie = cookieOf(a);

    // An install command, then the file is damaged (same size, other bytes): the downloads abort.
    expect((await act(a, epId, { action: 'install_apk', apk_id: id })).status).toBe(202);
    const damaged = Buffer.from(bytes);
    damaged[damaged.length - 1]! ^= 0xff;
    writeFileSync(file, damaged);
    const agentDl = await fetchFile(`/api/v1/agent/android/apks/${id}`, { authorization: `Bearer ${cred}` });
    expect(agentDl.status).toBe(200);
    expect(agentDl.aborted).toBe(true);
    const adminDl = await fetchFile(`/api/v1/fleet/android/apks/${id}/file`, { cookie });
    expect(adminDl.aborted).toBe(true);
    await expect.poll(async () => (await audits(a.organizationId, 'fleet.android_apk_file_problem')).length).toBe(2);
    expect((await audits(a.organizationId, 'fleet.android_apk_file_problem'))[0]?.metadata).toEqual({ problem: 'corrupt', during: 'agent_download', sha256: sha, endpoint_id: epId });

    // Wrong size: refused before the first byte, and the install action is refused.
    writeFileSync(file, bytes.subarray(0, 1000));
    const short = await fetchFile(`/api/v1/fleet/android/apks/${id}/file`, { cookie });
    expect(short.status).toBe(409);
    expect(short.json).toMatchObject({ error: { code: 'apk_file_corrupt' } });
    expect((await act(a, epId, { action: 'install_apk', apk_id: id })).body.error.code).toBe('apk_file_corrupt');

    // Missing: the install action is refused and audited; downloads say so.
    rmSync(file);
    const inst = await act(a, epId, { action: 'install_apk', apk_id: id });
    expect(inst.status).toBe(409);
    expect(inst.body.error.code).toBe('apk_file_missing');
    const missing = await fetchFile(`/api/v1/agent/android/apks/${id}`, { authorization: `Bearer ${cred}` });
    expect(missing.json).toMatchObject({ error: { code: 'apk_file_missing' } });
    const problems = (await audits(a.organizationId, 'fleet.android_apk_file_problem')).map((x) => [x.metadata.problem, x.metadata.during]);
    expect(problems).toEqual([
      ['corrupt', 'agent_download'],
      ['corrupt', 'admin_download'],
      ['corrupt', 'admin_download'],
      ['corrupt', 'install'],
      ['missing', 'install'],
      ['missing', 'agent_download'],
    ]);

    // Uploading the same bytes again repairs the stored copy (audited); installing works again.
    const repair = await up(a, bytes, 'name=Repair&file_name=repair.apk');
    expect(repair.status, JSON.stringify(repair.body)).toBe(200);
    expect(repair.body).toMatchObject({ repaired: true, apk: { id, name: 'Store app' } });
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect((await audits(a.organizationId, 'fleet.android_apk_file_repaired'))[0]?.metadata).toEqual({ name: 'Store app', sha256: sha, was: 'missing' });
    expect((await act(a, epId, { action: 'install_apk', apk_id: id })).status).toBe(202);
    expect((await up(a, bytes)).body.error.code).toBe('apk_exists');

    // Deleting an APK whose file is already gone still works (nothing to remove).
    rmSync(file);
    expect((await a.agent.delete(`/api/v1/fleet/android/apks/${id}`).set(CSRF)).status).toBe(200);
    expect((await audits(a.organizationId, 'fleet.android_apk_deleted'))[0]?.metadata).toMatchObject({ file_removed: false });
  });

  it('the sweep removes old orphans and old temporary files, never a referenced file, and audits a summary', async () => {
    const a = await newAccount('apk-files-sweep');
    const bytes = fakeApk('kept');
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect((await up(a, bytes)).status).toBe(201);
    const dir = path.join(filesRoot(), 'apks', a.organizationId);
    const old = new Date(Date.now() - 7 * 3600_000);
    const orphan = path.join(dir, 'ab'.repeat(32));
    const oldTemp = path.join(dir, `.tmp-${'1'.repeat(32)}`);
    const freshTemp = path.join(dir, `.tmp-${'2'.repeat(32)}`);
    const freshOrphan = path.join(dir, 'cd'.repeat(32));
    const other = path.join(dir, 'notes.txt');
    writeFileSync(orphan, 'x'.repeat(10));
    writeFileSync(oldTemp, 'y'.repeat(20));
    writeFileSync(freshTemp, 'z');
    writeFileSync(freshOrphan, 'w');
    writeFileSync(other, 'leave me');
    for (const f of [orphan, oldTemp, other, fileOf(a.organizationId, sha)]) utimesSync(f, old, old);

    await runApkFileSweep(store);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(oldTemp)).toBe(false);
    expect(existsSync(fileOf(a.organizationId, sha))).toBe(true); // referenced
    expect(existsSync(freshTemp)).toBe(true); // an upload may still be writing it
    expect(existsSync(freshOrphan)).toBe(true); // younger than the safe age
    expect(existsSync(other)).toBe(true); // not a file of the store: never touched
    expect((await audits(a.organizationId, 'fleet.android_apk_files_swept'))[0]?.metadata).toEqual({ orphans_removed: 1, temp_removed: 1, bytes_freed: 30, others_kept: 1 });
    // A second run finds nothing more to do in this organization.
    await runApkFileSweep(store);
    expect(await audits(a.organizationId, 'fleet.android_apk_files_swept')).toHaveLength(1);
    rmSync(other);
  });
});

describe('Device Owner provisioning', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nigafiy-android-'));
  const before = env.NIGAFIY_ANDROID_APK;
  afterAll(() => {
    (env as { NIGAFIY_ANDROID_APK?: string }).NIGAFIY_ANDROID_APK = before;
    rmSync(dir, { recursive: true, force: true });
  });

  it('without a built APK no provisioning QR is offered; with one the QR data and the download match it', async () => {
    const a = await newAccount('android-prov');
    const tech = await addMember(a, 'technician');
    (env as { NIGAFIY_ANDROID_APK?: string }).NIGAFIY_ANDROID_APK = path.join(dir, 'missing.apk');
    expect((await tech.agent.get('/api/v1/fleet/android/provisioning')).status).toBe(403);
    const none = await a.agent.get('/api/v1/fleet/android/provisioning');
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ component: 'com.nigafiy.agent/.admin.NigafiyAdminReceiver', apk: null });
    expect((await request(app).get('/api/v1/agent/android/agent.apk')).body.error.code).toBe('android_apk_not_built');

    const file = path.join(dir, 'agent.apk');
    const bytes = fakeApk('agent');
    writeFileSync(file, bytes);
    (env as { NIGAFIY_ANDROID_APK?: string }).NIGAFIY_ANDROID_APK = file;
    const info = await a.agent.get('/api/v1/fleet/android/provisioning');
    const digest = createHash('sha256').update(bytes).digest();
    expect(info.body.apk).toMatchObject({ sha256: digest.toString('hex'), checksum_b64url: digest.toString('base64url'), size_bytes: bytes.length });
    expect(info.body.apk.url).toMatch(/\/api\/v1\/agent\/android\/agent\.apk$/);
    const got = await request(app).get('/api/v1/agent/android/agent.apk').buffer(true);
    expect(got.status).toBe(200);
    expect(got.headers['x-content-sha256']).toBe(digest.toString('hex'));
  });
});
