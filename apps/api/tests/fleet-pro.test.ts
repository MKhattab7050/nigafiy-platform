import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { waitingPollCount } from '../src/modules/endpoints/agent/wake.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

/** An enrolled, online Windows endpoint with its agent credential. */
export async function onlineEndpoint(a: TestAccount, name = 'FLEET-PC-01', platform: 'windows' | 'linux' | 'macos' = 'windows') {
  const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name, platform });
  if (created.status !== 201) throw new Error(`create endpoint: ${created.status} ${JSON.stringify(created.body)}`);
  const epId: string = created.body.endpoint.id;
  const os = platform === 'macos' ? 'darwin' : platform;
  const enrolled = await request(app).post('/api/v1/agent/enroll').send({ enrollment_token: created.body.enrollment_token, hostname: name, agent_version: '0.3.0', os, arch: 'amd64' });
  const cred: string = enrolled.body.credential;
  const hb = await request(app)
    .post('/api/v1/agent/heartbeat')
    .set('Authorization', `Bearer ${cred}`)
    .send({ agent_version: '0.3.0', hostname: name, os, arch: 'amd64', uptime_seconds: 60, cpu_pct: 5, ram_used_mb: 1000, ram_pct: 20 });
  if (hb.status !== 200) throw new Error(`heartbeat: ${hb.status}`);
  return { epId, cred };
}

describe('agent long poll (?wait_ms=, woken through pg_notify)', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('holds an empty poll and answers as soon as a command is queued', async () => {
    const a = await newAccount('longpoll');
    const { epId, cred } = await onlineEndpoint(a);

    // Nothing pending: without wait_ms the poll answers at once (older agents).
    const quick = await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({});
    expect(quick.body.commands).toEqual([]);

    const started = Date.now();
    const polling = request(app).post('/api/v1/agent/poll?wait_ms=15000').set('Authorization', `Bearer ${cred}`).send({});
    const queued = (async () => {
      await new Promise((r) => setTimeout(r, 400));
      return a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'refresh_inventory' });
    })();
    const [poll, cmd] = await Promise.all([polling, queued]);
    expect(cmd.status).toBe(202);
    expect(poll.status).toBe(200);
    expect(poll.body.commands.map((c: { id: string }) => c.id)).toEqual([cmd.body.id]);
    // Woken by the notification: far sooner than the 15 s wait and the 2 s re-check.
    expect(Date.now() - started).toBeLessThan(1_900);
  });

  it('is woken by a command inserted through another database connection (another API instance)', async () => {
    const a = await newAccount('longpoll2');
    const { epId, cred } = await onlineEndpoint(a);
    const started = Date.now();
    const polling = request(app).post('/api/v1/agent/poll?wait_ms=15000').set('Authorization', `Bearer ${cred}`).send({});
    await new Promise((r) => setTimeout(r, 300));
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    let id = '';
    try {
      const ins = await other.query<{ id: string }>(
        `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload) VALUES ($1,$2,'refresh_inventory','{}') RETURNING id`,
        [a.organizationId, epId],
      );
      id = ins.rows[0]!.id;
    } finally {
      await other.end();
    }
    const poll = await polling;
    expect(poll.body.commands.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(Date.now() - started).toBeLessThan(1_900);
  });

  it('returns an empty list when the wait ends, caps the wait and stops waiting when the agent disconnects', async () => {
    const a = await newAccount('longpoll3');
    const { cred } = await onlineEndpoint(a);
    const started = Date.now();
    const poll = await request(app).post('/api/v1/agent/poll?wait_ms=700').set('Authorization', `Bearer ${cred}`).send({});
    expect(poll.body.commands).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);

    // A disconnected agent's poll is not left waiting.
    const before = waitingPollCount();
    const req = request(app).post('/api/v1/agent/poll?wait_ms=20000').set('Authorization', `Bearer ${cred}`).timeout(300).send({});
    await req.then(
      () => undefined,
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(waitingPollCount()).toBe(before);

    // A bad credential is refused before any wait.
    const bad = await request(app).post('/api/v1/agent/poll?wait_ms=20000').set('Authorization', 'Bearer lda_00000000-0000-0000-0000-000000000000.xxxxxxxxxxxxxxxxxxxxxxxx').send({});
    expect(bad.status).toBe(401);
  });
});
