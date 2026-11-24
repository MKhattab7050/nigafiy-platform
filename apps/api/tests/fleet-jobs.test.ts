import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { runDueJobs } from '../src/modules/endpoints/fleet-jobs/jobs.ts';
import { agentParams, resolveParamValues } from '../src/modules/endpoints/fleet-jobs/params.ts';
import { nextOccurrence, zonedTime } from '../src/modules/endpoints/fleet-jobs/schedule.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Fleet Pro: scripts library and jobs (migration 042): typed parameters validated on the server and
// sent as data (never pasted into the script), versions, technician rules, run now, scheduled runs
// (once, recurring in a time zone, maintenance windows), offline catch-up and expiry, results per
// computer with the full output downloadable, rerun failed, cancel, and the audit trail.

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };

const pollFor = async (cred: string): Promise<Cmd[]> => (await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({})).body.commands;

async function answer(cred: string, id: string, ok: boolean, data?: Record<string, unknown>, error?: string) {
  const r = await request(app)
    .post('/api/v1/agent/command-result')
    .set('Authorization', `Bearer ${cred}`)
    .send({ command_results: [{ id, ok, output: '', ...(data ? { data } : {}), ...(error ? { error } : {}) }] });
  expect(r.status).toBe(200);
}

const heartbeat = (cred: string) =>
  request(app)
    .post('/api/v1/agent/heartbeat')
    .set('Authorization', `Bearer ${cred}`)
    .send({ agent_version: '0.3.0', hostname: 'PC', os: 'windows', arch: 'amd64', uptime_seconds: 3600, cpu_pct: 5, ram_used_mb: 1000, ram_pct: 20 });

const audits = async (orgId: string, action: string) =>
  (await systemPool.query<{ metadata: Record<string, unknown>; user_email: string | null }>(`SELECT metadata, user_email FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;

async function addMember(owner: TestAccount, role: 'admin' | 'technician' | 'viewer'): Promise<TestAccount> {
  const other = await newAccount(`member-${role}`);
  const user = await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [other.email]);
  await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)`, [user.rows[0]!.id, owner.organizationId, role]);
  expect((await other.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: owner.organizationId })).status).toBe(200);
  return { ...other, organizationId: owner.organizationId, siteId: owner.siteId };
}

const PS_BODY = 'param([string]$Path, [int]$Days = 7, [switch]$WhatIf, [string]$Mode)\nGet-ChildItem -Path $Path | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$Days) }\n';
const PS_PARAMS = [
  { name: 'Path', type: 'string', label: 'Folder', required: true, max_length: 260 },
  { name: 'Days', type: 'int', min: 1, max: 365, default: 7 },
  { name: 'WhatIf', type: 'bool', default: true },
  { name: 'Mode', type: 'choice', choices: ['list', 'delete'], default: 'list' },
];

