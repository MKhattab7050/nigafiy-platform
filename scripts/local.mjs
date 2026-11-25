#!/usr/bin/env node
// Runs the whole of Nigafiy on this computer with one command:
//   pnpm local                     database + API + web (+ collector once it is enrolled)
//   pnpm local --token <token>     same, and enroll this computer as a collector (first time only)
//   pnpm local --prod              serve an optimized web build instead of the dev server
//   pnpm local --no-open           do not open the browser
// The Nigafiy Engine (engine/) runs each part as its own supervised child instead:
//   local.mjs --component=db|api|web --engine-status-file=<path>
// Each runs that one part only (never reusing one already running), writes its ready report to the
// status file and stops when its stdin closes. Its output goes to stdout (the engine keeps the log).
// First run (interactive): finds your home network, asks you to confirm it is yours, creates your
// account and sets this computer up as the collector — no tokens to copy.
// Ctrl+C stops everything it started. Services already running on their ports are reused, not restarted.
// Logs: .data/logs/<service>.log
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// Environment variables after the rename (docs/architecture/naming.md): NIGAFIY_* wins, the legacy
// LD_* / LAN_COLLECTOR_* name is still read and logs one deprecation line. This file is bundled on its
// own into the desktop app, so it carries its own copy of the table in apps/api/src/config/env-compat.ts.
const LEGACY_ENV = {
  NIGAFIY_DATA_DIR: 'LD_DATA_DIR',
  NIGAFIY_BUNDLE_DIR: 'LD_BUNDLE_DIR',
  NIGAFIY_SETUP_EMAIL: 'LD_SETUP_EMAIL',
  NIGAFIY_SETUP_PASSWORD: 'LD_SETUP_PASSWORD',
  NIGAFIY_SENSOR_ENROLLMENT_TOKEN: 'LAN_COLLECTOR_ENROLLMENT_TOKEN',
};
const warnedEnv = new Set();
function readEnv(name) {
  if (process.env[name]) return process.env[name];
  const legacy = LEGACY_ENV[name];
  const old = legacy ? process.env[legacy] : undefined;
  if (old && !warnedEnv.has(legacy)) {
    warnedEnv.add(legacy);
    console.warn(`[env] ${legacy} is deprecated, use ${name} (the old name still works)`);
  }
  return old || undefined;
}
// Installed desktop app: NIGAFIY_BUNDLE_DIR holds the packaged API and web server, NIGAFIY_DATA_DIR the user's data.
const bundleDir = readEnv('NIGAFIY_BUNDLE_DIR') ? path.resolve(readEnv('NIGAFIY_BUNDLE_DIR')) : null;
const dataDir = readEnv('NIGAFIY_DATA_DIR') ? path.resolve(readEnv('NIGAFIY_DATA_DIR')) : path.join(root, '.data');
const apiDir = bundleDir ? path.join(bundleDir, 'api') : path.join(root, 'apps/api');
const logDir = path.join(dataDir, 'logs');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const token = option('--token') ?? readEnv('NIGAFIY_SENSOR_ENROLLMENT_TOKEN');
const prod = flag('--prod');
const noCollector = flag('--no-collector');
const noOpen = flag('--no-open');
// Started by the desktop app (child_process.fork): report progress over IPC and stop when it goes away.
const desktop = typeof process.send === 'function';
const emit = (msg) => {
  if (desktop && process.connected) process.send(msg);
};
// Started by the Nigafiy Engine (engine/, no Node IPC): --engine-status-file=<path> receives
// { state: 'ready', webUrl, apiUrl, pid } or { state: 'error', message, pid }, written atomically
// (temporary file + rename). Closing stdin is the engine's request to stop.
const engineStatusFile = (() => {
  const a = args.find((x) => x.startsWith('--engine-status-file='));
  return a ? path.resolve(a.slice('--engine-status-file='.length)) : null;
})();
const component = (() => {
  const a = args.find((x) => x.startsWith('--component='));
  return a ? a.slice('--component='.length) : null;
})();
function writeEngineStatus(status) {
  if (!engineStatusFile) return;
  try {
    mkdirSync(path.dirname(engineStatusFile), { recursive: true });
    const tmp = `${engineStatusFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...status, ...(component ? { component } : {}), pid: process.pid }), { mode: 0o600 });
    renameSync(tmp, engineStatusFile);
  } catch {
    /* the engine then times out waiting and says so */
  }
}

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', off: '\x1b[0m' };
const say = (msg) => console.log(msg);
const ok = (msg) => (say(`${c.green}✔${c.off} ${msg}`), emit({ type: 'status', message: msg }));
const warn = (msg) => say(`${c.yellow}!${c.off} ${msg}`);
const fail = (msg) => {
  say(`${c.red}✘ ${msg}${c.off}`);
  emit({ type: 'error', message: msg });
  writeEngineStatus({ state: 'error', message: msg });
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── prerequisites ────────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number);
// The desktop app runs this with Electron's Node 22 (TypeScript stripping is on from 22.18).
if (bundleDir ? major < 22 || (major === 22 && minor < 18) : major < 24) {
  fail(`Node.js 24 or newer is required (this is ${process.version}).`);
  process.exit(1);
}
mkdirSync(logDir, { recursive: true });
if (component && (!['db', 'api', 'web'].includes(component) || !engineStatusFile)) {
  fail(`--component must be db, api or web, together with --engine-status-file (got ${component}).`);
  process.exit(2);
}

// Windows Startup folder auto-start installer / uninstaller
if (!component && win && (flag('--install-autostart') || flag('--uninstall-autostart'))) {
  const startupDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbsPath = path.join(startupDir, 'Nigafiy.vbs');
  // The launcher's name before the rename (docs/architecture/naming.md): replaced, never left running twice.
  const legacyVbsPath = path.join(startupDir, 'LAN Detective.vbs');
  if (existsSync(legacyVbsPath)) unlinkSync(legacyVbsPath);
  if (flag('--uninstall-autostart')) {
    if (existsSync(vbsPath)) unlinkSync(vbsPath);
    ok(`Removed Windows auto-start launcher (${vbsPath})`);
  } else {
    mkdirSync(startupDir, { recursive: true });
    const cmdLine = `"${process.execPath}" "${path.join(root, 'scripts', 'local.mjs')}" --no-open`;
    const vbs = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.CurrentDirectory = "${root.replaceAll('"', '""')}"`,
      `WshShell.Run "${cmdLine.replaceAll('"', '""')}", 0, False`,
      '',
    ].join('\r\n');
    writeFileSync(vbsPath, vbs, 'utf8');
    ok(`Installed Windows auto-start launcher (${vbsPath})`);
  }
  if (flag('--only-autostart')) process.exit(0);
}

