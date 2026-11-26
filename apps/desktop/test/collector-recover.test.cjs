'use strict';
// recover(): what the app does after the computer wakes up, and every few minutes for a Sensor that gave up.
// The Sensor process itself is stubbed: only the decision to (re)start is checked here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CollectorManager } = require('../src/collector-manager.cjs');

function manager({ enrolled = true, autoStart = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-recover-'));
  const m = new CollectorManager({ binaryPath: process.execPath, dataDir: dir });
  m.settings = { serverUrl: 'http://127.0.0.1:47100', allowedCidrs: [], autoStart };
  m.isEnrolled = () => enrolled;
  m.binaryAvailable = () => true;
  const calls = [];
  m.start = () => {
    calls.push('start');
    m.child = {};
    m.wanted = true;
    m.status = 'running';
    return m.getState();
  };
  m.stop = async () => {
    calls.push('stop');
    m.child = null;
    m.wanted = false;
    m.status = 'stopped';
    return m.getState();
  };
  return { m, calls };
}

test('a Sensor that gave up after crashes is started again, with a fresh restart budget', async () => {
  const { m, calls } = manager();
  Object.assign(m, { status: 'error', wanted: false, child: null, restarts: 5 });
  await m.recover();
  assert.deepEqual(calls, ['start']);
  assert.equal(m.restarts, 0);
});

test('one stopped on purpose stays stopped', async () => {
  const { m, calls } = manager();
  Object.assign(m, { status: 'stopped', wanted: false, child: null });
  await m.recover({ restartRunning: true });
  assert.deepEqual(calls, []);
});

test('a running Sensor is restarted after sleep, and left alone otherwise', async () => {
  const { m, calls } = manager();
  Object.assign(m, { status: 'running', wanted: true, child: {} });
  await m.recover();
  assert.deepEqual(calls, []);
  await m.recover({ restartRunning: true });
  assert.deepEqual(calls, ['stop', 'start']);
});

test('nothing happens when not enrolled or set not to start on its own', async () => {
  for (const opts of [{ enrolled: false }, { autoStart: false }]) {
    const { m, calls } = manager(opts);
    Object.assign(m, { status: 'error', wanted: false, child: null });
    await m.recover();
    assert.deepEqual(calls, [], JSON.stringify(opts));
  }
});
