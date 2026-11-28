import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FleetPermissionProfile, FleetPermissions } from '@nigafiy/shared-types';
import { systemPool } from '../src/infrastructure/db.ts';
import { toolNeedOf, toolPolicyRefusal } from '../src/modules/endpoints/fleet-policy/enforce.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Audit item 4 (2026-11-27): outside a remote desktop session the file manager, power actions and
// script jobs follow the computer's group policy too (role, address, hours, the group's maximum).

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };
const pollFor = async (cred: string): Promise<Cmd[]> => (await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({})).body.commands;

const audits = async (orgId: string, action: string) =>
  (await systemPool.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;

async function profiles(a: TestAccount): Promise<Record<string, FleetPermissionProfile>> {
  const r = await a.agent.get('/api/v1/fleet/profiles');
  expect(r.status).toBe(200);
  return Object.fromEntries((r.body.profiles as FleetPermissionProfile[]).map((p) => [p.builtin_key ?? p.name, p]));
}

async function groupFor(a: TestAccount, epId: string, policy: Record<string, unknown>): Promise<string> {
  const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: `T-${Math.random().toString(36).slice(2, 8)}`, ...policy });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  expect((await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.body.group.id })).status).toBe(200);
  return g.body.group.id;
}

const ALL: FleetPermissions = { view: true, control: true, clipboard_in: true, clipboard_out: true, files: true, audio: true, record: true, restart: true, privacy_screen: true, block_input: true, shell: true };

describe('group policy for tools outside a session (pure)', () => {
  const policy = { allowed_roles: ['owner', 'admin'] as const, ip_allowlist: [] as string[], allowed_hours: [] };
  const base = { policy: { ...policy, allowed_roles: [...policy.allowed_roles] }, timezone: 'UTC', max: ALL, role: 'admin', requestIp: '10.0.0.5', now: new Date() };

  it('checks role, address, hours and the maximum flag', () => {
    expect(toolPolicyRefusal({ ...base, need: 'files' })).toBeNull();
    expect(toolPolicyRefusal({ ...base, need: 'files', role: 'technician' })?.code).toBe('policy_role_not_allowed');
    expect(toolPolicyRefusal({ ...base, need: 'files', role: 'viewer' })?.code).toBe('policy_role_not_allowed');
    expect(toolPolicyRefusal({ ...base, need: 'files', policy: { ...base.policy, ip_allowlist: ['192.168.0.0/16'] } })?.code).toBe('policy_ip_not_allowed');
    expect(toolPolicyRefusal({ ...base, need: 'files', max: { ...ALL, files: false } })?.code).toBe('profile_forbids_files');
    expect(toolPolicyRefusal({ ...base, need: 'restart', max: { ...ALL, restart: false } })?.code).toBe('profile_forbids_restart');
    // A job the scheduler sends: no address, no hours, no flag; the role still counts.
    expect(toolPolicyRefusal({ ...base, requestIp: undefined, now: undefined, policy: { ...base.policy, ip_allowlist: ['192.168.0.0/16'] } })).toBeNull();
    expect(toolPolicyRefusal({ ...base, requestIp: undefined, now: undefined, role: 'technician' })?.code).toBe('policy_role_not_allowed');
  });

  it('knows which commands it governs', () => {
    expect(toolNeedOf({ kind: 'fs_op' })).toBe('files');
    expect(toolNeedOf({ kind: 'power_action', action: 'restart' })).toBe('restart');
    expect(toolNeedOf({ kind: 'power_action', action: 'lock' })).toBeNull();
    expect(toolNeedOf({ kind: 'notify_user' })).toBeNull();
  });
});