if (!component && !bundleDir && (!existsSync(path.join(root, 'node_modules')) || !existsSync(path.join(root, 'apps/web/node_modules/next')))) {
  say('Installing dependencies (first run)…');
  const r = spawnSync('pnpm', ['install'], { cwd: root, stdio: 'inherit', shell: win });
  if (r.status !== 0) {
    fail('pnpm install failed. Install pnpm 10 (`npm i -g pnpm`) and try again.');
    process.exit(1);
  }
}

// ── .env: created once with fresh secrets ────────────────────────────────────
const envPath = bundleDir ? path.join(dataDir, '.env') : path.join(root, '.env');
if (!existsSync(envPath)) {
  let example = readFileSync(path.join(bundleDir ?? root, '.env.example'), 'utf8');
  if (bundleDir) {
    // Own ports, so the installed app never collides with a development copy; loopback only.
    example = example
      .replace(/^NODE_ENV=.*$/m, 'NODE_ENV=production')
      .replace(/^PORT=.*$/m, 'PORT=47100')
      .replaceAll('@localhost:5433/', '@localhost:47133/')
      .replace(/^WEB_ORIGIN=.*$/m, 'WEB_ORIGIN=http://127.0.0.1:47130')
      .replace(/^API_INTERNAL_URL=.*$/m, 'API_INTERNAL_URL=http://127.0.0.1:47100');
  }
  const env = example
    .replace(/^APP_ENCRYPTION_KEY=.*$/m, `APP_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`)
    .replace('change-me-app-password', crypto.randomBytes(18).toString('base64url'));
  writeFileSync(envPath, env, { mode: 0o600 });
  ok('Created .env with new secrets');
}
if (bundleDir) {
  // Phones (the Android agent refuses plain http) and agents on other computers need HTTPS on the
  // network: the installed app turns on the built-in LAN certificate on its own port. Added once to
  // older installs too; `HTTPS_PORT=` (empty) in the data folder's .env turns it off and stays off.
  const cur = readFileSync(envPath, 'utf8');
  if (!/^HTTPS_PORT=/m.test(cur)) {
    writeFileSync(envPath, `${cur.replace(/\s*$/, '\n')}\n# LAN HTTPS for phones and agents (built-in certificate). Empty HTTPS_PORT= turns it off.\nHTTPS_PORT=47143\nHTTPS_HOST=0.0.0.0\n`, { mode: 0o600 });
    ok('Turned on HTTPS for this network (port 47143)');
  }
}
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const apiPort = Number(env.PORT || 4100);
const dbPort = Number(new URL(env.DATABASE_URL).port || 5432);
const webUrl = env.WEB_ORIGIN || 'http://localhost:3100';
const webPort = Number(new URL(webUrl).port || 3100);
const apiUrl = bundleDir ? `http://127.0.0.1:${apiPort}` : `http://localhost:${apiPort}`;
const envArg = `--env-file-if-exists=${envPath}`;
// Everything this launcher starts listens on this computer only.
const LOOPBACK = '127.0.0.1';

