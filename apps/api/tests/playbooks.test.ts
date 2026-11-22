import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { playbookTick } from '../src/modules/playbooks/index.ts';
import { dueScheduleSlot } from '../src/modules/playbooks/schedule.ts';
import { type TestAccount, addScope, app, CSRF, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

// Playbooks end to end: HTTP → engine → the owning modules' services → SQL. The scheduler job is
// driven by calling playbookTick() (what the job runs every 5 s); it reads every bit of state from
// the database, which is also what makes runs resume after an API restart.

async function withDevice(label: string) {
  const a = await newAccount(label);
  const scopeId = await addScope(a, '192.168.60.0/24');
  const c = await newCollector(a);
  await heartbeat(c);
  expect((await telemetry(c, [sweep(scopeId, [{ ip: '192.168.60.20', mac: 'aa:bb:cc:00:00:20', hostname: 'printer-1' }])])).status).toBe(200);
  const list = await a.agent.get('/api/v1/devices?page_size=50');
  const device = list.body.items.find((d: { current_ip: string }) => d.current_ip === '192.168.60.20');
  return { a, c, scopeId, deviceId: device.id as string };
}

async function addMember(owner: TestAccount, role: 'viewer' | 'technician' | 'admin') {
  const email = `pb-${role}-${randomUUID().slice(0, 8)}@example.test`;
  const inv = await owner.agent.post('/api/v1/team/invitations').set(CSRF).send({ email, role });
  expect(inv.status).toBe(201);
  const agent = request.agent(app);
  const acc = await agent.post(`/api/v1/auth/invitations/${inv.body.token}/accept`).set(CSRF).send({ display_name: `${role} member`, password: 'correct horse battery' });
  expect(acc.status).toBe(200);
  return { agent, email };
}

const manual = { kind: 'manual' };

async function createPlaybook(a: TestAccount, body: Record<string, unknown>) {
  const res = await a.agent.post('/api/v1/playbooks').set(CSRF).send({ name: 'Test playbook', trigger: manual, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
}

type RunStep = { id: string; status: string; approval_requested_at: string; approval_expires_at: string };
const awaitingStep = (run: { steps: RunStep[] }) => run.steps.find((s) => s.status === 'awaiting_approval')!;

describe('playbooks: definitions, templates and permissions', () => {
  it('serves the catalogue and templates, validates steps against the trigger, and restricts writes to administrators', async () => {
    const a = await newAccount('pb-crud');
    const cat = await a.agent.get('/api/v1/playbooks/catalog');
    expect(cat.status).toBe(200);
    expect(cat.body.templates.map((t: { key: string }) => t.key)).toContain('critical_server_offline');
    expect(cat.body.actions.find((x: { key: string }) => x.key === 'router_block')).toMatchObject({ needs_device: true, always_approve: true, default_risk: 'disruptive' });

    // One click from a template: an ordinary, disabled playbook.
    const fromTemplate = await a.agent.post('/api/v1/playbooks/from-template').set(CSRF).send({ template: 'critical_server_offline', site_id: a.siteId });
    expect(fromTemplate.status).toBe(201);
    expect(fromTemplate.body).toMatchObject({ enabled: false, template_key: 'critical_server_offline', approval_mode: 'always_ask', site_id: a.siteId });
    expect(fromTemplate.body.steps.map((s: { key: string }) => s.key)).toEqual(['ping1', 'wake', 'wait', 'ping2', 'still_down', 'notify']);

    // A scheduled playbook has no trigger device: a device step must name one.
    const noDevice = await a.agent
      .post('/api/v1/playbooks')
      .set(CSRF)
      .send({ name: 'x', trigger: { kind: 'schedule', every_minutes: 30 }, steps: [{ action: 'wake_device', params: {} }] });
    expect(noDevice.status).toBe(400);
    expect(noDevice.body.error.details[0].path).toBe('steps.0.params.device_id');

    // Unknown actions and arbitrary commands cannot be stored.
    const unknown = await a.agent.post('/api/v1/playbooks').set(CSRF).send({ name: 'x', trigger: manual, steps: [{ action: 'shell', params: { cmd: 'rm -rf /' } }] });
    expect(unknown.status).toBe(400);
    const badCommand = await a.agent
      .post('/api/v1/playbooks')
      .set(CSRF)
      .send({ name: 'x', trigger: manual, steps: [{ action: 'endpoint_command', params: { command: { kind: 'fs_op', op: 'delete', path: 'C:/' } } }] });
    expect(badCommand.status).toBe(400);

    // Running disruptive steps without asking needs explicit consent, which is recorded.
    const autoNoConsent = await a.agent
      .post('/api/v1/playbooks')
      .set(CSRF)
      .send({ name: 'auto', trigger: manual, approval_mode: 'run_automatically', steps: [{ action: 'set_trust', params: { trust: 'unwanted' } }] });
    expect(autoNoConsent.status).toBe(400);
    expect(autoNoConsent.body.error.code).toBe('auto_run_not_confirmed');
    const auto = await a.agent
      .post('/api/v1/playbooks')
      .set(CSRF)
      .send({ name: 'auto', trigger: manual, approval_mode: 'run_automatically', auto_run_confirmed: true, steps: [{ action: 'set_trust', params: { trust: 'unwanted' } }] });
    expect(auto.status).toBe(201);
    expect(auto.body.auto_run_set_by_email).toBe(a.email);
    // Changing its steps needs the consent again.
    const reconsent = await a.agent.patch(`/api/v1/playbooks/${auto.body.id}`).set(CSRF).send({ steps: [{ action: 'set_trust', params: { trust: 'known' } }] });
    expect(reconsent.status).toBe(400);

    // Enabling records the moment (triggers never match what happened before it).
    const enabled = await a.agent.patch(`/api/v1/playbooks/${fromTemplate.body.id}`).set(CSRF).send({ enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled_at).not.toBeNull();

    const audits = await systemPool.query<{ action: string }>(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'playbook.%' ORDER BY created_at`, [a.organizationId]);
    expect(audits.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['playbook.created', 'playbook.enabled']));

    // Viewers read; only administrators write.
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get('/api/v1/playbooks')).body.items).toHaveLength(2);
    expect((await a.agent.post('/api/v1/playbooks/from-template').set(CSRF).send({ template: 'nightly_discovery' })).status).toBe(403);
    expect((await a.agent.patch(`/api/v1/playbooks/${fromTemplate.body.id}`).set(CSRF).send({ enabled: false })).status).toBe(403);
    expect((await a.agent.post(`/api/v1/playbooks/${fromTemplate.body.id}/run`).set(CSRF).send({})).status).toBe(403);

    // Tenant isolation.
    const b = await newAccount('pb-crud-b');
    expect((await b.agent.get(`/api/v1/playbooks/${fromTemplate.body.id}`)).status).toBe(404);
    expect((await b.agent.get('/api/v1/playbooks')).body.items).toHaveLength(0);
  });
});

describe('playbooks: runs with approval gates', () => {
  it('pauses at each gate; the only administrator may approve their own run, and that is recorded', async () => {
    const { a, deviceId } = await withDevice('pb-solo');
    const p = await createPlaybook(a, {
      steps: [
        { key: 'tell', action: 'notify', params: { title: 'Starting on {device} ({ip})', severity: 'info', attach: 'none' } },
        { key: 'gate', action: 'approval', params: { message: 'Mark the printer as unwanted?' } },
        { key: 'mark', action: 'set_trust', params: { trust: 'unwanted' } },
      ],
    });
    const started = await a.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId });
    expect(started.status).toBe(201);
    expect(started.body.status).toBe('awaiting_approval');
    expect(started.body.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'awaiting_approval', 'pending']);
    const notifyEvent = await systemPool.query(`SELECT title FROM network_events WHERE organization_id = $1 AND type = 'playbook_notification'`, [a.organizationId]);
    expect(notifyEvent.rows[0].title).toBe('Starting on printer-1 (192.168.60.20)');
    // The request is on the timeline (notification channels receive it like any warning).
    const ask = await systemPool.query(`SELECT severity FROM network_events WHERE organization_id = $1 AND type = 'playbook_approval_requested'`, [a.organizationId]);
    expect(ask.rows).toHaveLength(1);

    const approvals = await a.agent.get('/api/v1/playbook-approvals');
    expect(approvals.body.items).toHaveLength(1);
    expect(approvals.body.items[0].rights).toMatchObject({ can_approve: true, self_approval: 'only_administrator' });

    const gate = awaitingStep(started.body);
    const approved = await a.agent.post(`/api/v1/playbook-runs/${started.body.id}/steps/${gate.id}/decision`).set(CSRF).send({ decision: 'approve' });
    expect(approved.status).toBe(200);
    // set_trust → unwanted is disruptive: a second gate.
    expect(approved.body.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'succeeded', 'awaiting_approval']);
    expect(approved.body.steps[2].input).toMatchObject({ device_id: deviceId, trust: 'unwanted', current_trust: 'unreviewed' });

    const second = await a.agent.post(`/api/v1/playbook-runs/${started.body.id}/steps/${approved.body.steps[2].id}/decision`).set(CSRF).send({ decision: 'approve', comment: 'confirmed' });
    expect(second.body.status).toBe('succeeded');
    expect(second.body.steps[2]).toMatchObject({ status: 'succeeded', actor: 'user', actor_email: a.email, decided_by_email: a.email, output: { previous: 'unreviewed', trust: 'unwanted', changed: true, self_approved: true } });
    const trust = await systemPool.query(`SELECT trust FROM devices WHERE id = $1`, [deviceId]);
    expect(trust.rows[0].trust).toBe('unwanted');

    const audits = await systemPool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs WHERE organization_id = $1 AND action IN ('playbook.step.approved', 'playbook.step.set_trust', 'playbook.run_started') ORDER BY created_at`,
      [a.organizationId],
    );
    expect(audits.rows.map((r) => r.action)).toEqual(['playbook.run_started', 'playbook.step.approved', 'playbook.step.approved', 'playbook.step.set_trust']);
    expect(audits.rows[1]!.metadata).toMatchObject({ self_approved: true, self_approval_reason: 'only_administrator' });
    expect(audits.rows[3]!.metadata).toMatchObject({ automation: 'playbooks', approved_by: a.email });

    // A decided step cannot be decided again.
    expect((await a.agent.post(`/api/v1/playbook-runs/${started.body.id}/steps/${gate.id}/decision`).set(CSRF).send({ decision: 'approve' })).status).toBe(409);
  });

  it('with two administrators the requester cannot approve; a rejection needs a reason and ends the run', async () => {
    const { a, deviceId } = await withDevice('pb-two');
    const other = await addMember(a, 'admin');
    const tech = await addMember(a, 'technician');
    const p = await createPlaybook(a, { steps: [{ key: 'pause', action: 'dns_pause', params: { minutes: 60 } }, { key: 'after', action: 'notify', params: { title: 'done' } }] });

    // A technician may start a run; its disruptive step still waits for an administrator.
    const run = await tech.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId });
    expect(run.status).toBe(201);
    expect(run.body.status).toBe('awaiting_approval');
    const step = awaitingStep(run.body);
    expect(step.status).toBe('awaiting_approval');
    expect((await tech.agent.post(`/api/v1/playbook-runs/${run.body.id}/steps/${step.id}/decision`).set(CSRF).send({ decision: 'approve' })).status).toBe(403);

    // The person who started a run cannot approve it when another administrator exists.
    const own = await a.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId });
    const ownStep = awaitingStep(own.body);
    const selfApprove = await a.agent.post(`/api/v1/playbook-runs/${own.body.id}/steps/${ownStep.id}/decision`).set(CSRF).send({ decision: 'approve' });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('self_approval');

    // Rejecting needs a reason.
    const noReason = await other.agent.post(`/api/v1/playbook-runs/${own.body.id}/steps/${ownStep.id}/decision`).set(CSRF).send({ decision: 'reject' });
    expect(noReason.status).toBe(400);
    const rejected = await other.agent
      .post(`/api/v1/playbook-runs/${own.body.id}/steps/${ownStep.id}/decision`)
      .set(CSRF)
      .send({ decision: 'reject', comment: 'That is the CEO laptop' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.status_reason).toContain('That is the CEO laptop');
    expect(rejected.body.steps.map((s: { status: string }) => s.status)).toEqual(['rejected', 'skipped']);
    expect((await systemPool.query(`SELECT internet_paused_until FROM devices WHERE id = $1`, [deviceId])).rows[0].internet_paused_until).toBeNull();

    // Another administrator approves the technician's run: the pause is applied, and its effect is stated honestly.
    const ok = await other.agent.post(`/api/v1/playbook-runs/${run.body.id}/steps/${step.id}/decision`).set(CSRF).send({ decision: 'approve' });
    expect(ok.body.status).toBe('succeeded');
    expect(ok.body.steps[0].output).toMatchObject({ dns_filter_enabled: false });
    expect(ok.body.steps[0].output.note).toContain('DNS filter is off');
    expect((await systemPool.query(`SELECT internet_paused_until FROM devices WHERE id = $1`, [deviceId])).rows[0].internet_paused_until).not.toBeNull();

    // Two-person rule: the author may not approve a triggered run of their own playbook either.
    expect((await a.agent.put('/api/v1/playbooks/settings').set(CSRF).send({ two_person_rule: true, approval_ttl_minutes: 30 })).status).toBe(200);
    const third = await other.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId });
    const thirdStep = awaitingStep(third.body);
    expect(new Date(thirdStep.approval_expires_at).getTime() - new Date(thirdStep.approval_requested_at).getTime()).toBe(30 * 60_000);
    const authorTry = await a.agent.post(`/api/v1/playbook-runs/${third.body.id}/steps/${thirdStep.id}/decision`).set(CSRF).send({ decision: 'approve' });
    expect(authorTry.status).toBe(403);
    expect(authorTry.body.error.message).toContain('Two-person rule');

    // Cancel: not by a technician who did not start it; by an administrator, yes.
    expect((await tech.agent.post(`/api/v1/playbook-runs/${third.body.id}/cancel`).set(CSRF).send({})).status).toBe(403);
    const cancelled = await a.agent.post(`/api/v1/playbook-runs/${third.body.id}/cancel`).set(CSRF).send({ reason: 'not needed' });
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.steps.map((s: { status: string }) => s.status)).toEqual(['cancelled', 'cancelled']);
    expect((await a.agent.post(`/api/v1/playbook-runs/${third.body.id}/cancel`).set(CSRF).send({})).status).toBe(409);

    // Another organization sees none of it.
    const b = await newAccount('pb-two-b');
    expect((await b.agent.get(`/api/v1/playbook-runs/${run.body.id}`)).status).toBe(404);
  });

  it('an approval nobody answers expires and the step is not carried out', async () => {
    const { a, deviceId } = await withDevice('pb-expire');
    const p = await createPlaybook(a, { steps: [{ action: 'set_trust', params: { trust: 'unwanted' } }] });
    const run = await a.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId });
    await systemPool.query(`UPDATE playbook_run_steps SET approval_expires_at = now() - interval '1 second' WHERE run_id = $1`, [run.body.id]);
    await systemPool.query(`UPDATE playbook_runs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [run.body.id]);
    await playbookTick();
    const after = await a.agent.get(`/api/v1/playbook-runs/${run.body.id}`);
    expect(after.body.status).toBe('expired');
    expect(after.body.steps[0].status).toBe('expired');
    expect((await systemPool.query(`SELECT trust FROM devices WHERE id = $1`, [deviceId])).rows[0].trust).toBe('unreviewed');
  });
});

describe('playbooks: engine', () => {
  it('waits for the collector, decides conditions on the probe result, and resumes from the database', async () => {
    const { a, c, deviceId } = await withDevice('pb-engine');
    const p = await createPlaybook(a, {
      steps: [
        { key: 'ping', action: 'run_tool', params: { tool: 'ping', target: 'trigger_device' } },
        { key: 'still_down', action: 'condition', params: { test: 'last_probe_failed', if_true: 'continue' } },
        { key: 'alert', action: 'notify', params: { title: 'Still down: {device}', severity: 'critical', attach: 'previous_output' } },
      ],
    });

    async function runWith(replied: boolean) {
      const run = await a.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId });
      expect(run.body.status).toBe('waiting');
      expect(run.body.steps[0]).toMatchObject({ status: 'running', input: { tool: 'ping', target: '192.168.60.20' } });
      const hb = await heartbeat(c);
      const cmd = (hb.body.commands as { id: string; kind: string; payload: { run_id: string; target: string } }[]).find((x) => x.kind === 'run_tool' && x.payload.target === '192.168.60.20');
      expect(cmd).toBeDefined();
      const uploaded = await telemetry(c, [{ type: 'tool_result', ts: new Date().toISOString(), run_id: cmd!.payload.run_id, ok: true, duration_ms: 4000, output: { resolved: '192.168.60.20', replied, requests: 5 } }]);
      expect(uploaded.body.accepted).toBe(1);
      await heartbeat(c, { completed_commands: [cmd!.id] });
      await systemPool.query(`UPDATE playbook_runs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [run.body.id]);
      await playbookTick();
      return (await a.agent.get(`/api/v1/playbook-runs/${run.body.id}`)).body;
    }

    const down = await runWith(false);
    expect(down.status).toBe('succeeded');
    expect(down.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(down.steps[1].output).toMatchObject({ result: true, then: 'continue' });

    const up = await runWith(true);
    expect(up.status).toBe('stopped');
    expect(up.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'succeeded', 'skipped']);

    // A step left running without a record to wait for (the process stopped mid-action) is failed, never retried.
    const run = await a.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId });
    await systemPool.query(`UPDATE playbook_run_steps SET external = NULL, started_at = now() - interval '10 minutes' WHERE run_id = $1 AND position = 0`, [run.body.id]);
    await systemPool.query(`UPDATE playbook_runs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [run.body.id]);
    await playbookTick();
    const interrupted = (await a.agent.get(`/api/v1/playbook-runs/${run.body.id}`)).body;
    expect(interrupted.status).toBe('failed');
    expect(interrupted.steps[0].error).toContain('Interrupted');
  });

  it('dry runs preview every step and change nothing', async () => {
    const { a, deviceId } = await withDevice('pb-dry');
    const p = await createPlaybook(a, {
      steps: [
        { action: 'set_trust', params: { trust: 'unwanted' } },
        { action: 'router_block', params: {} },
        { action: 'wait', params: { seconds: 60 } },
      ],
    });
    const run = await a.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId, dry_run: true });
    expect(run.body).toMatchObject({ status: 'succeeded', dry_run: true });
    expect(run.body.steps.map((s: { status: string }) => s.status)).toEqual(['previewed', 'previewed', 'previewed']);
    expect(run.body.steps[0].input).toMatchObject({ trust: 'unwanted', device: 'printer-1' });
    expect((await systemPool.query(`SELECT trust FROM devices WHERE id = $1`, [deviceId])).rows[0].trust).toBe('unreviewed');
    // A run needing a device cannot start without one.
    const noDevice = await a.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({});
    expect(noDevice.status).toBe(400);
    expect(noDevice.body.error.code).toBe('device_required');
  });

  it('router steps always ask, and fail honestly when the site has no router', async () => {
    const { a, deviceId } = await withDevice('pb-router');
    const p = await createPlaybook(a, { approval_mode: 'run_automatically', auto_run_confirmed: true, steps: [{ action: 'router_block', params: {} }] });
    const run = await a.agent.post(`/api/v1/playbooks/${p.id}/run`).set(CSRF).send({ device_id: deviceId });
    expect(run.body.status).toBe('awaiting_approval'); // even in "run automatically" mode
    const step = awaitingStep(run.body);
    const decided = await a.agent.post(`/api/v1/playbook-runs/${run.body.id}/steps/${step.id}/decision`).set(CSRF).send({ decision: 'approve' });
    expect(decided.body.status).toBe('failed');
    expect(decided.body.steps[0].error).toContain('No router');
  });

  it('starts once per matching event (idempotent), respects filters, and runs on schedule slots', async () => {
    const { a, c, scopeId } = await withDevice('pb-trigger');
    const p = await createPlaybook(a, {
      trigger: { kind: 'event', event_types: ['device_discovered'], filters: { device_trust: ['unreviewed'] } },
      enabled: true,
      steps: [{ action: 'notify', params: { title: 'New device {device}', severity: 'warning' } }],
    });
    // The device discovered before the playbook was enabled does not start it.
    await playbookTick();
    expect((await a.agent.get(`/api/v1/playbook-runs?playbook_id=${p.id}`)).body.total).toBe(0);

    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.60.20', mac: 'aa:bb:cc:00:00:20', hostname: 'printer-1' }, { ip: '192.168.60.21', mac: 'aa:bb:cc:00:00:21', hostname: 'laptop-9' }])]);
    await playbookTick();
    await playbookTick();
    const runs = (await a.agent.get(`/api/v1/playbook-runs?playbook_id=${p.id}`)).body;
    expect(runs.total).toBe(1);
    expect(runs.items[0]).toMatchObject({ trigger_kind: 'event', status: 'succeeded' });
    expect(runs.items[0].evidence.type).toBe('device_discovered');

    // Schedule: one run per slot.
    const s = await createPlaybook(a, { name: 'every 5', trigger: { kind: 'schedule', every_minutes: 5 }, enabled: true, steps: [{ action: 'notify', params: { title: 'tick' } }] });
    const later = new Date(Date.now() + 5 * 60_000);
    expect(dueScheduleSlot({ kind: 'schedule', every_minutes: 5 }, 'UTC', later, new Date(), 30)).not.toBeNull();
    await playbookTick(later);
    await playbookTick(later);
    const scheduled = (await a.agent.get(`/api/v1/playbook-runs?playbook_id=${s.id}`)).body;
    expect(scheduled.total).toBe(1);
    expect(scheduled.items[0].trigger_kind).toBe('schedule');

    // Incident trigger: comment on the incident that started the run, then acknowledge it.
    const inc = await createPlaybook(a, {
      name: 'on incident',
      trigger: { kind: 'incident', on: 'opened', incident_kinds: ['service'] },
      enabled: true,
      steps: [
        { action: 'incident_comment', params: { body: 'Playbook saw "{title}"', include_previous_output: false } },
        { action: 'incident_acknowledge', params: {} },
      ],
    });
    const incident = await systemPool.query<{ id: string }>(
      `INSERT INTO incidents (organization_id, site_id, number, kind, correlation_key, severity, title, opened_at)
       VALUES ($1,$2,9001,'service','test:pb-incident','warning','HTTP check down', now()) RETURNING id`,
      [a.organizationId, a.siteId],
    );
    await playbookTick();
    const incRuns = (await a.agent.get(`/api/v1/playbook-runs?playbook_id=${inc.id}`)).body;
    expect(incRuns.items[0]).toMatchObject({ trigger_kind: 'incident', status: 'succeeded', incident_id: incident.rows[0]!.id });
    const activity = await systemPool.query<{ kind: string; body: string }>(`SELECT kind, body FROM incident_activity WHERE incident_id = $1 ORDER BY created_at`, [incident.rows[0]!.id]);
    expect(activity.rows.map((r) => r.kind)).toEqual(['comment', 'acknowledged']);
    expect(activity.rows[0]!.body).toBe('Playbook "on incident": Playbook saw "HTTP check down"');
    expect((await systemPool.query(`SELECT status FROM incidents WHERE id = $1`, [incident.rows[0]!.id])).rows[0].status).toBe('acknowledged');
  });
});

describe('playbooks: device control, configuration backup and the loop guard', () => {
  const gz = (text: string) => gzipSync(Buffer.from(text, 'utf8')).toString('base64');
  const KEY = `SHA256:${'Q'.repeat(43)}`;
  const backupResult = (cmd: { payload: Record<string, unknown> }, text: string) => ({
    type: 'config_backup_result', ts: new Date().toISOString(), run_id: cmd.payload.run_id, target_id: cmd.payload.target_id, ok: true,
    host_key: { sha256: KEY, type: 'ssh-ed25519' }, host_key_status: 'matched', config_gzip_b64: gz(text),
  });
  const backupCommands = async (c: Parameters<typeof heartbeat>[0]) =>
    ((await heartbeat(c)).body.commands as { id: string; kind: string; payload: Record<string, unknown> }[]).filter((x) => x.kind === 'config_backup');
  const due = (runId: string) => systemPool.query(`UPDATE playbook_runs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [runId]);

  it('lists the new actions, always asks for the disruptive ones, previews them in a dry run, and fails honestly when the router is gone', async () => {
    const { a, deviceId } = await withDevice('pb-devctl');
    const cat = (await a.agent.get('/api/v1/playbooks/catalog')).body;
    for (const key of ['router_wifi', 'router_reboot', 'switch_port_quarantine', 'switch_port_disable']) {
      expect(cat.actions.find((x: { key: string }) => x.key === key), key).toMatchObject({ always_approve: true, default_risk: 'disruptive' });
    }
    expect(cat.actions.find((x: { key: string }) => x.key === 'config_backup')).toMatchObject({ always_approve: false, default_risk: 'low' });
    // Router id and Wi-Fi id are required for router steps.
    const bad = await a.agent.post('/api/v1/playbooks').set(CSRF).send({ name: 'bad', trigger: manual, steps: [{ action: 'router_reboot', params: {} }] });
    expect(bad.status).toBe(400);

    // A router step names a router of the organization; an unknown one is refused when saving.
    const ghost = await a.agent
      .post('/api/v1/playbooks')
      .set(CSRF)
      .send({ name: 'ghost', trigger: manual, steps: [{ action: 'router_wifi', params: { router_id: randomUUID(), wifi_id: 'wl0', enabled: false } }, { action: 'router_reboot', params: { router_id: randomUUID() } }] });
    expect(ghost.status).toBe(400);
    expect(ghost.body.error.details.map((d: { path: string }) => d.path)).toEqual(['steps.0.params.router_id', 'steps.1.params.router_id']);
    // Scheduled backup step without a target: refused.
    const sched = await a.agent.post('/api/v1/playbooks').set(CSRF).send({ name: 'nightly', trigger: { kind: 'schedule', daily_at: '03:00' }, steps: [{ action: 'config_backup', params: {} }] });
    expect(sched.status).toBe(400);

    // A device that no switch has seen: the approved disable step fails without touching anything.
    const sp = await createPlaybook(a, { steps: [{ key: 'off', action: 'switch_port_disable', params: {} }] });
    const preview = await a.agent.post(`/api/v1/playbooks/${sp.id}/run`).set(CSRF).send({ device_id: deviceId, dry_run: true });
    expect(preview.body.steps[0]).toMatchObject({ status: 'previewed', input: { device_id: deviceId, admin_up: false } });
    const spRun = await a.agent.post(`/api/v1/playbooks/${sp.id}/run`).set(CSRF).send({ device_id: deviceId });
    const decided = await a.agent.post(`/api/v1/playbook-runs/${spRun.body.id}/steps/${awaitingStep(spRun.body).id}/decision`).set(CSRF).send({ decision: 'approve' });
    expect(decided.body.status).toBe('failed');
    expect(decided.body.steps[0].error).toContain('not_located');
    expect((await systemPool.query(`SELECT 1 FROM switch_port_requests WHERE organization_id = $1`, [a.organizationId])).rowCount).toBe(0);
  });

  it('backs up a configuration from a playbook, and the loop guard stops self-triggering and over-long chains', async () => {
    const { a, c, deviceId } = await withDevice('pb-backup');
    const added = await a.agent
      .post('/api/v1/config-backup/targets')
      .set(CSRF)
      .send({ site_id: a.siteId, targets: [{ address: '192.168.60.20', name: 'edge-rtr' }], credentials: { username: 'backup', password: 'Pw-For-Backup-1' }, run_now: false });
    expect(added.status).toBe(201);
    const targetId = added.body.items[0].id as string;
    expect(added.body.items[0].device_id).toBe(deviceId);

    // A playbook step takes a backup: queued for the collector, finished by its result.
    const manualPb = await createPlaybook(a, { steps: [{ key: 'bk', action: 'config_backup', params: {} }] });
    let run = await a.agent.post(`/api/v1/playbooks/${manualPb.id}/run`).set(CSRF).send({ device_id: deviceId });
    expect(run.body.steps[0]).toMatchObject({ status: 'running', input: { target_id: targetId, device_id: deviceId } });
    let [cmd] = await backupCommands(c);
    expect(cmd!.payload).toMatchObject({ target_id: targetId, username: 'backup' });
    expect((await telemetry(c, [backupResult(cmd!, 'hostname edge-rtr\nsnmp-server community one RO\n')])).body).toMatchObject({ accepted: 1 });
    await due(run.body.id);
    await playbookTick();
    run = await a.agent.get(`/api/v1/playbook-runs/${run.body.id}`);
    expect(run.body.status).toBe('succeeded');
    expect(run.body.steps[0].output).toMatchObject({ outcome: 'first' });
    expect((await systemPool.query(`SELECT trigger FROM config_backup_runs WHERE target_id = $1`, [targetId])).rows[0].trigger).toBe('playbook');

    // Z backs up again whenever the configuration changes; Y only notifies.
    const z = await createPlaybook(a, { name: 'Z', trigger: { kind: 'event', event_types: ['config_changed'] }, enabled: true, steps: [{ key: 'bk', action: 'config_backup', params: {} }] });
    const y = await createPlaybook(a, { name: 'Y', trigger: { kind: 'event', event_types: ['config_changed'] }, enabled: true, steps: [{ action: 'notify', params: { title: 'config changed' } }] });

    // A change found by a manual backup (no playbook caused it): both start.
    const manualRun = await a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({});
    expect(manualRun.status).toBe(202);
    [cmd] = await backupCommands(c);
    await telemetry(c, [backupResult(cmd!, 'hostname edge-rtr\nsnmp-server community two RO\n')]);
    await playbookTick();
    const zRuns = async () => (await a.agent.get(`/api/v1/playbook-runs?playbook_id=${z.id}`)).body.items as { id: string; status: string; status_reason: string | null; chain: string[] }[];
    const yRuns = async () => (await a.agent.get(`/api/v1/playbook-runs?playbook_id=${y.id}`)).body.items as { id: string; status: string; status_reason: string | null; chain: string[] }[];
    expect((await zRuns()).map((r) => r.status)).toEqual(['waiting']);
    expect((await yRuns()).map((r) => r.status)).toEqual(['succeeded']);
    const r1 = (await zRuns())[0]!;

    // Pretend Z's run was itself the third link of a chain, then let its backup find another change.
    const [u1, u2] = [randomUUID(), randomUUID()];
    await systemPool.query(`UPDATE playbook_runs SET chain = ARRAY[$2::uuid, $3::uuid] WHERE id = $1`, [r1.id, u1, u2]);
    [cmd] = await backupCommands(c);
    await telemetry(c, [backupResult(cmd!, 'hostname edge-rtr\nsnmp-server community three RO\n')]);
    await playbookTick();

    const zAfter = await zRuns();
    const zSkipped = zAfter.find((r) => r.status === 'skipped');
    expect(zSkipped?.status_reason).toContain('same playbook');
    const ySkipped = (await yRuns()).find((r) => r.status === 'skipped');
    expect(ySkipped?.status_reason).toContain('3 playbooks already triggered each other');
    // Nothing more was queued for the device by the guarded runs.
    expect((await systemPool.query(`SELECT count(*)::int AS n FROM config_backup_runs WHERE target_id = $1 AND status = 'pending'`, [targetId])).rows[0].n).toBe(0);
  });
});
