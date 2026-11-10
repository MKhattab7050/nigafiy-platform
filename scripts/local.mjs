#!/usr/bin/env node
// Runs the whole of LAN Detective on this computer with one command:
//   pnpm local                     database + API + web (+ collector once it is enrolled)
//   pnpm local --token <token>     same, and enroll this computer as a collector (first time only)
//   pnpm local --prod              serve an optimized web build instead of the dev server
//   pnpm local --no-open           do not open the browser
// First run (interactive): finds your home network, asks you to confirm it is yours, creates your
// account and sets this computer up as the collector — no tokens to copy.
// Ctrl+C stops everything it started. Services already running on their ports are reused, not restarted.
// Logs: .data/logs/<service>.log
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// Installed desktop app: LD_BUNDLE_DIR holds the packaged API and web server, LD_DATA_DIR the user's data.
const bundleDir = process.env.LD_BUNDLE_DIR ? path.resolve(process.env.LD_BUNDLE_DIR) : null;
const dataDir = process.env.LD_DATA_DIR ? path.resolve(process.env.LD_DATA_DIR) : path.join(root, '.data');
const apiDir = bundleDir ? path.join(bundleDir, 'api') : path.join(root, 'apps/api');
const logDir = path.join(dataDir, 'logs');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const token = option('--token') ?? process.env.LAN_COLLECTOR_ENROLLMENT_TOKEN;
const prod = flag('--prod');
const noCollector = flag('--no-collector');
const noOpen = flag('--no-open');
// Started by the desktop app (child_process.fork): report progress over IPC and stop when it goes away.
const desktop = typeof process.send === 'function';
const emit = (msg) => {
  if (desktop && process.connected) process.send(msg);
};

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', off: '\x1b[0m' };
const say = (msg) => console.log(msg);
const ok = (msg) => (say(`${c.green}✔${c.off} ${msg}`), emit({ type: 'status', message: msg }));
const warn = (msg) => say(`${c.yellow}!${c.off} ${msg}`);
const fail = (msg) => {
  say(`${c.red}✘ ${msg}${c.off}`);
  emit({ type: 'error', message: msg });
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

if (!bundleDir && (!existsSync(path.join(root, 'node_modules')) || !existsSync(path.join(root, 'apps/web/node_modules/next')))) {
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
  const log = createWriteStream(path.join(logDir, `${name}.log`), { flags: 'a' });
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

say(`${c.bold}LAN Detective — local${c.off}`);
let dbUp = (await portOpen(dbPort)) && (await dbHealthy());
if (!dbUp && (await portOpen(dbPort)) && !(await stopStaleDatabase())) {
  fail(`Port ${dbPort} is in use by a program that is not a working LAN Detective database. Stop it or change DATABASE_URL in .env.`);
  process.exit(1);
}
if (dbUp) ok(`Database already running on port ${dbPort}`);
else {
  say(`${c.dim}Starting database…${c.off}`);
  const db = start('db', process.execPath, [envArg, 'scripts/dev-db.ts'], { cwd: apiDir, env: { LD_PG_DIR: pgDir }, ipc: true, critical: true });
  if (!(await waitFor('database', () => dbHealthy(), db, 120_000))) {
    fail(`The database did not start. See .data/logs/db.log`);
    await shutdown(1);
  }
  ok(`Database ready on port ${dbPort} (data in ${path.relative(process.cwd(), pgDir) || pgDir})`);
}

// ── 2. API (runs migrations on start) ───────────────────────────────────────
if (await httpOk(`${apiUrl}/readyz`)) ok(`API already running at ${apiUrl}`);
else if (await portOpen(apiPort)) {
  fail(`Port ${apiPort} is in use by another program. Stop it or change PORT in .env.`);
  await shutdown(1);
} else {
  say(`${c.dim}Starting API…${c.off}`);
  const api = start('api', process.execPath, [envArg, 'src/main.ts'], {
    cwd: apiDir,
    env: { HOST: LOOPBACK },
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
    fail('The API did not become ready. See .data/logs/api.log');
    await shutdown(1);
  }
  ok(`API ready at ${apiUrl}`);
}

// ── 3. web ───────────────────────────────────────────────────────────────────
const nextBin = path.join(root, 'apps/web/node_modules/next/dist/bin/next');
if (await httpOk(webUrl)) ok(`Web app already running at ${webUrl}`);
else if (await portOpen(webPort)) {
  fail(`Port ${webPort} is in use by another program. Stop it first.`);
  await shutdown(1);
} else {
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
  } else if (prod) {
    say(`${c.dim}Building the web app (about a minute)…${c.off}`);
    const b = spawnSync(process.execPath, [nextBin, 'build'], { cwd: path.join(root, 'apps/web'), env: { ...process.env, ...webEnv }, stdio: 'inherit' });
    if (b.status !== 0) {
      fail('Web build failed.');
      await shutdown(1);
    }
  } else say(`${c.dim}Starting web app…${c.off}`);
  if (!bundleDir) {
    const web = start('web', process.execPath, [nextBin, prod ? 'start' : 'dev', '-p', String(webPort), '-H', LOOPBACK], { cwd: path.join(root, 'apps/web'), env: webEnv, critical: true });
    if (!(await waitFor('web', () => httpOk(webUrl), web, 180_000))) {
      fail('The web app did not start. See .data/logs/web.log');
      await shutdown(1);
    }
  }
  ok(`Web app ready at ${webUrl}`);
}

// ── 4. collector on this computer ───────────────────────────────────────────
const collectorDir = path.join(root, 'collectors/lan-collector');
const collectorData = path.join(dataDir, 'collector');
const stateDir = path.join(collectorData, 'state');
const enrolled = existsSync(path.join(stateDir, 'credential.json'));
const binary = path.join(collectorDir, 'bin', win ? 'lan-collector.exe' : 'lan-collector');

function findGo() {
  const candidates = ['go', ...(win ? ['C:\\Program Files\\Go\\bin\\go.exe'] : ['/usr/local/go/bin/go'])];
  return candidates.find((g) => spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0);
}
function newestSource(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'bin') newest = Math.max(newest, newestSource(p));
    else if (/\.(go|mod|sum)$/.test(entry.name)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}
function ensureBinary() {
  const stale = !existsSync(binary) || statSync(binary).mtimeMs < newestSource(collectorDir);
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
  say(`${c.dim}Building the collector…${c.off}`);
  const r = spawnSync(go, ['build', '-o', binary, './cmd/lan-collector'], { cwd: collectorDir, stdio: 'inherit' });
  if (r.status !== 0) {
    warn('Collector build failed; skipping the collector.');
    return false;
  }
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
    if (prefix < 20) prefix = 24; // LAN Detective scans at most a /20; a home LAN is almost always a /24
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { iface: name, address, cidr: `${intToIp(ipToInt(address) & mask)}/${prefix}`, private: isPrivate(address) };
  }
  return null;
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
  say('LAN Detective will discover and monitor the devices on this network from this computer.');
  say(`${c.yellow}Only continue if this is your own network or you are allowed to scan it.${c.off}`);
  say(`${c.dim}تابع فقط إذا كانت هذه شبكتك أو مسموح لك بفحصها.${c.off}`);
  const preset = process.env.LD_SETUP_EMAIL && process.env.LD_SETUP_PASSWORD;
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
  say('Your LAN Detective account (stored only on this computer):');
  let email = process.env.LD_SETUP_EMAIL;
  let password = process.env.LD_SETUP_PASSWORD;
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

let enrollToken = token;
if (!noCollector && !enrolled && !enrollToken) {
  if (process.stdin.isTTY || (process.env.LD_SETUP_EMAIL && process.env.LD_SETUP_PASSWORD)) enrollToken = await homeSetup();
  if (!enrollToken) showEnrollHelp();
}

if (noCollector) say(`${c.dim}Collector skipped (--no-collector).${c.off}`);
else if (!enrolled && !enrollToken) {
  /* help already shown */
} else if (ensureBinary()) {
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
  start('collector', binary, ['-config', configPath], {
    env: enrollToken && !enrolled ? { LAN_COLLECTOR_ENROLLMENT_TOKEN: enrollToken } : {},
    onLine: (line) => {
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      // The "development switches" warning is about plain-HTTP to the API, which is expected here (localhost only).
      if (quiet.has(j.msg) || j.msg.startsWith('development switches')) return;
      const color = j.level === 'ERROR' ? c.red : j.level === 'WARN' ? c.yellow : c.dim;
      const extra = j.cidr ? ` ${j.cidr} found=${j.found}/${j.probed}` : j.hostname ? ` ${j.hostname} (${j.mac})` : j.error ? ` — ${j.error}` : '';
      say(`${color}collector │ ${j.msg}${extra}${c.off}`);
    },
    onExit: (code) => {
      warn(`Collector stopped (exit code ${code}). The rest keeps running. See .data/logs/collector.log`);
      if (!existsSync(path.join(stateDir, 'credential.json'))) say('  If the token was refused, create a new one in the web app and run: pnpm local --token <token>');
    },
  });
  ok(enrolled ? 'Collector started on this computer' : 'Collector enrolling with your token…');
}

say('');
say(`${c.bold}${c.green}Open ${webUrl}${c.off}   ${c.dim}(Ctrl+C to stop everything · logs in ${path.relative(process.cwd(), logDir) || logDir})${c.off}`);
emit({ type: 'ready', webUrl, apiUrl });
if (!noOpen && !desktop) {
  const opener = win ? ['cmd', ['/c', 'start', '""', webUrl]] : process.platform === 'darwin' ? ['open', [webUrl]] : ['xdg-open', [webUrl]];
  try {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => undefined).unref();
  } catch {
    /* no browser available */
  }
}