// ── process management ───────────────────────────────────────────────────────
const started = []; // { name, child, graceful }
let shuttingDown = false;

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}
async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}
async function waitFor(label, check, child, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    if (child && child.exitCode !== null) return false;
    await sleep(700);
  }
  return false;
}

function start(name, command, commandArgs, opts = {}) {
  // Under the engine (--component) the engine owns the log file: rotated and redacted.
  const log = component ? { write: (chunk) => process.stdout.write(chunk), end: () => undefined } : createWriteStream(path.join(logDir, `${name}.log`), { flags: 'a' });
  log.write(`\n──── ${new Date().toISOString()} start ${name} ────\n`);
  const child = spawn(command, commandArgs, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe', ...(opts.ipc ? ['ipc'] : [])],
    windowsHide: true,
  });
  const onLine = opts.onLine ?? (() => undefined);
  let buf = '';
  const feed = (chunk) => {
    log.write(chunk);
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line);
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('exit', (code) => {
    log.end();
    if (!shuttingDown && opts.critical) {
      fail(`${name} stopped (exit code ${code}). See ${path.relative(root, path.join(logDir, `${name}.log`))}`);
      void shutdown(1);
    } else if (!shuttingDown && opts.onExit) opts.onExit(code);
  });
  started.push({ name, child, graceful: opts.ipc });
  return child;
}

function kill(entry) {
  const { child } = entry;
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    if (entry.graceful && child.connected) child.send('stop');
    else if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) {
        if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      }
      resolve();
    }, 15_000).unref();
  });
}
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (started.length) say(`\n${c.dim}Stopping ${started.map((s) => s.name).join(', ')}…${c.off}`);
  // Reverse order: collector and web first, database last.
  for (const entry of [...started].reverse()) await kill(entry);
  process.exit(code || process.exitCode || 0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
if (desktop) {
  process.on('disconnect', () => void shutdown());
  process.on('message', (m) => m === 'stop' && void shutdown());
}
if (engineStatusFile) {
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('error', () => void shutdown());
  process.stdin.resume();
}

// ── 1. database ──────────────────────────────────────────────────────────────
const pgDir = path.join(dataDir, 'pg');
const { default: pg } = await import(pathToFileURL(createRequire(path.join(apiDir, 'package.json')).resolve('pg')).href);
async function dbHealthy() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    client.end().catch(() => undefined);
  }
}
/** A PostgreSQL left behind by a hard kill (e.g. a closed terminal) can hold the port without answering. */
async function stopStaleDatabase() {
  const pidFile = path.join(pgDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, 'utf8').split(/\r?\n/)[0]);
  if (!pid) return false;
  warn(`The database left over from a previous run is not responding; restarting it.`);
  if (win) {
    // The postmaster may already be gone while one of its children still holds the inherited socket.
    spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object { $_.ProcessId -eq ${pid} -or $_.ParentProcessId -eq ${pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { stdio: 'ignore', windowsHide: true },
    );
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 20 && (await portOpen(dbPort)); i++) await sleep(500);
  return !(await portOpen(dbPort));
}

// Each part below is shared by `pnpm local` (all of them, reusing what already runs) and the
// engine's --component mode (one of them, never reusing: the engine supervises what it starts).
const notOurs = (what, where) => `${what} is already running at ${where}, started by something other than the Nigafiy Engine. Stop it (for example a \`pnpm local\` in a terminal) and the engine starts its own.`;

