import request from 'supertest';
import { CSRF, app, type TestAccount } from './helpers.ts';

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
