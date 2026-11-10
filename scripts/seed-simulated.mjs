// SIMULATED DATA — for UI development and demos only.
//
//   node scripts/seed-simulated.mjs            (prints the login it created)
//
// Creates an organization named "SIMULATED demo (not real data)" and feeds it invented telemetry
// through the real collector API, acting as a fake collector. Nothing here is measured from a
// network. It exists so screens like Topology, Incidents and Time Machine can be seen with a
// realistic shape before a real LAN is connected. It then keeps the fake collector "online" by
// heart-beating until you press Ctrl+C.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:4100';
const email = `simulated-${Date.now()}@example.test`;
const password = `sim-${randomUUID()}`;
let cookie = '';

async function call(method, url, body, bearer) {
  const res = await fetch(`${API}/api/v1${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-LD-CSRF': '1', ...(bearer ? { Authorization: `Bearer ${bearer}` } : cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.().find((c) => c.startsWith('ld_session='));
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const jitter = (base, spread) => Math.round((base + (Math.random() - 0.5) * spread) * 10) / 10;

await call('POST', '/auth/register', { email, password, display_name: 'Simulated Admin', organization_name: 'SIMULATED demo (not real data)', site_name: 'Simulated office' });
const site = (await call('GET', '/sites')).items[0];
const scope = await call('POST', `/sites/${site.id}/scopes`, { cidr: '192.168.10.0/24', label: 'SIMULATED LAN', authorization_confirmed: true });
const created = await call('POST', '/collectors', { site_id: site.id, name: 'simulated-collector' });
const enrolled = await call('POST', '/collector/enroll', { enrollment_token: created.enrollment_token, hostname: 'simulated-host', version: '0.0.0-simulated', os: 'linux', arch: 'amd64' });
const cred = enrolled.credential;
const beat = () => call('POST', '/collector/heartbeat', { version: '0.0.0-simulated', hostname: 'simulated-host', os: 'linux', arch: 'amd64', uptime_seconds: 3600, gateway_ip: '192.168.10.1', interfaces: [{ name: 'eth0', addresses: ['192.168.10.5/24'] }], spool_depth: 0, completed_commands: [] }, cred);
await beat();

const erp = await call('POST', '/checks', { site_id: site.id, name: 'ERP web (simulated)', kind: 'tcp', role: 'service', target: '192.168.10.20', port: 8443, interval_seconds: 60 });
const checks = (await call('GET', '/checks')).items;
const id = (target) => checks.find((c) => c.target === target).id;

const mac = (n) => `00:0c:29:5a:00:${n.toString(16).padStart(2, '0')}`;
const hosts = [
  { ip: '192.168.10.1', mac: mac(1), hostname: 'gw.sim.lan' },
  { ip: '192.168.10.5', mac: mac(5), hostname: 'collector.sim.lan' },
  { ip: '192.168.10.10', mac: mac(10), hostname: 'core-switch.sim.lan' },
  { ip: '192.168.10.20', mac: mac(20), hostname: 'erp.sim.lan' },
  { ip: '192.168.10.21', mac: mac(21), hostname: 'files.sim.lan' },
  { ip: '192.168.10.30', mac: mac(30), hostname: 'printer-1.sim.lan' },
  { ip: '192.168.10.31', mac: mac(31), hostname: 'printer-2.sim.lan' },
  { ip: '192.168.10.40', mac: mac(40), hostname: 'ap-lobby.sim.lan' },
  ...Array.from({ length: 10 }, (_, i) => ({ ip: `192.168.10.${100 + i}`, mac: mac(100 + i), hostname: `pc-${i + 1}.sim.lan` })),
  { ip: '192.168.10.150', mac: 'da:a1:19:5a:00:96' }, // randomized MAC, no name
  { ip: '192.168.10.151' }, // answered ICMP only
];
const flaky = '192.168.10.104';

const items = [];
for (let m = 60; m >= 0; m -= 5) {
  const present = hosts.filter((h) => !(h.ip === flaky && m <= 40 && m >= 30) && !(h.ip === '192.168.10.109' && m > 20));
  const finished = new Date(Date.now() - m * 60_000);
  items.push({ at: finished.getTime(), item: { type: 'discovery_run', run_id: randomUUID(), scope_id: scope.id, trigger: 'scheduled', started_at: new Date(finished.getTime() - 6000).toISOString(), finished_at: finished.toISOString(), hosts_probed: 254, hosts: present.map((h) => ({ ...h, rtt_ms: jitter(1.2, 1), sources: h.mac ? ['icmp', 'arp_cache', ...(h.hostname ? ['rdns'] : [])] : ['icmp'] })) } });
}
for (let s = 60 * 60; s >= 0; s -= 30) {
  const m = s / 60;
  const outage = m <= 25 && m >= 18; // simulated ISP outage
  const ts = new Date(Date.now() - s * 1000).toISOString();
  const ok = (check, latency, extra = {}) => ({ type: 'check_result', check_id: check, ts, ok: true, latency_ms: jitter(latency, latency * 0.3), ...extra });
  const fail = (check, error, extra = {}) => ({ type: 'check_result', check_id: check, ts, ok: false, error, ...extra });
  const at = Date.now() - s * 1000;
  items.push({ at, item: ok(id('auto:gateway'), 1.8, { loss_pct: 0, jitter_ms: 0.3, resolved_target: '192.168.10.1' }) });
  for (const [target, base] of [['1.1.1.1', 14], ['8.8.8.8', 17]]) {
    items.push({ at, item: outage ? fail(id(target), 'no echo reply (5 requests sent)', { loss_pct: 100 }) : ok(id(target), base, { loss_pct: 0, jitter_ms: 1.1 }) });
  }
  items.push({ at, item: outage ? fail(id('example.com'), 'timed out') : ok(id('example.com'), 22, { resolved_target: '93.184.216.34' }) });
  if (s % 60 === 0) items.push({ at, item: m <= 6 ? fail(erp.id, 'connect: connection refused', { resolved_target: '192.168.10.20' }) : ok(erp.id, 3, { resolved_target: '192.168.10.20' }) });
}
items.sort((a, b) => a.at - b.at);
for (let i = 0; i < items.length; i += 200) {
  const res = await call('POST', '/collector/telemetry', { batch_id: randomUUID(), sent_at: new Date().toISOString(), items: items.slice(i, i + 200).map((x) => x.item) }, cred);
  if (res.rejected.length) console.warn('rejected:', res.rejected.slice(0, 3));
}

// Mark two simulated devices as critical / classified so the UI has something to show.
const devices = (await call('GET', '/devices?page_size=200')).items;
const dev = (host) => devices.find((d) => d.hostname === host);
await call('PATCH', `/devices/${dev('core-switch.sim.lan').id}`, { device_type: 'switch', is_critical: true, tags: ['simulated', 'core'] });
await call('PATCH', `/devices/${dev('erp.sim.lan').id}`, { device_type: 'server', tags: ['simulated'] });
await call('PATCH', `/devices/${dev('ap-lobby.sim.lan').id}`, { device_type: 'access_point', tags: ['simulated'] });

const out = path.resolve(import.meta.dirname, '../.data');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'simulated-login.txt'), `SIMULATED demo organization (invented data, not measured)\nemail: ${email}\npassword: ${password}\n`);
const incidents = (await call('GET', '/incidents')).items;
console.log(`Simulated organization ready: ${devices.length} devices, ${incidents.length} incidents (${incidents.filter((i) => i.status !== 'resolved').length} active).`);
console.log('Login written to .data/simulated-login.txt (git-ignored). Heart-beating every 20 s — Ctrl+C to stop.');

setInterval(async () => {
  try {
    await beat();
    const ts = new Date().toISOString();
    await call('POST', '/collector/telemetry', { batch_id: randomUUID(), sent_at: ts, items: [
      { type: 'check_result', check_id: id('auto:gateway'), ts, ok: true, latency_ms: jitter(1.8, 0.6), loss_pct: 0, resolved_target: '192.168.10.1' },
      { type: 'check_result', check_id: id('1.1.1.1'), ts, ok: true, latency_ms: jitter(14, 4), loss_pct: 0 },
      { type: 'check_result', check_id: id('8.8.8.8'), ts, ok: true, latency_ms: jitter(17, 4), loss_pct: 0 },
      { type: 'check_result', check_id: id('example.com'), ts, ok: true, latency_ms: jitter(22, 6) },
    ] }, cred);
  } catch (err) {
    console.error(err.message);
  }
}, 20_000);