async function runDatabase(reuse) {
  const healthy = (await portOpen(dbPort)) && (await dbHealthy());
  if (healthy && reuse) {
    ok(`Database already running on port ${dbPort}`);
    return;
  }
  if (healthy) {
    fail(notOurs('A database', `port ${dbPort}`));
    process.exit(1);
  }
  if ((await portOpen(dbPort)) && !(await stopStaleDatabase())) {
    fail(`Port ${dbPort} is in use by a program that is not a working Nigafiy database. Stop it or change DATABASE_URL in .env.`);
    process.exit(1);
  }
  say(`${c.dim}Starting database…${c.off}`);
  const db = start('db', process.execPath, [envArg, 'scripts/dev-db.ts'], { cwd: apiDir, env: { NIGAFIY_PG_DIR: pgDir }, ipc: true, critical: true });
  if (!(await waitFor('database', () => dbHealthy(), db, 120_000))) {
    fail(`The database did not start. See ${component ? 'logs/db.log' : '.data/logs/db.log'}`);
    await shutdown(1);
  }
  ok(`Database ready on port ${dbPort} (data in ${path.relative(process.cwd(), pgDir) || pgDir})`);
}

// ── 2. API (runs migrations on start) ───────────────────────────────────────
async function runApi(reuse) {
  if (await httpOk(`${apiUrl}/readyz`)) {
    if (reuse) {
      ok(`API already running at ${apiUrl}`);
      return;
    }
    fail(notOurs('An API', apiUrl));
    process.exit(1);
  }
  if (await portOpen(apiPort)) {
    fail(`Port ${apiPort} is in use by another program. Stop it or change PORT in .env.`);
    await shutdown(1);
  }
  say(`${c.dim}Starting API…${c.off}`);
  const api = start('api', process.execPath, [envArg, 'src/main.ts'], {
    cwd: apiDir,
    // Built-in LAN TLS keeps its CA and server certificate in the data folder (used only when HTTPS_PORT is set in .env).
    env: { HOST: LOOPBACK, TLS_AUTO_DIR: path.join(dataDir, 'tls') },
    critical: true,
    onLine: (line) => {
      try {
        const j = JSON.parse(line);
        if (j.level >= 50) say(`${c.red}api  │ ${j.msg}${j.err?.message ? ` — ${j.err.message}` : ''}${c.off}`);
      } catch {
        /* not JSON */
      }
    },
  });
  if (!(await waitFor('api', () => httpOk(`${apiUrl}/readyz`), api, 120_000))) {
    fail(`The API did not become ready. See ${component ? 'logs/api.log' : '.data/logs/api.log'}`);
    await shutdown(1);
  }
  ok(`API ready at ${apiUrl}`);
}

// ── 3. web ───────────────────────────────────────────────────────────────────
const nextBin = path.join(root, 'apps/web/node_modules/next/dist/bin/next');
async function runWeb(reuse) {
  if (await httpOk(webUrl)) {
    if (reuse) {
      ok(`Web app already running at ${webUrl}`);
      return;
    }
    fail(notOurs('A web app', webUrl));
    process.exit(1);
  }
  if (await portOpen(webPort)) {
    fail(`Port ${webPort} is in use by another program. Stop it first.`);
    await shutdown(1);
  }
  const webEnv = { API_INTERNAL_URL: env.API_INTERNAL_URL || apiUrl, NEXT_TELEMETRY_DISABLED: '1' };
  if (bundleDir) {
    say(`${c.dim}Starting web app…${c.off}`);
    // Standalone Next.js server built by apps/desktop/scripts/bundle-backend.mjs.
    const web = start('web', process.execPath, [path.join(bundleDir, 'web', 'apps', 'web', 'server.js')], {
      cwd: path.join(bundleDir, 'web', 'apps', 'web'),
      env: { ...webEnv, NODE_ENV: 'production', PORT: String(webPort), HOSTNAME: LOOPBACK },
      critical: true,
    });
    if (!(await waitFor('web', () => httpOk(webUrl), web, 120_000))) {
      fail('The web app did not start. See logs/web.log');
      await shutdown(1);
    }
  } else {
    if (prod) {
      say(`${c.dim}Building the web app (about a minute)…${c.off}`);
      const b = spawnSync(process.execPath, [nextBin, 'build'], { cwd: path.join(root, 'apps/web'), env: { ...process.env, ...webEnv }, stdio: 'inherit' });
      if (b.status !== 0) {
        fail('Web build failed.');
        await shutdown(1);
      }
    } else say(`${c.dim}Starting web app…${c.off}`);
    const web = start('web', process.execPath, [nextBin, prod ? 'start' : 'dev', '-p', String(webPort), '-H', LOOPBACK], { cwd: path.join(root, 'apps/web'), env: webEnv, critical: true });
    if (!(await waitFor('web', () => httpOk(webUrl), web, 180_000))) {
      fail(`The web app did not start. See ${component ? 'logs/web.log' : '.data/logs/web.log'}`);
      await shutdown(1);
    }
  }
  ok(`Web app ready at ${webUrl}`);
}

