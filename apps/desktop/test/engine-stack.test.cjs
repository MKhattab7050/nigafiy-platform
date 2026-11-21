'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EngineStack } = require('../src/engine-stack.cjs');

/** A stand-in for nigafiy-engine's control API. `state` is mutated by the tests. */
async function fakeEngine(state) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    if (req.method === 'GET' && req.url === '/v1/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state.status));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/shutdown') {
      if (req.headers.authorization !== `Bearer ${state.token}`) {
        res.statusCode = 401;
        res.end();
        return;
      }
      res.end('{}');
      state.onShutdown?.();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = 99999999;
  child.stderr = new EventEmitter();
  child.exit = (code = 0) => {
    child.exitCode = code;
    child.emit('exit', code);
  };
  return child;
}

const ready = (mode = 'foreground') => ({
  version: '0.1.0',
  mode,
  started_at: new Date().toISOString(),
  children: [{ name: 'stack', state: 'running', pid: 1, restarts: 0, last_error: null, started_at: null }],
  stack: { web_url: 'http://127.0.0.1:47130', api_url: 'http://127.0.0.1:47100' },
});

test('uses an engine that is already running (the service) and leaves it running on stop', async () => {
  const state = { status: ready('service'), token: 'x' };
  const engine = await fakeEngine(state);
  let spawned = 0;
  try {
    const stack = new EngineStack({
      engineExe: 'nigafiy-engine.exe',
      dataDir: os.tmpdir(),
      nodePath: 'node',
      script: 'local.mjs',
      controlUrl: engine.url,
      spawnImpl: () => {
        spawned++;
        return fakeChild();
      },
    });
    assert.deepEqual(await stack.start(), { webUrl: 'http://127.0.0.1:47130', apiUrl: 'http://127.0.0.1:47100' });
    assert.equal(spawned, 0);
    await stack.stop();
    assert.equal(engine.calls.filter((c) => c.url === '/v1/shutdown').length, 0, 'a service is never shut down by the app');
  } finally {
    await engine.close();
  }
});

test('starts a child engine when none answers, waits for the stack, and shuts it down with the token', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-stack-'));
  fs.mkdirSync(path.join(dataDir, 'engine'));
  fs.writeFileSync(path.join(dataDir, 'engine', 'control-token'), 'secret-token\n');
  const state = { status: null, token: 'secret-token' };
  const engine = await fakeEngine(state);
  // Nothing answers until the child "starts": simulate with a status endpoint that 404s first.
  const realStatus = { ...ready(), children: [{ name: 'stack', state: 'starting', pid: 1, restarts: 0, last_error: null, started_at: null }], stack: null };
  let child;
  let spawnArgs;
  let polls = 0;
  try {
    const stack = new EngineStack({
      engineExe: 'C:/engine/nigafiy-engine.exe',
      dataDir,
      nodePath: 'C:/node.exe',
      script: 'C:/repo/scripts/local.mjs',
      controlUrl: engine.url,
      pollMs: 10,
      fetchImpl: async (url, init) => {
        if (url.endsWith('/v1/status') && !child) throw new Error('ECONNREFUSED');
        if (url.endsWith('/v1/status') && ++polls === 3) state.status = ready();
        return fetch(url, init);
      },
      spawnImpl: (exe, args) => {
        spawnArgs = { exe, args };
        child = fakeChild();
        state.status = realStatus;
        state.onShutdown = () => setTimeout(() => child.exit(0), 5);
        return child;
      },
    });
    const urls = await stack.start();
    assert.equal(urls.webUrl, 'http://127.0.0.1:47130');
    assert.equal(spawnArgs.exe, 'C:/engine/nigafiy-engine.exe');
    assert.deepEqual(spawnArgs.args.slice(0, 5), ['run', `--data-dir=${dataDir}`, '--node=C:/node.exe', '--stack-script=C:/repo/scripts/local.mjs', '--no-sensor']);
    await stack.stop();
    const shutdown = engine.calls.find((c) => c.url === '/v1/shutdown');
    assert.equal(shutdown?.auth, 'Bearer secret-token');
    assert.equal(child.exitCode, 0);
  } finally {
    await engine.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reports the stack failure the engine gives up on', async () => {
  const state = {
    status: { ...ready(), stack: null, children: [{ name: 'stack', state: 'failed', pid: null, restarts: 5, last_error: 'database port 5433 in use', started_at: null }] },
    token: 'x',
  };
  const engine = await fakeEngine(state);
  try {
    const stack = new EngineStack({ engineExe: 'e', dataDir: os.tmpdir(), nodePath: 'n', script: 's', controlUrl: engine.url, pollMs: 10 });
    await assert.rejects(stack.start(), /database port 5433 in use/);
  } finally {
    await engine.close();
  }
});

test('reports a child engine that exits while starting', async () => {
  let child;
  const stack = new EngineStack({
    engineExe: 'e',
    dataDir: os.tmpdir(),
    nodePath: 'n',
    script: 's',
    controlUrl: 'http://127.0.0.1:47198',
    pollMs: 10,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    spawnImpl: () => {
      child = fakeChild();
      setTimeout(() => {
        child.stderr.emit('data', 'another engine is already running\n');
        child.exit(3);
      }, 20);
      return child;
    },
  });
  await assert.rejects(stack.start(), /exit code 3[\s\S]*another engine is already running/);
});
