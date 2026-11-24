import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPool, withTenant } from '../src/infrastructure/db.ts';
import { base32Decode, hotp, timeStep, totp } from '../src/modules/auth/totp.ts';
import { evaluatePolicy, ipAllowed, normalizeIp, withinHours } from '../src/modules/endpoints/fleet-policy/policy.ts';
import { checkStepUpToken, issueStepUpToken } from '../src/modules/endpoints/fleet-policy/step-up.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { localClock } from '../src/modules/routers/product-schedule.ts';
import type { FleetAccessPolicy, FleetPermissionProfile } from '@nigafiy/shared-types';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Fleet Pro: permission profiles, groups, per-group access policy, MFA step-up, second-admin
// approval and the profile enforced on every session action (migration 035).

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };

async function pollFor(cred: string): Promise<Cmd[]> {
  const r = await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({});
  return r.body.commands;
}

async function answer(cred: string, id: string, ok: boolean, data?: Record<string, unknown>) {
  const r = await request(app)
    .post('/api/v1/agent/command-result')
    .set('Authorization', `Bearer ${cred}`)
    .send({ command_results: [{ id, ok, output: '', ...(data ? { data } : {}) }] });
  expect(r.status).toBe(200);
}

async function audits(orgId: string, action: string): Promise<Array<{ metadata: Record<string, unknown>; user_email: string | null; target_id: string | null }>> {
  return (await systemPool.query(`SELECT metadata, user_email, target_id FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;
}

/** A second person in the same organization, signed in there. */
async function addMember(owner: TestAccount, role: 'admin' | 'technician' | 'viewer'): Promise<TestAccount> {
  const other = await newAccount(`member-${role}`);
  const user = await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [other.email]);
  await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)`, [user.rows[0]!.id, owner.organizationId, role]);
  const sw = await other.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: owner.organizationId });
  expect(sw.status).toBe(200);
  return { ...other, organizationId: owner.organizationId, siteId: owner.siteId };
}

async function profiles(a: TestAccount): Promise<Record<string, FleetPermissionProfile>> {
  const r = await a.agent.get('/api/v1/fleet/profiles');
  expect(r.status).toBe(200);
  return Object.fromEntries((r.body.profiles as FleetPermissionProfile[]).map((p) => [p.builtin_key ?? p.name, p]));
}

async function groupFor(a: TestAccount, epId: string, policy: Record<string, unknown>): Promise<string> {
  const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: `G-${Math.random().toString(36).slice(2, 8)}`, ...policy });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const as = await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.body.group.id });
  expect(as.status).toBe(200);
  return g.body.group.id;
}

const start = (a: TestAccount, epId: string, body: Record<string, unknown> = {}) =>
  a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Ticket 77: printer', ...body });

async function enableMfa(a: TestAccount): Promise<string> {
  const setup = await a.agent.post('/api/v1/auth/mfa/setup').set(CSRF).send({});
  expect(setup.status).toBe(200);
  const confirm = await a.agent.post('/api/v1/auth/mfa/confirm').set(CSRF).send({ code: totp(base32Decode(setup.body.secret), Date.now()) });
  expect(confirm.status).toBe(200);
  return setup.body.secret;
}

function wrongCode(secret: string): string {
  const key = base32Decode(secret);
  const now = timeStep(Date.now());
  const valid = new Set([now - 2n, now - 1n, now, now + 1n, now + 2n].map((s) => hotp(key, s)));
  for (let i = 0; ; i++) {
    const c = String(100000 + i);
    if (!valid.has(c)) return c;
  }
}

/** A two-hour window around the current hour of `tz`, every day. */
function windowAroundNow(tz: string): { days: number[]; start: string; end: string } {
  const { minute } = localClock(new Date(), tz);
  const h = Math.floor(minute / 60);
  const pad = (n: number) => String((n + 24) % 24).padStart(2, '0');
  return { days: [0, 1, 2, 3, 4, 5, 6], start: `${pad(h - 1)}:00`, end: `${pad(h + 1)}:00` };
}