if (component) {
  // ── engine component: one part, supervised by the Nigafiy Engine ─────────────
  say(`${c.bold}Nigafiy Engine component: ${component}${c.off}`);
  if (component === 'db') await runDatabase(false);
  else if (component === 'api') await runApi(false);
  else await runWeb(false);
  writeEngineStatus({ state: 'ready', port: dbPort, apiUrl, webUrl });
  // Runs until the engine closes stdin (graceful stop) or the part exits (the engine restarts it).
  await new Promise(() => undefined);
}

say(`${c.bold}Nigafiy — local${c.off}`);
await runDatabase(true);
await runApi(true);
await runWeb(true);

// ── 4. collector on this computer ───────────────────────────────────────────
const collectorDir = path.join(root, 'collectors/lan-collector');
const agentDir = path.join(root, 'agents/endpoint-agent');
const collectorData = path.join(dataDir, 'collector');
const stateDir = path.join(collectorData, 'state');
const credFile = path.join(stateDir, 'credential.json');
const engineDir = path.join(root, 'engine');
// The Sensor is the engine executable run as `nigafiy-engine sensor` (docs/architecture/engine-sensor.md).
const binary = path.join(engineDir, 'bin', win ? 'nigafiy-engine.exe' : 'nigafiy-engine');
const sensorSources = () => Math.max(newestSource(collectorDir), newestSource(engineDir));
const agentBinary = path.join(agentDir, 'bin', win ? 'nigafiy-agent.exe' : 'nigafiy-agent');

function findGo() {
  const candidates = ['go', ...(win ? ['C:\\Program Files\\Go\\bin\\go.exe'] : ['/usr/local/go/bin/go'])];
  return candidates.find((g) => spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0);
}
function newestSource(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'bin') newest = Math.max(newest, newestSource(p));
    else if (/\.(go|mod|sum)$/.test(entry.name)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}
function ensureAgentBinary() {
  if (!existsSync(agentDir)) return;
  const stale = !existsSync(agentBinary) || statSync(agentBinary).mtimeMs < newestSource(agentDir);
  if (!stale) return;
  const go = findGo();
  if (!go) return;
  mkdirSync(path.dirname(agentBinary), { recursive: true });
  say(`${c.dim}Building endpoint-agent…${c.off}`);
  const r = spawnSync(go, ['build', '-o', agentBinary, './cmd/nigafiy-agent'], { cwd: agentDir, stdio: 'inherit' });
  if (r.status === 0) ok('Updated nigafiy-agent binary');
}
function ensureBinary() {
  ensureAgentBinary();
  const stale = !existsSync(binary) || statSync(binary).mtimeMs < sensorSources();
  if (!stale) return true;
  const go = findGo();
  if (!go) {
    if (existsSync(binary)) {
      warn('Go is not installed; using the existing collector build (it may be out of date).');
      return true;
    }
    warn('The collector needs Go 1.24+ to build (https://go.dev/dl). Skipping the collector.');
    return false;
  }
  mkdirSync(path.dirname(binary), { recursive: true });
  say(`${c.dim}Building the collector…${c.off}`);
  const r = spawnSync(go, ['build', '-o', binary, './cmd/nigafiy-engine'], { cwd: engineDir, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } });
  if (r.status !== 0) {
    warn('Collector build failed (is nigafiy-engine running from engine/bin?); skipping the collector.');
    return false;
  }
  ok('Updated nigafiy-engine binary (engine and Sensor)');
  return true;
}

function showEnrollHelp() {
  say('');
  say(`${c.cyan}This computer is not a collector yet.${c.off} To scan your network from it:`);
  say(`  1. Open ${webUrl} and sign in (or create an account).`);
  say('  2. Go to Discovery & Collectors → authorize your network range (e.g. 192.168.1.0/24).');
  say('  3. Add a collector and copy the enrollment token.');
  say(`  4. Stop this (Ctrl+C) and run:  ${c.bold}pnpm local --token <token>${c.off}`);
  say(`     After that, plain ${c.bold}pnpm local${c.off} starts the collector every time.`);
}

