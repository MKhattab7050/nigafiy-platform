import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type Page, expect } from '@playwright/test';

/**
 * Gives the signed-in test account one of every record that has its own page (a device, an
 * endpoint, an incident, a router, a configuration-backup target, a knowledge article, a playbook
 * and one of its runs), so the browser walk opens the detail screens too.
 *
 * Everything goes through the real API with the browser's session cookie. The device, the
 * incident and the endpoint come from the real collector and agent protocol (enrol, heartbeat,
 * telemetry), sent by this test: no Sensor or Agent runs, so no network is scanned and the router
 * address below (private range 10.250.0.0/24, inside the account's own
 * authorized scope) is never contacted. Commands the API queues for the "collector" are never
 * collected.
 */
export interface Seeded {
  deviceId: string;
  endpointId: string;
  incidentId: string;
  routerId: string;
  configTargetId: string;
  knowledgeId: string;
  playbookId: string;
  runId: string;
}

const CSRF = { 'X-LD-CSRF': '1' };
const CIDR = '10.250.0.0/24';

async function ok<T>(what: string, res: Awaited<ReturnType<APIRequestContext['get']>>, status = [200, 201]): Promise<T> {
  const body = await res.text();
  expect(status, `${what}: ${res.status()} ${body.slice(0, 400)}`).toContain(res.status());
  return (body ? JSON.parse(body) : {}) as T;
}

/** check_result samples: `n` of them, 10 s apart, the newest `endSecondsAgo` seconds ago. */
function samples(checkId: string, n: number, endSecondsAgo: number, good: boolean, extra: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'check_result',
    check_id: checkId,
    ts: new Date(Date.now() - (endSecondsAgo + (n - 1 - i) * 10) * 1000).toISOString(),
    ok: good,
    ...(good ? { latency_ms: 12, loss_pct: 0 } : { loss_pct: 100, error: 'no echo reply (5 requests sent)' }),
    ...extra,
  }));
}

