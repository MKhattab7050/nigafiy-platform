'use strict';
// Drives the REAL lan-collector binary through the desktop manager against a stand-in server
// speaking collector protocol v1. No network scopes are delivered, so nothing is probed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { CollectorManager, normalizeServerUrl, parseCidrs } = require('../src/collector-manager.cjs');

const BINARY = path.join(__dirname, '..', '..', '..', 'collectors', 'lan-collector', 'bin', process.platform === 'win32' ? 'lan-collector.exe' : 'lan-collector');
const TOKEN = 'lde_desktop-test-token-0123456789abcdef';
const CREDENTIAL = 'ldc_11111111-2222-4333-8444-555555555555.desktop-test-secret-0123456789';

function fakeServer() {
  const seen = { enrollments: 0, heartbeats: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status, payload) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
      if (req.url === '/api/v1/collector/enroll') {
        if (JSON.parse(body).enrollment_token !== TOKEN) return json(401, {});
        seen.enrollments++;
        return json(201, { collector_id: '11111111-2222-4333-8444-555555555555', credential: CREDENTIAL });
      }
      if (req.headers.authorization !== `Bearer ${CREDENTIAL}`) return json(401, {});
      if (req.url === '/api/v1/collector/heartbeat') {
        seen.heartbeats++;
        return json(200, { server_time: new Date(), config: { heartbeat_interval_seconds: 30, discovery: { interval_seconds: 300, scopes: [] }, checks: [] }, commands: [] });
      }
      return json(200, { accepted: 0 });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

async function until(label, fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

test('server address and range validation', () => {
  assert.equal(normalizeServerUrl(' https://ld.example.com/some/path '), 'https://ld.example.com');
  assert.equal(normalizeServerUrl('http://localhost:3100'), 'http://localhost:3100');
  assert.throws(() => normalizeServerUrl('http://ld.example.com'), /https/);
  assert.throws(() => normalizeServerUrl('https://user:pw@ld.example.com'), /username/);
  assert.throws(() => normalizeServerUrl('file:///etc/passwd'), /https/);
  assert.throws(() => normalizeServerUrl('not a url'), /valid URL/);
  assert.deepEqual(parseCidrs('192.168.1.0/24, 10.0.5.0/24 ، 192.168.1.0/24'), ['192.168.1.0/24', '10.0.5.0/24']);
  assert.deepEqual(parseCidrs(''), []);
  assert.throws(() => parseCidrs('192.168.1.0'), /not a network range/);
  assert.throws(() => parseCidrs('999.1.1.0/24'), /not a network range/);
});

test('manages the real collector: enroll, run, stop, restart without re-enrolling', { skip: !fs.existsSync(BINARY) && 'collector binary not built (pnpm build:collector)' }, async () => {
  const { server, seen, url } = await fakeServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-desktop-test-'));
  const manager = new CollectorManager({ binaryPath: BINARY, dataDir });
  try {
    assert.equal(manager.getState().enrolled, false);
    assert.throws(() => manager.start(), /server address/);

    // Settings are validated by the collector's own config checker before being saved.
    await assert.rejects(manager.saveSettings({ serverUrl: url, allowedCidrs: 'banana' }), /not a network range/);
    const saved = await manager.saveSettings({ serverUrl: url, allowedCidrs: '192.168.1.0/24' });
    assert.equal(saved.settings.serverUrl, url);
    const yaml = fs.readFileSync(manager.configPath, 'utf8');
    assert.match(yaml, /allowed_cidrs: \["192\.168\.1\.0\/24"\]/);
    assert.match(yaml, /allow_insecure_http: true/); // http://127.0.0.1 only
    assert.doesNotMatch(yaml, /allow_loopback_scopes/);

    assert.throws(() => manager.start(), /not enrolled/);
    assert.throws(() => manager.start({ enrollmentToken: 'hello' }), /enrollment token/);

    // A refused token is reported and not retried in a loop.
    manager.start({ enrollmentToken: 'lde_wrong-token-000000000000000000' });
    await until('refused enrollment reported', () => manager.getState().status === 'error');
    assert.match(manager.getState().lastError, /enrollment refused/i);
    assert.equal(manager.getState().enrolled, false);

    manager.start({ enrollmentToken: TOKEN });
    await until('enrolled and heartbeating', () => manager.getState().enrolled && seen.heartbeats > 0 && manager.getState().status === 'running');
    assert.equal(manager.getState().connected, true);

    // Secrets never reach the config file, the settings file, or the activity log.
    const exposed = [yaml, fs.readFileSync(manager.configPath, 'utf8'), fs.readFileSync(manager.settingsPath, 'utf8'), JSON.stringify(manager.getState())].join('\n');
    assert.ok(!exposed.includes(TOKEN) && !exposed.includes('desktop-test-secret'), 'token or credential leaked');

    await manager.stop();
    assert.equal(manager.getState().status, 'stopped');
    assert.equal(manager.getState().connected, null);

    // Next launch: stored identity is reused, no token needed, no second enrollment.
    const again = new CollectorManager({ binaryPath: BINARY, dataDir });
    const before = seen.heartbeats;
    again.start();
    await until('heartbeat after restart', () => seen.heartbeats > before);
    await again.stop();
    assert.equal(seen.enrollments, 1);

    await again.resetIdentity();
    assert.equal(again.getState().enrolled, false);
  } finally {
    await manager.stop();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