describe('fleet access policy: pure evaluation', () => {
  const full = { id: 'f', name: 'Full admin', builtin_key: 'full_admin', view: true, control: true, clipboard_in: true, clipboard_out: true, files: true, audio: true, record: true, restart: true, privacy_screen: true, block_input: true, shell: true } as FleetPermissionProfile;
  const viewOnly = { ...full, id: 'v', name: 'View only', builtin_key: 'view_only', control: false, clipboard_in: false, clipboard_out: false, files: false, audio: false, restart: false, privacy_screen: false, block_input: false, shell: false } as FleetPermissionProfile;
  const base: FleetAccessPolicy = {
    access_mode: 'attended',
    consent_timeout_s: 60,
    refuse_window_s: 0,
    allowed_hours: [],
    allowed_roles: ['owner', 'admin', 'technician'],
    default_profile_id: 'f',
    max_profile_id: 'f',
    mfa_required: false,
    approval_required: false,
    approval_ttl_minutes: 15,
    ip_allowlist: [],
  };
  const input = { policy: base, timezone: 'UTC', role: 'technician' as const, requestIp: '10.1.2.3', now: new Date(), operatorHasMfa: true, stepUp: 'absent' as const, requested: full, max: full };

  it('checks role, address, hours, MFA and the profile in that order, each with its code', () => {
    expect(evaluatePolicy({ ...input, role: 'viewer' })).toMatchObject({ ok: false, code: 'policy_role_not_allowed' });
    expect(evaluatePolicy({ ...input, policy: { ...base, allowed_roles: ['admin'] } })).toMatchObject({ ok: false, code: 'policy_role_not_allowed' });
    expect(evaluatePolicy({ ...input, policy: { ...base, ip_allowlist: ['192.168.0.0/16'] } })).toMatchObject({ ok: false, code: 'policy_ip_not_allowed' });
    expect(evaluatePolicy({ ...input, policy: { ...base, ip_allowlist: ['10.0.0.0/8'] } }).ok).toBe(true);
    expect(evaluatePolicy({ ...input, requestIp: null, policy: { ...base, ip_allowlist: ['10.0.0.0/8'] } })).toMatchObject({ ok: false, code: 'policy_ip_not_allowed' });
    const mfa = { ...base, mfa_required: true };
    expect(evaluatePolicy({ ...input, policy: mfa, operatorHasMfa: false })).toMatchObject({ ok: false, code: 'policy_mfa_not_enrolled' });
    expect(evaluatePolicy({ ...input, policy: mfa })).toMatchObject({ ok: false, code: 'policy_mfa_required' });
    expect(evaluatePolicy({ ...input, policy: mfa, stepUp: 'invalid' })).toMatchObject({ ok: false, code: 'policy_mfa_invalid' });
    expect(evaluatePolicy({ ...input, policy: mfa, stepUp: 'valid' })).toMatchObject({ ok: true, mfaVerified: true });
    // The role check comes first: a wrong role is refused before any MFA question.
    expect(evaluatePolicy({ ...input, role: 'viewer', policy: mfa })).toMatchObject({ code: 'policy_role_not_allowed' });
    expect(evaluatePolicy({ ...input, requested: { ...full, view: false } })).toMatchObject({ ok: false, code: 'profile_no_view' });
  });

  it('clamps the requested profile to the maximum and records what was removed', () => {
    const r = evaluatePolicy({ ...input, max: viewOnly });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.permissions).toMatchObject({ view: true, control: false, clipboard_in: false, record: true, shell: false });
    expect(r.clamped).toEqual(['control', 'clipboard_in', 'clipboard_out', 'files', 'audio', 'restart', 'privacy_screen', 'block_input', 'shell']);
    expect(r.trail.find((t) => t.check === 'profile')?.detail).toContain('limited by View only');
  });

  it('attended / unattended / refuse window / approval only for unattended', () => {
    expect(evaluatePolicy(input)).toMatchObject({ ok: true, attended: true, refuseWindowS: 0, approvalNeeded: false });
    // Approval is for unattended sessions only; an attended session has the user's own decision.
    expect(evaluatePolicy({ ...input, policy: { ...base, approval_required: true } })).toMatchObject({ attended: true, approvalNeeded: false });
    expect(evaluatePolicy({ ...input, policy: { ...base, access_mode: 'unattended', refuse_window_s: 20, approval_required: true } })).toMatchObject({
      attended: false,
      refuseWindowS: 20,
      approvalNeeded: true,
    });
    // A refuse window means nothing for attended (the user must accept anyway).
    expect(evaluatePolicy({ ...input, policy: { ...base, refuse_window_s: 20 } })).toMatchObject({ refuseWindowS: 0 });
  });

  it('allowed hours are wall-clock time of the site, windows can cross midnight', () => {
    // Wednesday 2026-11-25 23:30 UTC = Thursday 02:30 in Africa/Nairobi (UTC+3) and 18:30 in New York.
    const now = new Date('2026-11-25T23:30:00Z');
    const nightShift = { allowed_hours: [{ days: [3], start: '22:00', end: '06:00' }] };
    expect(withinHours(nightShift, now, 'UTC')).toBe(true);
    expect(withinHours(nightShift, now, 'Africa/Nairobi')).toBe(true); // Wednesday's window runs into Thursday 02:30
    expect(withinHours(nightShift, now, 'America/New_York')).toBe(false);
    expect(withinHours({ allowed_hours: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }] }, now, 'UTC')).toBe(false);
    expect(withinHours({ allowed_hours: [] }, now, 'UTC')).toBe(true);
  });

  it('addresses: IPv4-mapped IPv6 is the IPv4 address, IPv6 ranges work', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(ipAllowed(['127.0.0.0/8'], normalizeIp('::ffff:127.0.0.1'))).toBe(true);
    expect(ipAllowed(['fd00::/8'], 'fd12::5')).toBe(true);
    expect(ipAllowed(['fd00::/8'], '10.0.0.1')).toBe(false);
  });

  it('step-up tokens are bound to user, organization and sign-in session, and expire', () => {
    const ctx = { userId: 'u1', organizationId: 'o1', sessionId: 's1' };
    const t = issueStepUpToken(ctx).token;
    expect(checkStepUpToken(t, ctx)).toBe('valid');
    expect(checkStepUpToken(t, { ...ctx, sessionId: 's2' })).toBe('invalid');
    expect(checkStepUpToken(t, { ...ctx, userId: 'u2' })).toBe('invalid');
    expect(checkStepUpToken(t, { ...ctx, organizationId: 'o2' })).toBe('invalid');
    expect(checkStepUpToken(t, ctx, Date.now() + 301_000)).toBe('invalid');
    expect(checkStepUpToken(`${t.slice(0, -1)}${t.endsWith('0') ? '1' : '0'}`, ctx)).toBe('invalid');
    expect(checkStepUpToken(undefined, ctx)).toBe('absent');
  });
});