// ── first-run home setup ─────────────────────────────────────────────────────
// Finds the network this computer is on, asks the person to confirm it is theirs, creates (or signs in
// to) their account, authorizes that one range and enrolls this computer as its collector.
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    const raw = hidden && stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          // Ctrl+C
          if (raw) stdin.setRawMode(false);
          void shutdown(130);
          return;
        }
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          if (raw) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            if (raw) process.stdout.write('\b \b');
          }
        } else {
          value += ch;
          if (raw) process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** The IPv4 network of the interface that carries this computer's default route. */
async function homeNetwork() {
  const address = await new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => (s.close(), resolve(null)));
    // connect() on UDP only picks a route; no packet is sent.
    s.connect(53, '1.1.1.1', () => {
      const a = s.address().address;
      s.close();
      resolve(a);
    });
  });
  if (!address) return null;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    const hit = addrs?.find((a) => a.family === 'IPv4' && a.address === address);
    if (!hit) continue;
    let prefix = Number(hit.cidr?.split('/')[1] ?? 24);
    if (prefix < 20) prefix = 24; // Nigafiy scans at most a /20; a home LAN is almost always a /24
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { iface: name, address, cidr: `${intToIp(ipToInt(address) & mask)}/${prefix}`, private: isPrivate(address) };
  }
  return null;
}

/**
 * Self-healing reconciliation: if an organization and site already exist in the local database,
 * ensures this computer's local collector is active with a valid credential in .data/collector/state/credential.json
 * and that the local private LAN CIDR is authorized for scanning.
 */