async function newScript(a: TestAccount, extra: Record<string, unknown> = {}) {
  const r = await a.agent
    .post('/api/v1/fleet/scripts')
    .set(CSRF)
    .send({ name: `Clean temp ${Math.random().toString(36).slice(2, 7)}`, os: 'windows', body: PS_BODY, parameters: PS_PARAMS, timeout_s: 120, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; current_version: number; current: { body_sha256: string } };
}

const createJob = (a: TestAccount, body: Record<string, unknown>) => a.agent.post('/api/v1/fleet/jobs').set(CSRF).send(body);

describe('fleet: script parameters (pure)', () => {
  const declared = PS_PARAMS.map((p) => ({ label: null, required: false, default: null, choices: null, min: null, max: null, max_length: null, ...p })) as never;

  it('checks types, bounds, choices and required values, fills defaults and refuses unknown names', () => {
    expect(resolveParamValues(declared, { Path: 'C:\\Temp' })).toEqual({ Path: 'C:\\Temp', Days: 7, WhatIf: true, Mode: 'list' });
    const bad = (given: Record<string, unknown>) => {
      try {
        resolveParamValues(declared, given);
        return null;
      } catch (err) {
        return (err as { code: string; message: string }).message;
      }
    };
    expect(bad({})).toMatch(/Path: a value is required/);
    expect(bad({ Path: 'x', Days: '7' })).toMatch(/Days must be a whole number/);
    expect(bad({ Path: 'x', Days: 400 })).toMatch(/at most 365/);
    expect(bad({ Path: 'x', Mode: 'format' })).toMatch(/must be one of: list, delete/);
    expect(bad({ Path: 'x', WhatIf: 'yes' })).toMatch(/true or false/);
    expect(bad({ Path: 'x', Extra: 1 })).toMatch(/no such parameter/);
    expect(bad({ Path: 'a\0b' })).toMatch(/NUL/);
    expect(bad({ Path: 'x'.repeat(261) })).toMatch(/longer than 260/);
  });

  it('hands the agent typed values in declared order: a hostile value stays a value', () => {
    const hostile = `'; Remove-Item C:\\ -Recurse; $(whoami) \`n "quoted"`;
    const v = resolveParamValues(declared, { Path: hostile, Days: 3, WhatIf: false });
    expect(agentParams(declared, v)).toEqual([
      { name: 'Path', type: 'string', value: hostile },
      { name: 'Days', type: 'int', value: '3' },
      { name: 'WhatIf', type: 'bool', value: 'false' },
      { name: 'Mode', type: 'choice', value: 'list' },
    ]);
  });
});

describe('fleet: schedules in a time zone (pure)', () => {
  it('runs daily at a wall-clock time across daylight saving changes', () => {
    const tz = 'Europe/Berlin';
    // 2026-03-29 is the spring change in Europe (02:00 → 03:00).
    expect(zonedTime(2026, 3, 28, 3, 0, tz).toISOString()).toBe('2026-03-28T02:00:00.000Z');
    expect(zonedTime(2026, 3, 30, 3, 0, tz).toISOString()).toBe('2026-03-30T01:00:00.000Z');
    // 02:30 does not exist that night: it moves forward by the gap.
    expect(zonedTime(2026, 3, 29, 2, 30, tz).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // 2026-10-25 02:30 exists twice: the first one.
    expect(zonedTime(2026, 10, 25, 2, 30, tz).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    const daily = { every: 'daily' as const, time: '03:00', weekdays: null, monthday: null };
    expect(nextOccurrence(daily, new Date('2026-03-28T02:00:00Z'), tz).toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(nextOccurrence(daily, new Date('2026-03-28T01:59:00Z'), tz).toISOString()).toBe('2026-03-28T02:00:00.000Z');
  });

  it('weekly on chosen days, monthly on a day, hourly at a minute', () => {
    const weekly = { every: 'weekly' as const, time: '22:15', weekdays: [1, 4], monthday: null };
    // 2026-11-24 is a Tuesday: next is Thursday 26th 22:15 in Cairo (UTC+2).
    expect(nextOccurrence(weekly, new Date('2026-11-24T10:00:00Z'), 'Africa/Cairo').toISOString()).toBe('2026-11-26T20:15:00.000Z');
    const monthly = { every: 'monthly' as const, time: '01:00', weekdays: null, monthday: 1 };
    expect(nextOccurrence(monthly, new Date('2026-11-24T10:00:00Z'), 'UTC').toISOString()).toBe('2026-12-01T01:00:00.000Z');
    const hourly = { every: 'hourly' as const, time: '00:05', weekdays: null, monthday: null };
    expect(nextOccurrence(hourly, new Date('2026-11-24T10:07:00Z'), 'UTC').toISOString()).toBe('2026-11-24T11:05:00.000Z');
  });
});

describe('fleet: scripts and jobs', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('admins create versioned scripts; technicians see and run only those marked for them; viewers see none', async () => {
    const a = await newAccount('scripts');
    const tech = await addMember(a, 'technician');
    const viewer = await addMember(a, 'viewer');
    const s = await newScript(a);
    expect(s.current_version).toBe(1);
    // Parameter declarations are validated.
    const badParams = await a.agent
      .post('/api/v1/fleet/scripts')
      .set(CSRF)
      .send({ name: 'bad', os: 'windows', body: 'Write-Output 1', parameters: [{ name: 'args', type: 'string' }] });
    expect(badParams.status).toBe(400);
    const dup = await a.agent
      .post('/api/v1/fleet/scripts')
      .set(CSRF)
      .send({ name: 'dup', os: 'linux', body: 'echo 1', parameters: [{ name: 'X', type: 'string' }, { name: 'x', type: 'int' }] });
    expect(dup.status).toBe(400);
    const choice = await a.agent.post('/api/v1/fleet/scripts').set(CSRF).send({ name: 'c', os: 'linux', body: 'echo 1', parameters: [{ name: 'M', type: 'choice' }] });
    expect(choice.status).toBe(400);
    // Technicians and viewers cannot write scripts.
    expect((await tech.agent.post('/api/v1/fleet/scripts').set(CSRF).send({ name: 't', os: 'windows', body: 'x' })).status).toBe(403);
    expect((await viewer.agent.get('/api/v1/fleet/scripts')).status).toBe(403);
    expect((await viewer.agent.get('/api/v1/fleet/jobs')).status).toBe(403);
    // A technician does not see a script that is not runnable by technicians.
    expect((await tech.agent.get('/api/v1/fleet/scripts')).body.scripts).toEqual([]);
    expect((await tech.agent.get(`/api/v1/fleet/scripts/${s.id}`)).status).toBe(404);

    // Metadata keeps the version; a new body makes version 2; the old version stays readable.
    const meta = await a.agent.patch(`/api/v1/fleet/scripts/${s.id}`).set(CSRF).send({ technician_runnable: true });
    expect(meta.body.current_version).toBe(1);
    const v2 = await a.agent.patch(`/api/v1/fleet/scripts/${s.id}`).set(CSRF).send({ body: `${PS_BODY}Write-Output done\n`, note: 'say done' });
    expect(v2.body.current_version).toBe(2);
    expect((await a.agent.get(`/api/v1/fleet/scripts/${s.id}/versions/1`)).body.body).toBe(PS_BODY);
    expect((await a.agent.get(`/api/v1/fleet/scripts/${s.id}`)).body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await tech.agent.get('/api/v1/fleet/scripts')).body.scripts.map((x: { id: string }) => x.id)).toEqual([s.id]);

    // The audit keeps the body's SHA-256 and the parameter names, never the body.
    const created = await audits(a.organizationId, 'fleet.script_created');
    expect(created.at(-1)!.metadata).toMatchObject({ body_sha256: s.current.body_sha256, parameters: ['Path:string', 'Days:int', 'WhatIf:bool', 'Mode:choice'] });
    expect(JSON.stringify(created)).not.toContain('Get-ChildItem');
    expect((await audits(a.organizationId, 'fleet.script_updated')).map((x) => x.metadata.new_version)).toEqual([false, true]);

    // Archive: no new jobs.
    const ep = await onlineEndpoint(a, 'SCR-PC-01');
    expect((await a.agent.post(`/api/v1/fleet/scripts/${s.id}/archive`).set(CSRF)).status).toBe(200);
    const refused = await createJob(a, { script_id: s.id, parameters: { Path: 'C:\\' }, target: { kind: 'endpoints', endpoint_ids: [ep.epId] }, schedule: { kind: 'now' } });
    expect(refused.body.error.code).toBe('script_archived');
  });

  it('runs now: the agent gets the stored body and the typed values; results, full output and audit', async () => {
    const a = await newAccount('job-now');
    const ep = await onlineEndpoint(a, 'JOB-PC-01');
    const linux = await onlineEndpoint(a, 'JOB-LNX-01', 'linux');
    const s = await newScript(a);
    const hostile = `C:\\Temp'; Remove-Item C:\\ -Recurse; $(whoami) \``;
    // Bad values are refused with every problem listed.
    const bad = await createJob(a, { script_id: s.id, parameters: { Days: 0, Mode: 'wipe' }, target: { kind: 'endpoints', endpoint_ids: [ep.epId] }, schedule: { kind: 'now' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_parameters');
    expect(bad.body.error.message).toMatch(/Path: a value is required.*Days must be at least 1.*Mode must be one of/);

    const job = await createJob(a, {
      script_id: s.id,
      parameters: { Path: hostile, Days: 30, WhatIf: false },
      target: { kind: 'endpoints', endpoint_ids: [ep.epId, linux.epId] },
      schedule: { kind: 'now' },
    });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    expect(job.body.state).toBe('finished');
    expect(job.body.last_run.counts).toMatchObject({ total: 2, queued: 1, skipped: 1 });

    const cmds = await pollFor(ep.cred);
    const run = cmds.find((c) => c.kind === 'script_run')!;
    expect(run.payload.language).toBe('powershell');
    // The script text is exactly what was saved: the value is not in it.
    expect(run.payload.body).toBe(PS_BODY);
    expect(String(run.payload.body)).not.toContain('Remove-Item C:');
    expect(run.payload.params).toEqual([
      { name: 'Path', type: 'string', value: hostile },
      { name: 'Days', type: 'int', value: '30' },
      { name: 'WhatIf', type: 'bool', value: 'false' },
      { name: 'Mode', type: 'choice', value: 'list' },
    ]);
    expect(run.payload).toMatchObject({ timeout_s: 120, max_output_bytes: 1 << 20, body_sha256: s.current.body_sha256 });
    // The Linux computer was skipped (the script is for Windows).
    expect(await pollFor(linux.cred)).toEqual([]);

    const big = 'line of output\n'.repeat(1000);
    await answer(ep.cred, run.id, true, { exit_code: 0, stdout: big, stderr: 'warning: 1 file locked', stdout_bytes: big.length, stderr_bytes: 22, duration_ms: 1234 });
    const detail = (await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body;
    const results = detail.runs[0].results as Array<Record<string, unknown>>;
    const win = results.find((r) => r.endpoint_id === ep.epId)!;
    expect(win).toMatchObject({ state: 'succeeded', exit_code: 0, duration_ms: 1234, stdout_bytes: big.length, truncated: true, stderr_preview: 'warning: 1 file locked' });
    expect(String(win.stdout_preview).length).toBe(8192);
    expect(results.find((r) => r.endpoint_id === linux.epId)).toMatchObject({ state: 'skipped', skip_reason: expect.stringMatching(/for windows; this computer runs linux/) });
    // The full copy is downloadable.
    const full = await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}/results/${win.id}/output?stream=stdout`);
    expect(full.status).toBe(200);
    expect(full.headers['content-disposition']).toContain('JOB-PC-01-stdout.txt');
    expect(full.text).toBe(big);
    // The command row does not keep the output; the audit has neither output nor parameter values.
    const cmdRow = await systemPool.query<{ result_data: Record<string, unknown> }>(`SELECT result_data FROM endpoint_commands WHERE id = $1`, [run.id]);
    expect(cmdRow.rows[0]!.result_data.stdout).toBeUndefined();
    const all = await systemPool.query<{ metadata: unknown }>(`SELECT metadata FROM audit_logs WHERE organization_id = $1`, [a.organizationId]);
    const auditText = JSON.stringify(all.rows);
    expect(auditText).not.toContain('line of output');
    expect(auditText).not.toContain('Remove-Item');
    expect((await audits(a.organizationId, 'fleet.job_created'))[0]!.metadata).toMatchObject({ parameters: ['Path', 'Days', 'WhatIf', 'Mode'], script_version: 1 });
    expect((await audits(a.organizationId, 'fleet.job_result')).map((x) => x.metadata.state)).toEqual(['succeeded']);
    expect((await audits(a.organizationId, 'fleet.job_dispatched'))).toHaveLength(1);
  });

  it('technicians run only scripts marked for them, and manage only their own jobs', async () => {
    const a = await newAccount('job-tech');
    const tech = await addMember(a, 'technician');
    const other = await addMember(a, 'technician');
    const ep = await onlineEndpoint(a, 'TECH-PC-01');
    const s = await newScript(a);
    const body = { script_id: s.id, parameters: { Path: 'C:\\Temp' }, target: { kind: 'endpoints', endpoint_ids: [ep.epId] }, schedule: { kind: 'once', run_at: new Date(Date.now() + 3600_000).toISOString() } };
    expect((await createJob(tech, body)).body.error.code).toBe('script_not_runnable_by_technicians');
    await a.agent.patch(`/api/v1/fleet/scripts/${s.id}`).set(CSRF).send({ technician_runnable: true });
    const job = await createJob(tech, body);
    expect(job.status).toBe(201);
    expect((await other.agent.post(`/api/v1/fleet/jobs/${job.body.id}/cancel`).set(CSRF)).body.error.code).toBe('job_not_yours');
    expect((await tech.agent.post(`/api/v1/fleet/jobs/${job.body.id}/cancel`).set(CSRF)).body.state).toBe('cancelled');
  });

  it('offline computers run when they come back; a run expires for one that does not', async () => {
    const a = await newAccount('job-offline');
    const back = await onlineEndpoint(a, 'OFF-PC-01');
    const gone = await onlineEndpoint(a, 'OFF-PC-02');
    await systemPool.query(`UPDATE endpoints SET last_heartbeat_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])`, [[back.epId, gone.epId]]);
    const s = await newScript(a);
    const job = await createJob(a, { script_id: s.id, parameters: { Path: 'C:\\' }, target: { kind: 'endpoints', endpoint_ids: [back.epId, gone.epId] }, schedule: { kind: 'now' }, expiry_minutes: 60 });
    const detail = async () => (await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body.runs[0].results as Array<{ endpoint_id: string; state: string; waiting_for: string | null }>;
    expect((await detail()).map((r) => [r.state, r.waiting_for])).toEqual([
      ['pending', 'online'],
      ['pending', 'online'],
    ]);
    expect(await pollFor(back.cred)).toEqual([]);
    // One comes back: the next scheduler pass hands it the script.
    await heartbeat(back.cred);
    await runDueJobs(a.organizationId);
    expect((await pollFor(back.cred)).map((c) => c.kind)).toEqual(['script_run']);
    // The other never does: the run expires.
    await systemPool.query(`UPDATE fleet_job_runs SET expires_at = now() - interval '1 second' WHERE job_id = $1`, [job.body.id]);
    await runDueJobs(a.organizationId);
    const after = await detail();
    expect(after.find((r) => r.endpoint_id === back.epId)!.state).toBe('queued');
    expect(after.find((r) => r.endpoint_id === gone.epId)).toMatchObject({ state: 'expired' });
  });

  it('rerun failed runs only the computers that failed; cancel withdraws or stops the rest', async () => {
    const a = await newAccount('job-rerun');
    const ok = await onlineEndpoint(a, 'RR-PC-01');
    const bad = await onlineEndpoint(a, 'RR-PC-02');
    const s = await newScript(a);
    const job = await createJob(a, { script_id: s.id, parameters: { Path: 'C:\\' }, target: { kind: 'endpoints', endpoint_ids: [ok.epId, bad.epId] }, schedule: { kind: 'now' } });
    const c1 = (await pollFor(ok.cred)).find((c) => c.kind === 'script_run')!;
    const c2 = (await pollFor(bad.cred)).find((c) => c.kind === 'script_run')!;
    await answer(ok.cred, c1.id, true, { exit_code: 0, stdout: 'fine', stderr: '', duration_ms: 10 });
    await answer(bad.cred, c2.id, true, { exit_code: 3, stdout: '', stderr: 'access denied', duration_ms: 12 });
    let d = (await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body;
    expect(d.runs[0].counts).toMatchObject({ succeeded: 1, failed: 1 });
    expect(d.runs[0].results.find((r: { endpoint_id: string }) => r.endpoint_id === bad.epId)).toMatchObject({ state: 'failed', exit_code: 3, error: 'Exit code 3' });

    const rerun = await a.agent.post(`/api/v1/fleet/jobs/${job.body.id}/rerun`).set(CSRF).send({});
    expect(rerun.status).toBe(201);
    expect(rerun.body.computers).toBe(1);
    expect(await pollFor(ok.cred)).toEqual([]);
    const again = (await pollFor(bad.cred)).find((c) => c.kind === 'script_run')!;
    d = (await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body;
    expect(d.runs).toHaveLength(2);
    expect(d.runs[0]).toMatchObject({ kind: 'rerun', rerun_of: d.runs[1].id });

    // Cancel: the delivered command gets script_cancel; the agent answers "cancelled".
    const cancelled = await a.agent.post(`/api/v1/fleet/jobs/${job.body.id}/cancel`).set(CSRF);
    expect(cancelled.body.state).toBe('cancelled');
    const stop = (await pollFor(bad.cred)).find((c) => c.kind === 'script_cancel')!;
    expect(stop.payload.result_id).toBeDefined();
    await answer(bad.cred, again.id, false, { cancelled: true, exit_code: -1, stdout: '', stderr: '' }, 'Cancelled by the operator');
    d = (await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body;
    expect(d.runs[0].results[0].state).toBe('cancelled');
    expect((await a.agent.post(`/api/v1/fleet/jobs/${job.body.id}/rerun`).set(CSRF).send({})).body.error.code).toBe('job_cancelled');
    expect((await audits(a.organizationId, 'fleet.job_cancelled'))[0]!.metadata).toMatchObject({ stopping_running: 1 });

    // A queued command the agent has not picked up is withdrawn.
    const j2 = await createJob(a, { script_id: s.id, parameters: { Path: 'C:\\' }, target: { kind: 'endpoints', endpoint_ids: [ok.epId] }, schedule: { kind: 'now' } });
    await a.agent.post(`/api/v1/fleet/jobs/${j2.body.id}/cancel`).set(CSRF);
    expect(await pollFor(ok.cred)).toEqual([]);
    expect((await a.agent.get(`/api/v1/fleet/jobs/${j2.body.id}`)).body.runs[0].results[0]).toMatchObject({ state: 'cancelled' });
    // Nothing failed: nothing to rerun.
    const j3 = await createJob(a, { script_id: s.id, parameters: { Path: 'C:\\' }, target: { kind: 'endpoints', endpoint_ids: [ok.epId] }, schedule: { kind: 'now' } });
    const c3 = (await pollFor(ok.cred)).find((c) => c.kind === 'script_run')!;
    await answer(ok.cred, c3.id, true, { exit_code: 0, stdout: '', stderr: '' });
    expect((await a.agent.post(`/api/v1/fleet/jobs/${j3.body.id}/rerun`).set(CSRF).send({})).body.error.code).toBe('nothing_to_rerun');
  });

  it('scheduled once and recurring jobs run when due; group targets and maintenance windows', async () => {
    const a = await newAccount('job-sched');
    const ep = await onlineEndpoint(a, 'SCH-PC-01');
    const group = (await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Servers' })).body.group;
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [ep.epId], fleet_group_id: group.id });
    const s = await newScript(a);

    const once = await createJob(a, { script_id: s.id, parameters: { Path: 'C:\\' }, target: { kind: 'group', fleet_group_id: group.id }, schedule: { kind: 'once', run_at: new Date(Date.now() + 600_000).toISOString() } });
    expect(once.body).toMatchObject({ state: 'active', last_run: null, timezone: 'UTC' });
    await runDueJobs(a.organizationId);
    expect(await pollFor(ep.cred)).toEqual([]);
    await systemPool.query(`UPDATE fleet_jobs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [once.body.id]);
    await runDueJobs(a.organizationId);
    expect((await pollFor(ep.cred)).map((c) => c.kind)).toEqual(['script_run']);
    expect((await a.agent.get(`/api/v1/fleet/jobs/${once.body.id}`)).body).toMatchObject({ state: 'finished', next_run_at: null });

    const daily = await createJob(a, {
      script_id: s.id,
      parameters: { Path: 'C:\\' },
      target: { kind: 'endpoints', endpoint_ids: [ep.epId] },
      schedule: { kind: 'recurring', every: 'daily', time: '03:00' },
      timezone: 'Africa/Cairo',
      maintenance_only: true,
    });
    expect(daily.status, JSON.stringify(daily.body)).toBe(201);
    const first = new Date(daily.body.next_run_at);
    expect(first.getTime()).toBeGreaterThan(Date.now());
    expect(first.toISOString().slice(11, 16)).toBe('01:00'); // 03:00 Cairo (UTC+2)
    await systemPool.query(`UPDATE fleet_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [daily.body.id]);
    await runDueJobs(a.organizationId);
    const d = (await a.agent.get(`/api/v1/fleet/jobs/${daily.body.id}`)).body;
    expect(d.state).toBe('active');
    expect(new Date(d.next_run_at).getTime()).toBeGreaterThan(Date.now());
    // Only inside a maintenance window: it waits.
    expect(d.runs[0].results[0]).toMatchObject({ state: 'pending', waiting_for: 'maintenance_window' });
    expect(await pollFor(ep.cred)).toEqual([]);
    // A window for the site, open now.
    await systemPool.query(
      `INSERT INTO maintenance_windows (organization_id, site_id, reason, timezone, starts_local, ends_local)
       VALUES ($1, $2, 'patch night', 'UTC', (now() AT TIME ZONE 'UTC') - interval '1 hour', (now() AT TIME ZONE 'UTC') + interval '1 hour')`,
      [a.organizationId, a.siteId],
    );
    await runDueJobs(a.organizationId);
    expect((await pollFor(ep.cred)).map((c) => c.kind)).toEqual(['script_run']);

    // Pause and resume a recurring job (audited).
    expect((await a.agent.post(`/api/v1/fleet/jobs/${daily.body.id}/pause`).set(CSRF).send({ paused: true })).body.state).toBe('paused');
    expect((await a.agent.post(`/api/v1/fleet/jobs/${daily.body.id}/pause`).set(CSRF).send({ paused: false })).body.state).toBe('active');
    expect(await audits(a.organizationId, 'fleet.job_paused')).toHaveLength(1);
    // Run now on a scheduled job (audited).
    const now = await a.agent.post(`/api/v1/fleet/jobs/${daily.body.id}/run-now`).set(CSRF);
    expect(now.status).toBe(201);
    expect(await audits(a.organizationId, 'fleet.job_run_now')).toHaveLength(1);
    // A once-job in the past is refused.
    expect((await createJob(a, { script_id: s.id, parameters: { Path: 'C:\\' }, target: { kind: 'endpoints', endpoint_ids: [ep.epId] }, schedule: { kind: 'once', run_at: '2020-01-01T00:00:00Z' } })).body.error.code).toBe(
      'run_at_in_past',
    );
  });

  it('a queued script whose agent never answers fails after its timeout', async () => {
    const a = await newAccount('job-noanswer');
    const ep = await onlineEndpoint(a, 'NA-PC-01');
    const s = await newScript(a);
    const job = await createJob(a, { script_id: s.id, parameters: { Path: 'C:\\' }, target: { kind: 'endpoints', endpoint_ids: [ep.epId] }, schedule: { kind: 'now' } });
    await pollFor(ep.cred);
    await systemPool.query(`UPDATE fleet_job_results SET queued_at = now() - interval '1 hour' WHERE job_id = $1`, [job.body.id]);
    await runDueJobs(a.organizationId);
    expect((await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body.runs[0].results[0]).toMatchObject({ state: 'failed', error: 'No result from the agent within the script timeout' });
  });

  it('keeps organizations apart', async () => {
    const a = await newAccount('job-iso-a');
    const b = await newAccount('job-iso-b');
    const s = await newScript(a);
    const epB = await onlineEndpoint(b, 'ISO-B');
    expect((await b.agent.get(`/api/v1/fleet/scripts/${s.id}`)).status).toBe(404);
    expect((await createJob(b, { script_id: s.id, parameters: { Path: 'x' }, target: { kind: 'endpoints', endpoint_ids: [epB.epId] }, schedule: { kind: 'now' } })).status).toBe(404);
    const ep = await onlineEndpoint(a, 'ISO-A');
    expect((await createJob(a, { script_id: s.id, parameters: { Path: 'x' }, target: { kind: 'endpoints', endpoint_ids: [epB.epId, ep.epId] }, schedule: { kind: 'now' } })).status).toBe(404);
  });

  it('viewers write nothing; technicians cannot edit scripts or change a job another technician created', async () => {
    const a = await newAccount('job-roles');
    const tech = await addMember(a, 'technician');
    const other = await addMember(a, 'technician');
    const viewer = await addMember(a, 'viewer');
    const ep = await onlineEndpoint(a, 'ROLE-PC-01');
    const s = await newScript(a, { technician_runnable: true });
    const body = { script_id: s.id, parameters: { Path: 'C:\\Temp' }, target: { kind: 'endpoints', endpoint_ids: [ep.epId] }, schedule: { kind: 'recurring', every: 'daily', time: '02:00' } };
    expect((await createJob(viewer, body)).status).toBe(403);
    expect((await tech.agent.patch(`/api/v1/fleet/scripts/${s.id}`).set(CSRF).send({ body: 'Remove-Item C:\\ -Recurse' })).status).toBe(403);
    expect((await tech.agent.post(`/api/v1/fleet/scripts/${s.id}/archive`).set(CSRF)).status).toBe(403);
    const job = await createJob(tech, body);
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const id = job.body.id as string;
    expect((await viewer.agent.get(`/api/v1/fleet/jobs/${id}`)).status).toBe(403);
    expect((await viewer.agent.post(`/api/v1/fleet/jobs/${id}/cancel`).set(CSRF)).status).toBe(403);
    for (const path of ['run-now', 'rerun', 'cancel']) {
      expect((await other.agent.post(`/api/v1/fleet/jobs/${id}/${path}`).set(CSRF).send({})).body.error.code, path).toBe('job_not_yours');
    }
    expect((await other.agent.post(`/api/v1/fleet/jobs/${id}/pause`).set(CSRF).send({ paused: true })).body.error.code).toBe('job_not_yours');
    // Once an admin takes the script away from technicians, its creator can no longer change the job; admins still can.
    await a.agent.patch(`/api/v1/fleet/scripts/${s.id}`).set(CSRF).send({ technician_runnable: false });
    expect((await tech.agent.post(`/api/v1/fleet/jobs/${id}/run-now`).set(CSRF)).body.error.code).toBe('job_not_yours');
    expect((await a.agent.post(`/api/v1/fleet/jobs/${id}/pause`).set(CSRF).send({ paused: true })).body.state).toBe('paused');
    // Refusals change nothing: no run, no cancel.
    expect(await audits(a.organizationId, 'fleet.job_run_now')).toEqual([]);
    expect(await audits(a.organizationId, 'fleet.job_cancelled')).toEqual([]);
    expect(await pollFor(ep.cred)).toEqual([]);
  });

  it('a recurring job missed while the server was down runs once, then waits for its next time; rerun takes the expired computers', async () => {
    const a = await newAccount('job-catchup');
    const on = await onlineEndpoint(a, 'CU-PC-01');
    const off = await onlineEndpoint(a, 'CU-PC-02');
    await systemPool.query(`UPDATE endpoints SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [off.epId]);
    const s = await newScript(a);
    const job = await createJob(a, {
      script_id: s.id,
      parameters: { Path: 'C:\\' },
      target: { kind: 'endpoints', endpoint_ids: [on.epId, off.epId] },
      schedule: { kind: 'recurring', every: 'hourly', time: '00:05' },
      expiry_minutes: 30,
    });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const id = job.body.id as string;
    // Three days of hourly occurrences were missed.
    await systemPool.query(`UPDATE fleet_jobs SET next_run_at = now() - interval '3 days' WHERE id = $1`, [id]);
    await runDueJobs(a.organizationId);
    await runDueJobs(a.organizationId);
    let d = (await a.agent.get(`/api/v1/fleet/jobs/${id}`)).body;
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0].kind).toBe('scheduled');
    const next = new Date(d.next_run_at).getTime();
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.now() + 3600_000);
    expect(new Date(d.next_run_at).getUTCMinutes()).toBe(5);
    expect((await pollFor(on.cred)).filter((c) => c.kind === 'script_run')).toHaveLength(1);
    expect(await pollFor(off.cred)).toEqual([]);

    // The offline one never returned within the expiry: expired, and "Rerun failed" takes it.
    await systemPool.query(`UPDATE fleet_job_runs SET expires_at = now() - interval '1 second' WHERE job_id = $1`, [id]);
    await runDueJobs(a.organizationId);
    d = (await a.agent.get(`/api/v1/fleet/jobs/${id}`)).body;
    expect(d.runs[0].results.find((r: { endpoint_id: string }) => r.endpoint_id === off.epId).state).toBe('expired');
    await heartbeat(off.cred);
    const rerun = await a.agent.post(`/api/v1/fleet/jobs/${id}/rerun`).set(CSRF).send({ run_id: d.runs[0].id });
    expect(rerun.status, JSON.stringify(rerun.body)).toBe(201);
    expect(rerun.body.computers).toBe(1);
    expect((await pollFor(off.cred)).map((c) => c.kind)).toEqual(['script_run']);
    expect(await pollFor(on.cred)).toEqual([]);
    expect((await audits(a.organizationId, 'fleet.job_rerun'))[0]!.metadata).toMatchObject({ rerun_of: d.runs[0].id, computers: 1 });
  });
});