describe('fleet permission profiles, groups and access policy (API)', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('seeds the three built-ins, keeps them read-only (API and RLS), and lets admins manage custom profiles', async () => {
    const a = await newAccount('profiles');
    const p = await profiles(a);
    expect(Object.keys(p)).toEqual(['view_only', 'support', 'full_admin']);
    expect(p.view_only).toMatchObject({ view: true, control: false, record: true, clipboard_in: false });
    expect(p.support).toMatchObject({ control: true, clipboard_in: true, clipboard_out: true, files: true, restart: true, shell: false, audio: false });
    expect(p.full_admin).toMatchObject({ shell: true, block_input: true, privacy_screen: true });

    expect((await a.agent.patch(`/api/v1/fleet/profiles/${p.support!.id}`).set(CSRF).send({ shell: true })).body.error.code).toBe('profile_builtin');
    expect((await a.agent.delete(`/api/v1/fleet/profiles/${p.view_only!.id}`).set(CSRF)).body.error.code).toBe('profile_builtin');
    // Even a direct UPDATE as the app role changes nothing (RLS).
    const touched = await withTenant(a.organizationId, (db) => db.query(`UPDATE fleet_permission_profiles SET shell = true WHERE builtin_key IS NOT NULL`));
    expect(touched.rowCount).toBe(0);

    const created = await a.agent.post('/api/v1/fleet/profiles').set(CSRF).send({ name: 'Helpdesk', control: true, clipboard_in: true });
    expect(created.status).toBe(201);
    expect(created.body.profile).toMatchObject({ name: 'Helpdesk', view: true, control: true, clipboard_in: true, clipboard_out: false, builtin_key: null });
    expect((await a.agent.post('/api/v1/fleet/profiles').set(CSRF).send({ name: 'helpdesk' })).body.error.code).toBe('profile_name_taken');
    expect((await a.agent.post('/api/v1/fleet/profiles').set(CSRF).send({ name: 'X', unknown: true })).status).toBe(400);
    const patched = await a.agent.patch(`/api/v1/fleet/profiles/${created.body.profile.id}`).set(CSRF).send({ files: true });
    expect(patched.body.profile.files).toBe(true);

    // In use by a group: cannot be deleted, cannot grow past the group's maximum.
    const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Front desk', default_profile_id: created.body.profile.id, max_profile_id: p.support!.id });
    expect(g.status).toBe(201);
    expect((await a.agent.delete(`/api/v1/fleet/profiles/${created.body.profile.id}`).set(CSRF)).body.error.code).toBe('profile_in_use');
    expect((await a.agent.patch(`/api/v1/fleet/profiles/${created.body.profile.id}`).set(CSRF).send({ shell: true })).body.error.code).toBe('profile_default_exceeds_max');
    expect((await a.agent.delete(`/api/v1/fleet/groups/${g.body.group.id}`).set(CSRF)).status).toBe(200);
    expect((await a.agent.delete(`/api/v1/fleet/profiles/${created.body.profile.id}`).set(CSRF)).status).toBe(200);

    expect((await audits(a.organizationId, 'fleet.profile_created'))[0]?.metadata).toMatchObject({ name: 'Helpdesk' });
    expect(await audits(a.organizationId, 'fleet.profile_updated')).toHaveLength(1);
    expect(await audits(a.organizationId, 'fleet.profile_deleted')).toHaveLength(1);
    expect(await audits(a.organizationId, 'fleet.group_deleted')).toHaveLength(1);
  });

  it('roles: viewers see nothing, technicians read, only admins change profiles, groups and policy', async () => {
    const a = await newAccount('policy-roles');
    const tech = await addMember(a, 'technician');
    const viewer = await addMember(a, 'viewer');
    expect((await viewer.agent.get('/api/v1/fleet/profiles')).status).toBe(403);
    expect((await viewer.agent.get('/api/v1/fleet/groups')).status).toBe(403);
    expect((await tech.agent.get('/api/v1/fleet/profiles')).status).toBe(200);
    expect((await tech.agent.get('/api/v1/fleet/groups')).status).toBe(200);
    expect((await tech.agent.post('/api/v1/fleet/profiles').set(CSRF).send({ name: 'T' })).status).toBe(403);
    expect((await tech.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'T' })).status).toBe(403);
    expect((await tech.agent.get('/api/v1/fleet/approvals')).status).toBe(403);
    const { epId } = await onlineEndpoint(a);
    expect((await tech.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: null })).status).toBe(403);
    expect((await viewer.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/policy`)).status).toBe(403);
  });

  it('groups: create with defaults, validate the policy, bulk-assign endpoints, and fall back to the organization default', async () => {
    const a = await newAccount('groups');
    const p = await profiles(a);
    const e1 = await onlineEndpoint(a, 'PC-1');
    const e2 = await onlineEndpoint(a, 'PC-2');

    const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Servers', access_mode: 'unattended', ip_allowlist: ['10.0.0.7', '192.168.1.99/24', 'fd00::1/8'] });
    expect(g.status).toBe(201);
    expect(g.body.group).toMatchObject({
      name: 'Servers',
      access_mode: 'unattended',
      consent_timeout_s: 60,
      refuse_window_s: 0,
      allowed_roles: ['owner', 'admin', 'technician'],
      default_profile_id: p.support!.id,
      max_profile_id: p.full_admin!.id,
      ip_allowlist: ['10.0.0.7/32', '192.168.1.0/24', 'fd00::/8'],
      endpoint_count: 0,
    });
    const bad = [
      { name: 'B1', default_profile_id: p.full_admin!.id, max_profile_id: p.view_only!.id },
      { name: 'B2', refuse_window_s: 5 },
      { name: 'B3', allowed_hours: [{ days: [1], start: '09:00', end: '09:00' }] },
      { name: 'B4', allowed_hours: [{ days: [9], start: '09:00', end: '10:00' }] },
      { name: 'B5', ip_allowlist: ['not-an-ip'] },
      { name: 'B6', allowed_roles: ['viewer'] },
      { name: 'B7', allowed_roles: [] },
    ];
    for (const body of bad) {
      const r = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send(body);
      expect([400, 422], `${body.name}: ${JSON.stringify(r.body)}`).toContain(r.status);
    }
    expect((await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'servers' })).body.error.code).toBe('group_name_taken');

    const assign = await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [e1.epId, e2.epId], fleet_group_id: g.body.group.id });
    expect(assign.body.updated).toBe(2);
    const list = await a.agent.get(`/api/v1/endpoints?fleet_group=${g.body.group.id}`);
    expect(list.body.items.map((e: { name: string; fleet_group_name: string }) => [e.name, e.fleet_group_name]).sort()).toEqual([
      ['PC-1', 'Servers'],
      ['PC-2', 'Servers'],
    ]);
    expect((await a.agent.get('/api/v1/fleet/groups')).body.groups[0].endpoint_count).toBe(2);
    const pv = await a.agent.get(`/api/v1/endpoints/${e1.epId}/remote-desktop/policy`);
    expect(pv.body).toMatchObject({ source: 'group', group: { name: 'Servers' }, approval_needed: false, role_allowed: true, within_hours: true });
    expect(pv.body.profiles.map((x: FleetPermissionProfile) => x.builtin_key)).toEqual(['view_only', 'support', 'full_admin']);

    const upd = await a.agent.patch(`/api/v1/fleet/groups/${g.body.group.id}`).set(CSRF).send({ max_profile_id: p.support!.id, mfa_required: true });
    expect(upd.status).toBe(200);
    const pv2 = await a.agent.get(`/api/v1/endpoints/${e1.epId}/remote-desktop/policy`);
    expect(pv2.body.profiles.map((x: FleetPermissionProfile) => x.builtin_key)).toEqual(['view_only', 'support']);
    expect(pv2.body.policy.mfa_required).toBe(true);
    expect((await audits(a.organizationId, 'fleet.policy_updated'))[0]?.metadata).toMatchObject({ changed: ['max_profile_id', 'mfa_required'] });

    // Out of the group (and deleting a group) falls back to the organization default.
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [e2.epId], fleet_group_id: null });
    expect((await a.agent.get(`/api/v1/endpoints?fleet_group=none`)).body.items.map((e: { name: string }) => e.name)).toEqual(['PC-2']);
    expect((await a.agent.delete(`/api/v1/fleet/groups/${g.body.group.id}`).set(CSRF)).status).toBe(200);
    const fallback = await a.agent.get(`/api/v1/endpoints/${e1.epId}/remote-desktop/policy`);
    expect(fallback.body).toMatchObject({ source: 'organization_default', group: null, policy: { access_mode: 'unattended', mfa_required: false, default_profile_id: p.support!.id } });
    await a.agent.patch(`/api/v1/endpoints/${e1.epId}/policy`).set(CSRF).send({ remote_desktop_consent: 'prompt' });
    expect((await a.agent.get(`/api/v1/endpoints/${e1.epId}/remote-desktop/policy`)).body.policy.access_mode).toBe('attended');
    expect((await audits(a.organizationId, 'fleet.group_assigned')).map((x) => x.metadata.changed)).toEqual([2, 1]);
  });

  it('tenant isolation: another organization can neither see nor use groups, profiles, endpoints or approvals', async () => {
    const a = await newAccount('iso-a');
    const b = await newAccount('iso-b');
    const pa = await profiles(a);
    const { epId } = await onlineEndpoint(a);
    const ga = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'A only', access_mode: 'unattended', approval_required: true });
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: ga.body.group.id });

    expect((await b.agent.get('/api/v1/fleet/groups')).body.groups).toEqual([]);
    expect((await b.agent.patch(`/api/v1/fleet/groups/${ga.body.group.id}`).set(CSRF).send({ name: 'mine' })).status).toBe(404);
    expect((await b.agent.patch(`/api/v1/fleet/profiles/${(await a.agent.post('/api/v1/fleet/profiles').set(CSRF).send({ name: 'A custom' })).body.profile.id}`).set(CSRF).send({ shell: true })).status).toBe(404);
    // B cannot point its group at A's profiles, nor put A's endpoint in its group.
    expect((await b.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'steal', default_profile_id: pa.view_only!.id, max_profile_id: pa.full_admin!.id })).body.error.code).toBe('profile_not_found');
    const gb = await b.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'B' });
    expect((await b.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: gb.body.group.id })).status).toBe(404);
    expect((await b.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/policy`)).status).toBe(404);
    // A's pending approval is invisible to B and cannot be decided by B.
    const req = await start(a, epId);
    expect(req.body.session.state).toBe('waiting_approval');
    expect((await b.agent.get('/api/v1/fleet/approvals')).body.approvals).toEqual([]);
    expect((await b.agent.post(`/api/v1/fleet/approvals/${req.body.session.fleet_session_id}/approve`).set(CSRF).send({})).status).toBe(404);
    // B's own profiles are its own.
    const pb = await profiles(b);
    expect(pb.support!.id).not.toBe(pa.support!.id);
  });

  it('requires a reason, records the profile, permissions and trail, and tells the agent what is allowed', async () => {
    const a = await newAccount('session-perms');
    const p = await profiles(a);
    const { epId, cred } = await onlineEndpoint(a);
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({})).status).toBe(400);
    expect((await start(a, epId, { reason: '  ' })).status).toBe(400);

    // Organization default: unattended, Support.
    const s = await start(a, epId);
    expect(s.status).toBe(200);
    expect(s.body.session).toMatchObject({ state: 'active', profile_name: 'Support', permissions: { control: true, clipboard_in: true, shell: false } });
    const open = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
    expect(open.payload).toMatchObject({ consent_required: false, refuse_window_s: 0, control: true, permissions: { view: true, control: true, files: true, shell: false }, profile: 'Support' });

    // A group whose maximum is View only clamps a Support request.
    await groupFor(a, epId, { access_mode: 'unattended', max_profile_id: p.view_only!.id, default_profile_id: p.view_only!.id });
    const clamped = await start(a, epId, { profile_id: p.full_admin!.id });
    expect(clamped.status).toBe(200);
    expect(clamped.body.session.permissions).toMatchObject({ view: true, control: false, clipboard_in: false, clipboard_out: false, shell: false });
    const open2 = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
    expect(open2.payload).toMatchObject({ control: false, permissions: { control: false } });
    const row = (await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0];
    expect(row).toMatchObject({ profile_name: 'Full admin', group_name: expect.stringMatching(/^G-/), permissions: { control: false }, reason: 'Ticket 77: printer' });
    expect(row.policy_trail.map((t: { check: string }) => t.check)).toEqual(['role', 'ip', 'hours', 'mfa', 'profile', 'mode']);
    expect(row.request_ip).toMatch(/127\.0\.0\.1|::1/);
    const requested = await audits(a.organizationId, 'fleet.session_requested');
    expect(requested.at(-1)?.metadata).toMatchObject({ profile: 'Full admin', clamped: expect.arrayContaining(['control', 'shell']), policy_source: 'group' });

    // A profile that cannot see the screen cannot open a remote desktop.
    const blind = await a.agent.post('/api/v1/fleet/profiles').set(CSRF).send({ name: 'Blind', view: false });
    expect((await start(a, epId, { profile_id: blind.body.profile.id })).body.error.code).toBe('profile_no_view');
    expect((await start(a, epId, { profile_id: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('profile_not_found');
  });

  it('refuses actions the session profile does not allow, at the API, and audits them', async () => {
    const a = await newAccount('enforce');
    const p = await profiles(a);
    const { epId } = await onlineEndpoint(a);
    await groupFor(a, epId, { access_mode: 'unattended', default_profile_id: p.view_only!.id });
    expect((await start(a, epId)).body.session.permissions.control).toBe(false);
    const cmd = (body: Record<string, unknown>) => a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send(body);
    expect((await cmd({ kind: 'rd_capture' })).status).toBe(202);
    const input = await cmd({ kind: 'rd_input', event_kind: 'key_press', key: 'Enter' });
    expect(input.status).toBe(403);
    expect(input.body.error.code).toBe('profile_forbids_control');
    expect((await cmd({ kind: 'rd_input', event_kind: 'mouse_move', x: 0.2, y: 0.3 })).body.error.code).toBe('profile_forbids_control');
    expect((await cmd({ kind: 'fs_op', op: 'list', path: 'C:\\Users' })).body.error.code).toBe('profile_forbids_files');
    expect((await cmd({ kind: 'power_action', action: 'restart' })).body.error.code).toBe('profile_forbids_restart');
    expect((await cmd({ kind: 'power_action', action: 'lock' })).status).toBe(202);
    const refused = await audits(a.organizationId, 'fleet.session_refused_action');
    // Pointer moves are refused but not audited (too many).
    expect(refused.map((r) => r.metadata.code)).toEqual(['profile_forbids_control', 'profile_forbids_files', 'profile_forbids_restart']);
    expect(refused[0]?.metadata).toMatchObject({ kind: 'rd_input', via: 'http', needs: 'control' });

    // Another admin (not the session holder) still uses the file manager under their role.
    const other = await addMember(a, 'admin');
    expect((await other.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'fs_op', op: 'list', path: 'C:\\Users' })).status).toBe(202);
    // ... but frames and input of the session belong to its operators only (multi-operator, migration 036).
    expect((await other.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_input', event_kind: 'text', text: 'x' })).body.error.code).toBe('not_a_participant');
  });

  it('attended: the user accepts within the group timeout; unattended refuse window: only a refusal stops it', async () => {
    const a = await newAccount('modes');
    const { epId, cred } = await onlineEndpoint(a);
    const gid = await groupFor(a, epId, { access_mode: 'attended', consent_timeout_s: 25 });
    const s = await start(a, epId);
    expect(s.body.session.state).toBe('waiting_consent');
    const open = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
    expect(open.payload).toMatchObject({ consent_required: true, consent_timeout_s: 25, refuse_window_s: 0 });
    await answer(cred, open.id, true, { consent: 'timeout', banner: 'pending' });
    expect((await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0]).toMatchObject({ end_reason: 'consent_timeout', consent_timeout_s: 25 });

    await a.agent.patch(`/api/v1/fleet/groups/${gid}`).set(CSRF).send({ access_mode: 'unattended', refuse_window_s: 15 });
    const cases: Array<[string, string, string | null]> = [
      ['timeout', 'not_refused', null],
      ['accepted', 'accepted', null],
      ['unavailable', 'unavailable', null],
      ['denied', 'denied', 'consent_denied'],
    ];
    for (const [agentSays, recorded, ended] of cases) {
      const r = await start(a, epId);
      expect(r.body.session.state).toBe('waiting_consent');
      const o = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
      expect(o.payload).toMatchObject({ consent_required: false, refuse_window_s: 15 });
      // Nothing is seen while the window runs.
      expect((await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_capture' })).body.error.code).toBe('consent_pending');
      await answer(cred, o.id, true, { consent: agentSays, banner: 'shown', ...(agentSays === 'unavailable' ? { consent_error: 'nobody signed in' } : {}) });
      const row = (await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0];
      expect(row, agentSays).toMatchObject({ consent_result: recorded, refuse_window_s: 15, state: ended ? 'ended' : 'active', end_reason: ended });
    }
  });

  it('allowed hours: inside and outside, in the site time zone', async () => {
    const a = await newAccount('hours');
    const { epId } = await onlineEndpoint(a);
    // Kiritimati is UTC+14: a window around its current hour is never the current hour in UTC.
    await systemPool.query(`UPDATE sites SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [a.siteId]);
    const gid = await groupFor(a, epId, { access_mode: 'unattended', allowed_hours: [windowAroundNow('Pacific/Kiritimati')] });
    expect((await start(a, epId)).status).toBe(200);
    await systemPool.query(`UPDATE sites SET timezone = 'UTC' WHERE id = $1`, [a.siteId]);
    const out = await start(a, epId);
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe('policy_outside_hours');
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/policy`)).body.within_hours).toBe(false);
    await a.agent.patch(`/api/v1/fleet/groups/${gid}`).set(CSRF).send({ allowed_hours: [windowAroundNow('UTC')] });
    expect((await start(a, epId)).status).toBe(200);
    const refused = await audits(a.organizationId, 'fleet.policy_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.metadata).toMatchObject({ code: 'policy_outside_hours', policy_source: 'group' });
  });

  it('operator roles and the IP allow-list', async () => {
    const a = await newAccount('roles-ip');
    const { epId } = await onlineEndpoint(a);
    const gid = await groupFor(a, epId, { access_mode: 'unattended', allowed_roles: ['owner', 'admin'] });
    const tech = await addMember(a, 'technician');
    expect((await start(tech, epId)).body.error.code).toBe('policy_role_not_allowed');
    expect((await tech.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/policy`)).body.role_allowed).toBe(false);
    expect((await start(a, epId)).status).toBe(200);

    await a.agent.patch(`/api/v1/fleet/groups/${gid}`).set(CSRF).send({ ip_allowlist: ['10.0.0.0/8'] });
    expect((await start(a, epId)).body.error.code).toBe('policy_ip_not_allowed');
    // X-Forwarded-For from the loopback proxy is honoured (TRUST_PROXY=loopback), like the web's /api proxy.
    const viaProxy = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).set('X-Forwarded-For', '10.9.8.7').send({ reason: 'via proxy' });
    expect(viaProxy.status).toBe(200);
    await a.agent.patch(`/api/v1/fleet/groups/${gid}`).set(CSRF).send({ ip_allowlist: ['127.0.0.0/8', '::1/128'] });
    expect((await start(a, epId)).status).toBe(200);
    expect((await audits(a.organizationId, 'fleet.policy_refused')).map((r) => r.metadata.code)).toEqual(['policy_role_not_allowed', 'policy_ip_not_allowed']);
  });

  it('MFA to connect: missing, wrong, replayed, locked, then a valid step-up', async () => {
    const a = await newAccount('mfa-connect');
    const { epId } = await onlineEndpoint(a);
    await groupFor(a, epId, { access_mode: 'unattended', mfa_required: true });
    expect((await start(a, epId)).body.error.code).toBe('policy_mfa_not_enrolled');
    expect((await a.agent.post('/api/v1/fleet/step-up').set(CSRF).send({ code: '123456' })).body.error.code).toBe('policy_mfa_not_enrolled');
    const secret = await enableMfa(a);
    expect((await start(a, epId)).body.error.code).toBe('policy_mfa_required');
    expect((await start(a, epId, { step_up_token: 'fsu1.9999999999.' + 'a'.repeat(64) })).body.error.code).toBe('policy_mfa_invalid');

    expect((await a.agent.post('/api/v1/fleet/step-up').set(CSRF).send({ code: wrongCode(secret) })).body.error.code).toBe('invalid_mfa_code');
    const code = totp(base32Decode(secret), Date.now() + 30_000);
    const ok = await a.agent.post('/api/v1/fleet/step-up').set(CSRF).send({ code });
    expect(ok.status).toBe(200);
    expect(ok.body.step_up_token).toMatch(/^fsu1\./);
    // The same code again is a replay (mfa_last_step).
    expect((await a.agent.post('/api/v1/fleet/step-up').set(CSRF).send({ code })).body.error.code).toBe('invalid_mfa_code');

    const s = await start(a, epId, { step_up_token: ok.body.step_up_token });
    expect(s.status).toBe(200);
    expect((await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0].mfa_verified).toBe(true);
    // Another user cannot use this token.
    const other = await addMember(a, 'admin');
    expect((await start(other, epId, { step_up_token: ok.body.step_up_token })).body.error.code).toBe('policy_mfa_not_enrolled');

    // Five wrong codes lock the factor (shared with sign-in).
    for (let i = 0; i < 3; i++) await a.agent.post('/api/v1/fleet/step-up').set(CSRF).send({ code: wrongCode(secret) });
    const fifth = await a.agent.post('/api/v1/fleet/step-up').set(CSRF).send({ code: wrongCode(secret) });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('mfa_locked');
    expect((await a.agent.post('/api/v1/fleet/step-up').set(CSRF).send({ code: totp(base32Decode(secret), Date.now() + 60_000) })).body.error.code).toBe('mfa_locked');
    expect((await audits(a.organizationId, 'fleet.policy_mfa_failed')).length).toBe(6);
    expect(await audits(a.organizationId, 'fleet.policy_mfa_verified')).toHaveLength(1);
    // A step-up token never appears in the audit log.
    const all = await systemPool.query(`SELECT metadata::text AS m FROM audit_logs WHERE organization_id = $1`, [a.organizationId]);
    expect(all.rows.some((r) => String(r.m).includes(ok.body.step_up_token))).toBe(false);
  });

  it('second-admin approval: self-approval refused, approve, deny, and expiry', async () => {
    const a = await newAccount('approval');
    const { epId, cred } = await onlineEndpoint(a);
    await groupFor(a, epId, { access_mode: 'unattended', approval_required: true, approval_ttl_minutes: 5 });
    const second = await addMember(a, 'admin');

    const s = await start(a, epId);
    expect(s.status).toBe(200);
    expect(s.body.session.state).toBe('waiting_approval');
    // Nothing reaches the computer before the approval.
    expect((await pollFor(cred)).filter((c) => c.kind === 'rd_session_open')).toEqual([]);
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_capture' })).body.error.code).toBe('consent_pending');
    const fsId: string = s.body.session.fleet_session_id;
    const pending = await second.agent.get('/api/v1/fleet/approvals');
    expect(pending.body.approvals.map((x: { id: string }) => x.id)).toEqual([fsId]);
    expect(pending.body.approvals[0]).toMatchObject({ operator_email: a.email, reason: 'Ticket 77: printer', approval_state: 'pending' });

    const self = await a.agent.post(`/api/v1/fleet/approvals/${fsId}/approve`).set(CSRF).send({});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('approval_self');
    const ok = await second.agent.post(`/api/v1/fleet/approvals/${fsId}/approve`).set(CSRF).send({ note: 'ok, ticket checked' });
    expect(ok.body).toMatchObject({ ok: true, state: 'active' });
    const open = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
    expect(open.payload).toMatchObject({ session_id: s.body.session.id, operator: a.email, consent_required: false });
    const row = (await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0];
    expect(row).toMatchObject({ state: 'active', approval_state: 'approved', approver_email: second.email, approval_note: 'ok, ticket checked' });
    expect(row.policy_trail.at(-1)).toMatchObject({ check: 'approval', result: 'pass' });
    expect((await second.agent.post(`/api/v1/fleet/approvals/${fsId}/approve`).set(CSRF).send({})).body.error.code).toBe('approval_not_pending');

    // Denied: the request ends; the requester sees why.
    const d = await start(a, epId);
    const denied = await second.agent.post(`/api/v1/fleet/approvals/${d.body.session.fleet_session_id}/deny`).set(CSRF).send({ note: 'not now' });
    expect(denied.status).toBe(200);
    expect((await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0]).toMatchObject({ state: 'ended', end_reason: 'approval_denied', approval_state: 'denied', approver_email: second.email });

    // Expired: past its time, no decision is possible and the request ends.
    const e = await start(a, epId);
    await systemPool.query(`UPDATE fleet_sessions SET approval_expires_at = now() - interval '1 second' WHERE id = $1`, [e.body.session.fleet_session_id]);
    const late = await second.agent.post(`/api/v1/fleet/approvals/${e.body.session.fleet_session_id}/approve`).set(CSRF).send({});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('approval_expired');
    expect((await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0]).toMatchObject({ state: 'ended', end_reason: 'approval_expired', approval_state: 'expired' });
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`)).body.session).toBeNull();

    // Expiry is also applied when the list is read.
    const e2 = await start(a, epId);
    await systemPool.query(`UPDATE fleet_sessions SET approval_expires_at = now() - interval '1 second' WHERE id = $1`, [e2.body.session.fleet_session_id]);
    expect((await second.agent.get('/api/v1/fleet/approvals')).body.approvals).toEqual([]);
    const decided = (await second.agent.get('/api/v1/fleet/approvals?state=decided')).body.approvals.map((x: { approval_state: string }) => x.approval_state);
    expect(decided.sort()).toEqual(['approved', 'denied', 'expired', 'expired']);

    const actions = (await systemPool.query<{ action: string }>(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'fleet.session_approv%' ORDER BY created_at, id`, [a.organizationId])).rows.map((r) => r.action);
    expect(actions).toEqual([
      'fleet.session_approval_requested',
      'fleet.session_approved',
      'fleet.session_approval_requested',
      'fleet.session_approval_denied',
      'fleet.session_approval_requested',
      'fleet.session_approval_expired',
      'fleet.session_approval_requested',
      'fleet.session_approval_expired',
    ]);
  });
});