async function reconcileLocalCollector() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await client.connect();
    const siteRes = await client.query(
      `SELECT s.id AS site_id, s.organization_id, u.id AS user_id
         FROM sites s
         JOIN organizations o ON o.id = s.organization_id
         LEFT JOIN memberships m ON m.organization_id = o.id AND m.status = 'active'
         LEFT JOIN users u ON u.id = m.user_id
        WHERE o.name NOT LIKE 'SIMULATED%'
        ORDER BY o.created_at ASC, s.created_at ASC
        LIMIT 1`,
    );
    const primary = siteRes.rows[0];
    if (!primary) return false;

    const net0 = await homeNetwork();
    if (net0 && net0.private) {
      await client.query(
        `INSERT INTO network_scopes (organization_id, site_id, cidr, label, enabled, authorized_by)
         VALUES ($1, $2, $3::cidr, 'Home network', true, $4)
         ON CONFLICT (site_id, cidr) DO UPDATE SET enabled = true`,
        [primary.organization_id, primary.site_id, net0.cidr, primary.user_id ?? null],
      );
    }

    mkdirSync(stateDir, { recursive: true });
    const collectorName = `${os.hostname()} (this computer)`;
    let validCollectorId = null;

    if (existsSync(credFile)) {
      try {
        const parsed = JSON.parse(readFileSync(credFile, 'utf8'));
        const m = /^ldc_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(parsed.credential || '');
        if (m && m[1] === parsed.collector_id) {
          const hash = crypto.createHash('sha256').update(m[2]).digest('hex');
          const row = await client.query(
            `SELECT id FROM collectors WHERE id = $1 AND organization_id = $2 AND status = 'active' AND credential_hash = $3`,
            [parsed.collector_id, primary.organization_id, hash],
          );
          if (row.rows[0]) validCollectorId = row.rows[0].id;
        }
      } catch {
        /* corrupt credential.json — will regenerate below */
      }
    }

    if (!validCollectorId) {
      const secret = crypto.randomBytes(32).toString('base64url');
      const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
      const existing = await client.query(
        `SELECT id FROM collectors WHERE organization_id = $1 AND site_id = $2 AND name = $3 ORDER BY created_at ASC LIMIT 1`,
        [primary.organization_id, primary.site_id, collectorName],
      );
      if (existing.rows[0]) {
        validCollectorId = existing.rows[0].id;
        await client.query(
          `UPDATE collectors
              SET status = 'active', credential_hash = $2, enrollment_token_hash = NULL, enrollment_expires_at = NULL,
                  hostname = $3, os = $4, arch = $5
            WHERE id = $1`,
          [validCollectorId, secretHash, os.hostname(), process.platform === 'win32' ? 'windows' : process.platform, process.arch === 'x64' ? 'amd64' : process.arch],
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO collectors (organization_id, site_id, name, status, credential_hash, hostname, os, arch)
           VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)
           RETURNING id`,
          [primary.organization_id, primary.site_id, collectorName, secretHash, os.hostname(), process.platform === 'win32' ? 'windows' : process.platform, process.arch === 'x64' ? 'amd64' : process.arch],
        );
        validCollectorId = inserted.rows[0].id;
      }
      writeFileSync(
        credFile,
        JSON.stringify({ collector_id: validCollectorId, credential: `ldc_${validCollectorId}.${secret}` }),
        { mode: 0o600 },
      );
      ok(`Auto-enrolled local collector (${collectorName})`);
    }

    return true;
  } catch {
    return existsSync(credFile);
  } finally {
    client.end().catch(() => undefined);
  }
}

async function homeSetup() {
  const net0 = await homeNetwork();
  say('');
  say(`${c.bold}${c.cyan}First-time setup / الإعداد لأول مرة${c.off}`);
  if (!net0) {
    warn('Could not find the network this computer is connected to. Connect to your home network and run again.');
    return null;
  }
  if (!net0.private) {
    warn(`This computer's address ${net0.address} is not a private home-network address; automatic setup is skipped.`);
    return null;
  }
  say(`This computer is on ${c.bold}${net0.cidr}${c.off} (${net0.iface}, address ${net0.address}).`);
  say('Nigafiy will discover and monitor the devices on this network from this computer.');
  say(`${c.yellow}Only continue if this is your own network or you are allowed to scan it.${c.off}`);
  say(`${c.dim}تابع فقط إذا كانت هذه شبكتك أو مسموح لك بفحصها.${c.off}`);
  const preset = readEnv('NIGAFIY_SETUP_EMAIL') && readEnv('NIGAFIY_SETUP_PASSWORD');
  const yes = preset && flag('--yes') ? 'y' : await ask(`Scan ${net0.cidr}? [y/N] `);
  if (!/^(y|yes|نعم|ا?ي[وة]ه?)$/i.test(yes)) {
    say('Setup skipped. You can still use the web app; run `pnpm local` again to set up scanning.');
    return null;
  }

  let cookie = '';
  const api = async (method, url, body) => {
    const res = await fetch(`${apiUrl}/api/v1${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-LD-CSRF': '1', Origin: webUrl, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.().find((x) => x.startsWith('ld_session='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  };

  say('');
  say('Your Nigafiy account (stored only on this computer):');
  let email = readEnv('NIGAFIY_SETUP_EMAIL');
  let password = readEnv('NIGAFIY_SETUP_PASSWORD');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!preset) {
      email = await ask('  Email: ');
      password = await ask('  Password (10+ characters, or your existing one): ', { hidden: true });
    }
    const login = await api('POST', '/auth/login', { email, password });
    if (login.status === 200) {
      ok(`Signed in as ${email}`);
      break;
    }
    const name = email.split('@')[0] || 'Me';
    const reg = await api('POST', '/auth/register', { email, password, display_name: name, organization_name: 'My home', site_name: 'Home' });
    if (reg.status === 201 || reg.status === 200) {
      ok(`Created account ${email}`);
      break;
    }
    const msg = reg.json?.error?.code === 'email_in_use' ? 'That email already has an account and the password is wrong.' : reg.json?.error?.message ?? `HTTP ${reg.status}`;
    warn(msg);
    cookie = '';
    if (preset) return null;
  }
  if (!cookie) {
    warn('Could not sign in. Open the web app to create an account, then run `pnpm local` again.');
    return null;
  }

  const sites = await api('GET', '/sites');
  const site = sites.json?.items?.[0];
  if (!site) {
    warn('No site found in this account.');
    return null;
  }
  const scope = await api('POST', `/sites/${site.id}/scopes`, { cidr: net0.cidr, label: 'Home network', authorization_confirmed: true });
  if (scope.status >= 300 && scope.status !== 409) {
    warn(`Could not authorize ${net0.cidr}: ${scope.json?.error?.message ?? scope.status}`);
    return null;
  }
  ok(`Authorized ${net0.cidr} for scanning`);
  const created = await api('POST', '/collectors', { site_id: site.id, name: `${os.hostname()} (this computer)` });
  if (!created.json?.enrollment_token) {
    warn(`Could not create a collector: ${created.json?.error?.message ?? created.status}`);
    return null;
  }
  return created.json.enrollment_token;
}

let enrolled = await reconcileLocalCollector();
let enrollToken = token;
if (!noCollector && !enrolled && !enrollToken) {
  if (process.stdin.isTTY || (readEnv('NIGAFIY_SETUP_EMAIL') && readEnv('NIGAFIY_SETUP_PASSWORD'))) enrollToken = await homeSetup();
  if (!enrollToken) showEnrollHelp();
}

let collectorEntry = null;
let collectorRestarting = false;
let collectorRestarts = 0;
const MAX_COLLECTOR_RESTARTS = 5;

async function launchCollector(initial = false) {
  if (shuttingDown || noCollector) return;
  enrolled = (await reconcileLocalCollector()) || existsSync(credFile);
  if (!enrolled && !enrollToken) return;
  if (!ensureBinary()) return;

  mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(collectorData, 'collector.yaml');
  writeFileSync(
    configPath,
    [
      '# Written by scripts/local.mjs for running the collector on this computer.',
      `server_url: ${apiUrl}`,
      `state_dir: ${JSON.stringify(stateDir)}`,
      'allow_insecure_http: true # local API only',
      `allow_loopback_scopes: ${env.ALLOW_LOOPBACK_SCOPES === 'true'}`,
      'log_level: info',
      '',
    ].join('\n'),
  );
  const quiet = new Set(['heartbeat', 'telemetry uploaded']);
  const startedAt = Date.now();
  const child = start('collector', binary, ['sensor', '-config', configPath], {
    env: enrollToken && !enrolled ? { NIGAFIY_SENSOR_ENROLLMENT_TOKEN: enrollToken } : {},
    onLine: (line) => {
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (quiet.has(j.msg) || j.msg.startsWith('development switches')) return;
      const color = j.level === 'ERROR' ? c.red : j.level === 'WARN' ? c.yellow : c.dim;
      const extra = j.cidr ? ` ${j.cidr} found=${j.found}/${j.probed}` : j.hostname ? ` ${j.hostname} (${j.mac})` : j.error ? ` — ${j.error}` : '';
      say(`${color}collector │ ${j.msg}${extra}${c.off}`);
    },
    onExit: (code) => {
      if (shuttingDown || collectorRestarting) return;
      if (Date.now() - startedAt > 60_000) collectorRestarts = 0;
      if (collectorRestarts >= MAX_COLLECTOR_RESTARTS) {
        warn(`Collector exited (code ${code}) ${collectorRestarts} times; giving up auto-restart. Check .data/logs/collector.log.`);
        return;
      }
      collectorRestarts += 1;
      const delayMs = Math.min(60_000, 3000 * 2 ** (collectorRestarts - 1));
      warn(`Collector exited (code ${code}); auto-restarting in ${Math.round(delayMs / 1000)}s (attempt ${collectorRestarts}/${MAX_COLLECTOR_RESTARTS})…`);
      setTimeout(() => void launchCollector(false), delayMs).unref();
    },
  });
  collectorEntry = started.find((s) => s.child === child) ?? null;
  if (initial) ok(enrolled ? 'Collector started on this computer (auto-restart & auto-update active)' : 'Collector enrolling with your token…');
  else ok('Collector restarted');
}

if (noCollector) say(`${c.dim}Collector skipped (--no-collector).${c.off}`);
else await launchCollector(true);

// Watch Go sources in the background: if collector or agent code changes, rebuild automatically and hot-restart the collector.
if (!noCollector && !bundleDir) {
  setInterval(async () => {
    if (shuttingDown || collectorRestarting) return;
    ensureAgentBinary();
    const collectorStale = existsSync(binary) && statSync(binary).mtimeMs < sensorSources();
    if (!collectorStale) return;
    collectorRestarting = true;
    try {
      say(`${c.cyan}Detected collector source changes — rebuilding and restarting collector…${c.off}`);
      if (collectorEntry) {
        await kill(collectorEntry);
        const idx = started.indexOf(collectorEntry);
        if (idx >= 0) started.splice(idx, 1);
        collectorEntry = null;
      }
      collectorRestarts = 0;
      await launchCollector(false);
    } finally {
      collectorRestarting = false;
    }
  }, 5000).unref();
}

say('');
say(`${c.bold}${c.green}Open ${webUrl}${c.off}   ${c.dim}(Ctrl+C to stop everything · logs in ${path.relative(process.cwd(), logDir) || logDir})${c.off}`);
emit({ type: 'ready', webUrl, apiUrl });
writeEngineStatus({ state: 'ready', webUrl, apiUrl });
if (!noOpen && !desktop && /^https?:\/\/[^\s"&|<>^`$;]+$/.test(webUrl)) {
  const opener = win ? ['cmd', ['/c', 'start', '""', webUrl]] : process.platform === 'darwin' ? ['open', [webUrl]] : ['xdg-open', [webUrl]];
  try {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => undefined).unref();
  } catch {
    /* no browser available */
  }
}