describe('group policy for tools outside a session (API)', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('refuses file manager and power the group does not allow, and audits it', async () => {
    const a = await newAccount('tool-policy');
    const p = await profiles(a);
    const { epId } = await onlineEndpoint(a);
    const cmd = (body: Record<string, unknown>) => a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send(body);

    // No group: the organization default (owner, admin, technician; up to Full admin).
    expect((await cmd({ kind: 'fs_op', op: 'list', path: 'C:\\Users' })).status).toBe(202);

    const gid = await groupFor(a, epId, { access_mode: 'unattended', default_profile_id: p.view_only!.id, max_profile_id: p.view_only!.id });
    const files = await cmd({ kind: 'fs_op', op: 'list', path: 'C:\\Users' });
    expect(files.status).toBe(403);
    expect(files.body.error.code).toBe('profile_forbids_files');
    expect((await cmd({ kind: 'power_action', action: 'restart' })).body.error.code).toBe('profile_forbids_restart');
    expect((await cmd({ kind: 'power_action', action: 'lock' })).status).toBe(202);

    // A Support maximum allows both again; an address list the request is not in refuses.
    await a.agent.patch(`/api/v1/fleet/groups/${gid}`).set(CSRF).send({ max_profile_id: p.support!.id });
    expect((await cmd({ kind: 'fs_op', op: 'list', path: 'C:\\Users' })).status).toBe(202);
    await a.agent.patch(`/api/v1/fleet/groups/${gid}`).set(CSRF).send({ ip_allowlist: ['10.123.0.0/16'] });
    expect((await cmd({ kind: 'fs_op', op: 'list', path: 'C:\\Users' })).body.error.code).toBe('policy_ip_not_allowed');

    const refused = await audits(a.organizationId, 'fleet.policy_refused_action');
    expect(refused.map((r) => r.metadata.code)).toEqual(['profile_forbids_files', 'profile_forbids_restart', 'policy_ip_not_allowed']);
    expect(refused[0]!.metadata).toMatchObject({ kind: 'fs_op', via: 'http', needs: 'files' });
  });

  it('does not send a script job to a computer whose group does not allow the creator’s role', async () => {
    const a = await newAccount('tool-policy-job');
    const { epId, cred } = await onlineEndpoint(a);
    await groupFor(a, epId, { access_mode: 'unattended', allowed_roles: ['admin', 'technician'] });
    const s = await a.agent.post('/api/v1/fleet/scripts').set(CSRF).send({ name: 'hello', os: 'windows', body: 'Write-Output hi' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const job = await a.agent.post('/api/v1/fleet/jobs').set(CSRF).send({ script_id: s.body.id, target: { kind: 'endpoints', endpoint_ids: [epId] }, schedule: { kind: 'now' } });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    expect((await pollFor(cred)).filter((c) => c.kind === 'script_run')).toEqual([]);
    const d = (await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body;
    expect(d.runs[0].results[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/does not allow your role/) });
    expect((await audits(a.organizationId, 'fleet.job_result')).at(-1)!.metadata).toMatchObject({ state: 'failed', error: 'policy_role_not_allowed' });
  });

  it('sends a script only where the group maximum allows the shell', async () => {
    const a = await newAccount('tool-policy-shell');
    const p = await profiles(a);
    const capped = await onlineEndpoint(a, 'SHELL-NO');
    const open = await onlineEndpoint(a, 'SHELL-YES');
    const free = await onlineEndpoint(a, 'NO-GROUP');
    await groupFor(a, capped.epId, { access_mode: 'unattended', default_profile_id: p.support!.id, max_profile_id: p.support!.id });
    await groupFor(a, open.epId, { access_mode: 'unattended', default_profile_id: p.support!.id, max_profile_id: p.full_admin!.id });
    const s = await a.agent.post('/api/v1/fleet/scripts').set(CSRF).send({ name: 'hello', os: 'windows', body: 'Write-Output hi' });
    const job = await a.agent
      .post('/api/v1/fleet/jobs')
      .set(CSRF)
      .send({ script_id: s.body.id, target: { kind: 'endpoints', endpoint_ids: [capped.epId, open.epId, free.epId] }, schedule: { kind: 'now' } });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    expect((await pollFor(capped.cred)).filter((c) => c.kind === 'script_run')).toEqual([]);
    expect((await pollFor(open.cred)).filter((c) => c.kind === 'script_run')).toHaveLength(1);
    expect((await pollFor(free.cred)).filter((c) => c.kind === 'script_run')).toHaveLength(1);
    const results = (await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body.runs[0].results as Array<{ endpoint_id: string; state: string; error: string | null }>;
    expect(results.find((r) => r.endpoint_id === capped.epId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/scripts or a remote shell/) });
  });
});
