#!/usr/bin/env node
// A throw-away Nigafiy stack for the emulator and WebRTC real runs (docs/features/android.md §11,
// docs/features/webrtc-networking.md): a fresh PostgreSQL, the real API and, with --web, the web dev
// server. Everything listens on 127.0.0.1 only; nothing here touches a LAN address.
//   node scripts/android-emu/stack.mjs [--web] [--pg 5426] [--api 3271] [--web-port 3272] [--stop-file <path>]
// Extra API settings come from the environment (for example RD_WEBRTC=off).
// The database and the APK file store live in a temporary folder removed on exit. Stop with Ctrl+C
// or by closing stdin.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const PG = opt('--pg', 5426);
const API = opt('--api', 3271);
const WEB = opt('--web-port', 3272);
const withWeb = args.includes('--web');
const DB = 'nigafiy_emu';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nigafiy-emu-stack-'));
const { startThrowawayPostgres } = await import(pathToFileURL(path.join(root, 'apps', 'api', 'tests', 'pg-server.ts')).href);
const pg = await startThrowawayPostgres({ dir: path.join(tmp, 'pg'), port: PG, database: DB });
console.log(`[stack] PostgreSQL on 127.0.0.1:${PG}`);

const children = [];
function start(name, cmd, cmdArgs, cwd, env) {
  const child = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  const prefix = (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `[${name}] `));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => console.log(`[stack] ${name} exited (${code})`));
  children.push(child);
  return child;
}

const apiEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  PORT: String(API),
  HOST: '127.0.0.1',
  DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG}/${DB}`,
  APP_DATABASE_URL: `postgres://lan_app:emu-app-password@127.0.0.1:${PG}/${DB}`,
  // A fixed key for this throw-away database only.
  APP_ENCRYPTION_KEY: 'e3'.repeat(32),
  WEB_ORIGIN: `http://127.0.0.1:${WEB}`,
  ALLOW_REGISTRATION: 'true',
  ALLOW_LOOPBACK_SCOPES: 'false',
  ENGINE_CONTROL_URL: 'off',
  LAN_TLS: 'off',
  NIGAFIY_DATA_DIR: path.join(tmp, 'data'),
  NIGAFIY_ANDROID_APK: process.env.NIGAFIY_ANDROID_APK ?? path.join(root, 'agents', 'android-agent', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
};
let api = start('api', process.execPath, ['src/main.ts'], path.join(root, 'apps', 'api'), apiEnv);

for (let i = 0; i < 240; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${API}/healthz`)).ok) break;
  } catch {
    // not yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`[stack] API on http://127.0.0.1:${API}`);

if (withWeb) {
  const next = path.join(root, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  start('web', process.execPath, [next, 'dev', '-p', String(WEB), '-H', '127.0.0.1'], path.join(root, 'apps', 'web'), {
    NEXT_DIST_DIR: '.next-e2e',
    API_INTERNAL_URL: `http://127.0.0.1:${API}`,
    NEXT_TELEMETRY_DISABLED: '1',
  });
  console.log(`[stack] web on http://127.0.0.1:${WEB} (dev server, first page compiles slowly)`);
}
console.log('[stack] ready');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  await new Promise((r) => setTimeout(r, 1500));
  await pg.stop().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// --stop-file <path>: stop when that file appears (for runs in the background without a console).
const stopFileAt = args.indexOf('--stop-file');
if (stopFileAt >= 0) {
  const file = args[stopFileAt + 1];
  setInterval(() => {
    if (existsSync(file)) stop();
    // <stop-file>.api: restart the API only (after a code change); the database stays.
    if (existsSync(`${file}.api`) && !stopping) {
      rmSync(`${file}.api`, { force: true });
      console.log('[stack] restarting the API');
      const old = api;
      old.once('exit', () => {
        api = start('api', process.execPath, ['src/main.ts'], path.join(root, 'apps', 'api'), apiEnv);
      });
      old.kill();
    }
  }, 1000);
} else {
  process.stdin.on('end', stop);
  process.stdin.resume();
}
