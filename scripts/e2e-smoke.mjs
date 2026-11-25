// End-to-end smoke test against a RUNNING stack (API + database) and the real collector binary.
//
//   node scripts/e2e-smoke.mjs
//
// It registers a throw-away organization, authorizes the loopback range 127.0.0.0/29 as a
// permitted test network (needs ALLOW_LOOPBACK_SCOPES=true on the API), starts the collector,
// and verifies that real ICMP discovery results and real check measurements arrive.
// Everything it creates is clearly labelled "E2E smoke".
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:4100';
const root = path.resolve(import.meta.dirname, '..');
// The Sensor is the engine executable run as `nigafiy-engine sensor` (pnpm build:engine).
const binary = path.join(root, 'engine/bin', process.platform === 'win32' ? 'nigafiy-engine.exe' : 'nigafiy-engine');
const keep = process.argv.includes('--keep-running');
// E2E_SCOPE: a range YOU own. Defaults to the loopback test network.
const SCOPE = process.env.E2E_SCOPE ?? '127.0.0.0/29';
const loopback = SCOPE.startsWith('127.');
const minDevices = loopback ? 6 : 1;

let cookie = '';
async function api(method, url, body) {
  const res = await fetch(`${API}/api/v1${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-LD-CSRF': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.().find((c) => c.startsWith('ld_session='));
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
const step = (msg) => console.log(`\n▸ ${msg}`);

const email = process.env.E2E_EMAIL ?? `e2e-${Date.now()}@example.test`;
const password = process.env.E2E_PASSWORD ?? `e2e-${crypto.randomUUID()}`;

step(`registering ${email}`);
await api('POST', '/auth/register', { email, password, display_name: 'E2E Smoke', organization_name: loopback ? 'E2E smoke org' : 'My network', site_name: loopback ? 'Loopback lab' : 'Main site' });
const site = (await api('GET', '/sites')).items[0];

step(`authorizing scope ${SCOPE}`);
await api('POST', `/sites/${site.id}/scopes`, { cidr: SCOPE, label: loopback ? 'E2E loopback' : 'LAN', authorization_confirmed: true });

step('creating collector + enrollment token');
const created = await api('POST', '/collectors', { site_id: site.id, name: 'e2e-collector' });

const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ld-e2e-collector-'));
const configPath = path.join(stateDir, 'collector.yaml');
writeFileSync(
  configPath,
  [`server_url: ${API}`, `state_dir: ${JSON.stringify(path.join(stateDir, 'state'))}`, `allowed_cidrs: ["${SCOPE}"]`, 'allow_insecure_http: true', `allow_loopback_scopes: ${loopback}`, 'log_level: info', ''].join('\n'),
);

step('starting collector binary');
const collector = spawn(binary, ['sensor', '-config', configPath], { env: { ...process.env, NIGAFIY_SENSOR_ENROLLMENT_TOKEN: created.enrollment_token }, stdio: ['ignore', 'inherit', 'pipe'] });
let leakedSecret = false;
collector.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  if (text.includes(created.enrollment_token) || /ldc_[0-9a-f-]{36}\./.test(text)) leakedSecret = true;
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      console.log(`    collector │ ${j.level} ${j.msg}${j.cidr ? ` ${j.cidr} found=${j.found}/${j.probed}` : ''}${j.error ? ` (${j.error})` : ''}`);
    } catch {
      console.log(`    collector │ ${line}`);
    }
  }
});

let failed = false;
try {
  const online = await until('collector online', async () => (await api('GET', '/collectors')).items.find((c) => c.connection_state === 'online'));
  console.log(`  collector online: ${online.hostname} ${online.os}/${online.arch} v${online.version}, gateway ${online.gateway_ip ?? 'none'}`);

  const devices = await until('devices discovered', async () => {
    const d = await api('GET', '/devices?page_size=200');
    return d.total >= minDevices ? d : null;
  });
  console.log(`  ${devices.total} devices discovered in ${SCOPE}:`);
  for (const d of devices.items) console.log(`    ${d.current_ip.padEnd(12)} ${(d.primary_mac ?? '-').padEnd(18)} ${(d.vendor ?? (d.mac_randomized ? '(randomized MAC)' : '-')).slice(0, 28).padEnd(29)} ${(d.hostname ?? '-').slice(0, 22).padEnd(23)} type=${d.device_type} via=${d.discovery_sources.join('+')}`);

  const checks = await until('check results', async () => {
    const c = (await api('GET', '/checks')).items;
    return c.filter((x) => x.state !== 'unknown').length >= 3 ? c : null;
  });
  console.log('  monitoring checks (measured from this machine):');
  for (const c of checks) console.log(`    ${c.name.padEnd(36)} state=${c.state.padEnd(8)} latency=${c.last_latency_ms?.toFixed(1) ?? '—'} ms loss=${c.last_loss_pct ?? '—'}% target=${c.last_resolved_target ?? c.target}${c.last_error ? ` error="${c.last_error}"` : ''}`);

  step('requesting a manual scan');
  const collectorId = (await api('GET', '/collectors')).items[0].id;
  await api('POST', `/collectors/${collectorId}/scan`);
  await until('manual scan baseline + events', async () => (await api('GET', '/events?limit=50')).items.some((e) => e.type === 'discovery_baseline'));

  const overview = await api('GET', '/overview');
  console.log(`\n  overview: devices ${overview.devices.online}/${overview.devices.total} online · collectors ${overview.collectors.online}/${overview.collectors.total} · internet ${overview.internet.state} ${overview.internet.avg_latency_ms?.toFixed(1) ?? '—'} ms · gateway ${overview.gateway.state} · dns ${overview.dns.state}`);
  const events = (await api('GET', '/events?limit=10')).items;
  for (const e of events) console.log(`    event [${e.severity}] ${e.title}`);
  if (leakedSecret) throw new Error('collector logs contain a token or credential');
  console.log('\n✔ end-to-end smoke test passed (no secrets in collector logs)');
  if (keep) {
    console.log(`\nLeaving the collector running. Sign in at the web app with:\n  email:    ${email}\n  password: (the E2E_PASSWORD you provided, or re-run with E2E_EMAIL/E2E_PASSWORD set)\nCtrl+C to stop.`);
    await new Promise(() => undefined);
  }
} catch (err) {
  failed = true;
  console.error(`\n✘ ${err.message}`);
} finally {
  collector.kill('SIGINT');
  await sleep(500);
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