export async function seedRecords(page: Page): Promise<Seeded> {
  const api = page.request;
  const sites = await ok<{ items: { id: string }[] }>('sites', await api.get('/api/v1/sites'));
  const siteId = sites.items[0]!.id;

  const scope = await ok<{ id: string }>(
    'scope',
    await api.post(`/api/v1/sites/${siteId}/scopes`, { headers: CSRF, data: { cidr: CIDR, authorization_confirmed: true } }),
  );

  // A collector enrolled by this test (protocol only): heartbeat, one discovery sweep, check results.
  const created = await ok<{ enrollment_token: string }>('collector', await api.post('/api/v1/collectors', { headers: CSRF, data: { site_id: siteId, name: 'e2e-sensor' } }));
  const enrolled = await ok<{ credential: string }>(
    'collector enroll',
    await api.post('/api/v1/collector/enroll', {
      data: { enrollment_token: created.enrollment_token, hostname: 'e2e-host', version: '0.1.0-test', os: 'linux', arch: 'amd64' },
    }),
  );
  const bearer = { Authorization: `Bearer ${enrolled.credential}` };
  const telemetry = async (items: unknown[]) =>
    ok('telemetry', await api.post('/api/v1/collector/telemetry', { headers: bearer, data: { batch_id: randomUUID(), sent_at: new Date().toISOString(), items } }));
  await ok(
    'heartbeat',
    await api.post('/api/v1/collector/heartbeat', {
      headers: bearer,
      data: { version: '0.1.0-test', hostname: 'e2e-host', os: 'linux', arch: 'amd64', uptime_seconds: 10, spool_depth: 0, gateway_ip: '10.250.0.1' },
    }),
  );
  const finished = new Date();
  await telemetry([
    {
      type: 'discovery_run',
      run_id: randomUUID(),
      scope_id: scope.id,
      trigger: 'scheduled',
      started_at: new Date(finished.getTime() - 5000).toISOString(),
      finished_at: finished.toISOString(),
      hosts_probed: 254,
      hosts: [
        { ip: '10.250.0.1', mac: 'aa:bb:cc:00:fa:01', hostname: 'e2e-gateway', sources: ['icmp', 'arp_cache'] },
        { ip: '10.250.0.20', mac: 'aa:bb:cc:00:fa:20', hostname: 'e2e-printer', sources: ['icmp', 'arp_cache'] },
      ],
    },
  ]);
  const devices = await ok<{ items: { id: string; current_ip: string }[] }>('devices', await api.get('/api/v1/devices?page_size=50'));
  const deviceId = devices.items.find((d) => d.current_ip === '10.250.0.20')!.id;

  // An internet outage the way the Sensor reports it: both internet checks and DNS fail, the gateway answers → one incident.
  const checks = await ok<{ items: { id: string; target: string }[] }>('checks', await api.get('/api/v1/checks'));
  const by = (target: string) => checks.items.find((c) => c.target === target)!.id;
  const [gw, cf, google, dns] = [by('auto:gateway'), by('1.1.1.1'), by('8.8.8.8'), by('example.com')];
  const gwOk = { resolved_target: '10.250.0.1', latency_ms: 2 };
  await telemetry([...samples(gw, 2, 600, true, gwOk), ...samples(cf, 2, 600, true), ...samples(google, 2, 600, true), ...samples(dns, 2, 600, true)]);
  await telemetry([...samples(cf, 3, 300, false), ...samples(google, 3, 300, false), ...samples(gw, 3, 300, true, gwOk)]);
  await telemetry(samples(dns, 3, 270, false, { error: 'timed out' }));
  const incidents = await ok<{ items: { id: string }[] }>('incidents', await api.get('/api/v1/incidents?status=all'));
  expect(incidents.items.length, 'the outage opened an incident').toBeGreaterThan(0);

  // An endpoint enrolled and reporting through the Agent protocol.
  const ep = await ok<{ endpoint: { id: string }; enrollment_token: string }>(
    'endpoint',
    await api.post('/api/v1/endpoints', { headers: CSRF, data: { site_id: siteId, name: 'E2E-PC-01', platform: 'windows' } }),
  );
  const agent = await ok<{ credential: string }>(
    'agent enroll',
    await api.post('/api/v1/agent/enroll', { data: { enrollment_token: ep.enrollment_token, hostname: 'E2E-PC-01', agent_version: '0.3.0', os: 'windows', arch: 'amd64' } }),
  );
  await ok(
    'agent heartbeat',
    await api.post('/api/v1/agent/heartbeat', {
      headers: { Authorization: `Bearer ${agent.credential}` },
      data: { agent_version: '0.3.0', hostname: 'E2E-PC-01', os: 'windows', arch: 'amd64', uptime_seconds: 60, cpu_pct: 5, ram_used_mb: 1000, ram_pct: 20 },
    }),
  );

  const router = await ok<{ id: string }>(
    'router',
    await api.post('/api/v1/routers', {
      headers: CSRF,
      data: { site_id: siteId, name: 'E2E gateway', vendor: 'zyxel', address: '10.250.0.1', credentials: { username: 'e2e-user', password: 'e2e-test-only' } },
    }),
  );
  const target = await ok<{ items: { id: string }[] }>(
    'config-backup target',
    await api.post('/api/v1/config-backup/targets', { headers: CSRF, data: { site_id: siteId, targets: [{ address: '10.250.0.1' }] } }),
  );
  const article = await ok<{ id: string }>(
    'knowledge',
    await api.post('/api/v1/knowledge', { headers: CSRF, data: { title: 'Printer offline after DHCP renew', fix_steps: 'Power-cycle it.', device_id: deviceId, publish: true } }),
  );
  // A playbook whose run stops at its approval gate: nothing after the gate happens.
  const playbook = await ok<{ id: string }>(
    'playbook',
    await api.post('/api/v1/playbooks', {
      headers: CSRF,
      data: {
        name: 'E2E playbook',
        trigger: { kind: 'manual' },
        steps: [
          { key: 'tell', action: 'notify', params: { title: 'Starting on {device} ({ip})', severity: 'info', attach: 'none' } },
          { key: 'gate', action: 'approval', params: { message: 'Mark the printer as unwanted?' } },
          { key: 'mark', action: 'set_trust', params: { trust: 'unwanted' } },
        ],
      },
    }),
  );
  const run = await ok<{ id: string }>('playbook run', await api.post(`/api/v1/playbooks/${playbook.id}/run`, { headers: CSRF, data: { device_id: deviceId } }));

  return {
    deviceId,
    endpointId: ep.endpoint.id,
    incidentId: incidents.items[0]!.id,
    routerId: router.id,
    configTargetId: target.items[0]!.id,
    knowledgeId: article.id,
    playbookId: playbook.id,
    runId: run.id,
  };
}
