import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { systemPool } from '../src/infrastructure/db.ts';

export const app = createApp();
export const CSRF = { 'X-LD-CSRF': '1' };

export interface TestAccount {
  agent: ReturnType<typeof request.agent>;
  email: string;
  organizationId: string;
  siteId: string;
}

/** Registers a brand-new user + organization + site and returns a logged-in agent. */
export async function newAccount(label = 'acme'): Promise<TestAccount> {
  const agent = request.agent(app);
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await agent.post('/api/v1/auth/register').set(CSRF).send({
    email,
    password: 'correct horse battery',
    display_name: `${label} admin`,
    organization_name: `${label} corp`,
    site_name: 'HQ',
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await agent.get('/api/v1/auth/me');
  const sites = await agent.get('/api/v1/sites');
  return { agent, email, organizationId: me.body.organization.id, siteId: sites.body.items[0].id };
}

export async function addScope(account: TestAccount, cidr: string): Promise<string> {
  const res = await account.agent.post(`/api/v1/sites/${account.siteId}/scopes`).set(CSRF).send({ cidr, authorization_confirmed: true });
  if (res.status !== 201) throw new Error(`scope failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export interface TestCollector {
  id: string;
  credential: string;
  enrollmentToken: string;
}

export async function newCollector(account: TestAccount, name = 'edge-1'): Promise<TestCollector> {
  const created = await account.agent.post('/api/v1/collectors').set(CSRF).send({ site_id: account.siteId, name });
  if (created.status !== 201) throw new Error(`collector failed: ${created.status} ${JSON.stringify(created.body)}`);
  const enrolled = await request(app)
    .post('/api/v1/collector/enroll')
    .send({ enrollment_token: created.body.enrollment_token, hostname: 'test-host', version: '0.1.0-test', os: 'linux', arch: 'amd64' });
  if (enrolled.status !== 201) throw new Error(`enroll failed: ${enrolled.status} ${JSON.stringify(enrolled.body)}`);
  return { id: enrolled.body.collector_id, credential: enrolled.body.credential, enrollmentToken: created.body.enrollment_token };
}

export function heartbeat(collector: TestCollector, extra: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/v1/collector/heartbeat')
    .set('Authorization', `Bearer ${collector.credential}`)
    .send({ version: '0.1.0-test', hostname: 'test-host', os: 'linux', arch: 'amd64', uptime_seconds: 10, spool_depth: 0, ...extra });
}

export function telemetry(collector: TestCollector, items: unknown[], batchId: string = randomUUID()) {
  return request(app)
    .post('/api/v1/collector/telemetry')
    .set('Authorization', `Bearer ${collector.credential}`)
    .send({ batch_id: batchId, sent_at: new Date().toISOString(), items });
}

export interface HostInput {
  ip: string;
  mac?: string;
  hostname?: string;
}

/** A discovery sweep item finishing `minutesAgo` minutes in the past. */
export function sweep(scopeId: string, hosts: HostInput[], minutesAgo = 0) {
  const finished = new Date(Date.now() - minutesAgo * 60_000);
  return {
    type: 'discovery_run',
    run_id: randomUUID(),
    scope_id: scopeId,
    trigger: 'scheduled',
    started_at: new Date(finished.getTime() - 5000).toISOString(),
    finished_at: finished.toISOString(),
    hosts_probed: 254,
    hosts: hosts.map((h) => ({ ...h, sources: h.mac ? ['icmp', 'arp_cache'] : ['icmp'] })),
  };
}

export async function setRole(email: string, organizationId: string, role: string): Promise<void> {
  await systemPool.query(
    `UPDATE memberships SET role = $3 WHERE organization_id = $2 AND user_id = (SELECT id FROM users WHERE lower(email) = $1)`,
    [email, organizationId, role],
  );
}
