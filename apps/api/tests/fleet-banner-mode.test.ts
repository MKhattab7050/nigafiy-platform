import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// fleet_groups.banner_mode (migration 051): a group of company-managed computers may minimize or
// turn off the session banner, only for unattended sessions. The audit log is written in every mode.

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };

async function pollFor(cred: string): Promise<Cmd[]> {
  return (await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({})).body.commands;
}

async function answer(cred: string, id: string, data: Record<string, unknown>) {
  const r = await request(app)
    .post('/api/v1/agent/command-result')
    .set('Authorization', `Bearer ${cred}`)
    .send({ command_results: [{ id, ok: true, output: '', data }] });
  expect(r.status).toBe(200);
}

async function audits(orgId: string, action: string): Promise<Array<{ metadata: Record<string, unknown> }>> {
  return (await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;
}

async function group(a: TestAccount, body: Record<string, unknown>) {
  return a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: `B-${Math.random().toString(36).slice(2, 8)}`, ...body });
}

async function assign(a: TestAccount, epId: string, groupId: string) {
  expect((await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: groupId })).status).toBe(200);
}

describe('fleet group banner_mode', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('accepts minimized and off only for unattended groups', async () => {
    const a = await newAccount('banner-matrix');
    // Silent by default (migration 052): a new group is unattended with the banner off; an
    // attended group without a banner_mode gets the full banner.
    const silent = await group(a, {});
    expect(silent.status).toBe(201);
    expect(silent.body.group).toMatchObject({ access_mode: 'unattended', banner_mode: 'off' });
    const plain = await group(a, { access_mode: 'attended' });
    expect(plain.status).toBe(201);
    expect(plain.body.group.banner_mode).toBe('shown');

    for (const mode of ['off', 'minimized']) {
      const attended = await group(a, { access_mode: 'attended', banner_mode: mode });
      expect(attended.status).toBe(422);
      expect(attended.body.error.code).toBe('banner_mode_needs_unattended');
      const ok = await group(a, { access_mode: 'unattended', banner_mode: mode });
      expect(ok.status).toBe(201);
      expect(ok.body.group.banner_mode).toBe(mode);
    }
    expect((await group(a, { access_mode: 'unattended', banner_mode: 'hidden' })).status).toBe(400);

    // Patching: an attended group cannot hide the banner, and an unattended group with the banner
    // off cannot become attended without showing it again.
    const g = (await group(a, { access_mode: 'unattended', banner_mode: 'off' })).body.group;
    const toAttended = await a.agent.patch(`/api/v1/fleet/groups/${g.id}`).set(CSRF).send({ access_mode: 'attended' });
    expect(toAttended.status).toBe(422);
    expect(toAttended.body.error.code).toBe('banner_mode_needs_unattended');
    const both = await a.agent.patch(`/api/v1/fleet/groups/${g.id}`).set(CSRF).send({ access_mode: 'attended', banner_mode: 'shown' });
    expect(both.status).toBe(200);
    expect(both.body.group).toMatchObject({ access_mode: 'attended', banner_mode: 'shown' });
    expect((await a.agent.patch(`/api/v1/fleet/groups/${plain.body.group.id}`).set(CSRF).send({ banner_mode: 'off' })).status).toBe(422);

    // The policy change is audited with the banner mode before and after.
    const changes = await audits(a.organizationId, 'fleet.policy_updated');
    expect(changes.at(-1)?.metadata).toMatchObject({ before: { banner_mode: 'off' }, after: { banner_mode: 'shown' } });
  });

  it('off: no banner, no start or end notice, still audited and still ended from Fleet', async () => {
    const a = await newAccount('banner-off');
    const { epId, cred } = await onlineEndpoint(a);
    const g = (await group(a, { access_mode: 'unattended', banner_mode: 'off' })).body.group;
    await assign(a, epId, g.id);

    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Patch check' });
    expect(start.status).toBe(200);
    expect(start.body.session).toMatchObject({ state: 'active', banner_mode: 'off' });
    const cmds = await pollFor(cred);
    // No "session started" notice for the person: the open command and the first frame only.
    expect(cmds.map((c) => c.kind)).toEqual(['rd_session_open', 'rd_capture']);
    expect(cmds[0]!.payload).toMatchObject({ banner_mode: 'off', consent_required: false, refuse_window_s: 0 });
    await answer(cred, cmds[0]!.id, { consent: 'not_required', banner: 'off', stream: 'connecting' });
    const st = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`);
    expect(st.body.fleet_session).toMatchObject({ banner_state: 'off', banner_mode: 'off' });

    const opened = (await audits(a.organizationId, 'fleet.session_opened')).at(-1)!;
    expect(opened.metadata).toMatchObject({ banner_mode: 'off', operator: a.email });
    const requested = (await audits(a.organizationId, 'fleet.session_requested')).at(-1)!;
    expect(requested.metadata).toMatchObject({ banner_mode: 'off' });
    expect((requested.metadata.trail as Array<{ check: string }>).some((t) => t.check === 'banner')).toBe(true);
    expect((await audits(a.organizationId, 'fleet.session_banner')).at(-1)?.metadata).toMatchObject({ banner: 'off' });

    // Fleet ends it: the agent gets the close command and no "session ended" notice.
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({})).status).toBe(200);
    const after = await pollFor(cred);
    expect(after.map((c) => c.kind)).toContain('rd_session_close');
    expect(after.map((c) => c.kind)).not.toContain('notify_user');
    expect((await audits(a.organizationId, 'fleet.session_ended')).at(-1)?.metadata).toMatchObject({ end_reason: 'operator' });
  });

  it('minimized: the agent is told to draw the corner box and the person is told the session started', async () => {
    const a = await newAccount('banner-min');
    const { epId, cred } = await onlineEndpoint(a);
    const g = (await group(a, { access_mode: 'unattended', banner_mode: 'minimized' })).body.group;
    await assign(a, epId, g.id);
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Disk cleanup' });
    expect(start.body.session.banner_mode).toBe('minimized');
    const cmds = await pollFor(cred);
    expect(cmds.map((c) => c.kind)).toEqual(['notify_user', 'rd_session_open', 'rd_capture']);
    expect(cmds[1]!.payload.banner_mode).toBe('minimized');
    await answer(cred, cmds[1]!.id, { consent: 'not_required', banner: 'minimized', stream: 'connecting' });
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`)).body.fleet_session.banner_state).toBe('minimized');
  });

  it('a refuse window or a help request always shows the full banner', async () => {
    const a = await newAccount('banner-forced');
    const { epId, cred } = await onlineEndpoint(a);
    const g = (await group(a, { access_mode: 'unattended', banner_mode: 'off', refuse_window_s: 15 })).body.group;
    await assign(a, epId, g.id);
    const s1 = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Refuse window' });
    // The group keeps banner_mode off, but a session the person may refuse is not silent.
    expect(s1.body.session.banner_mode).toBe('shown');
    const open1 = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
    expect(open1.payload).toMatchObject({ refuse_window_s: 15, banner_mode: 'shown' });
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
    await pollFor(cred);

    // A help request is accepted by the person on their screen: always the full banner.
    await a.agent.patch(`/api/v1/fleet/groups/${g.id}`).set(CSRF).send({ refuse_window_s: 0 });
    const hr = await request(app).post('/api/v1/agent/help-request').set('Authorization', `Bearer ${cred}`).send({ note: 'Printer', user: 'CORP\\sami' });
    expect(hr.status).toBe(201);
    const s2 = await a.agent.post(`/api/v1/fleet/help-requests/${hr.body.id}/connect`).set(CSRF).send({ reason: 'Help request: printer' });
    expect(s2.status).toBe(200);
    expect(s2.body.session).toMatchObject({ consent_mode: 'prompt', banner_mode: 'shown' });
    const open2 = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
    expect(open2.payload).toMatchObject({ consent_required: true, banner_mode: 'shown' });
  });
});
