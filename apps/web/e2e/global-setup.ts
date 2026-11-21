import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * Starts a throw-away PostgreSQL and the real API for the browser smoke tests, and stops both
 * afterwards. Nothing is mocked: the browser talks to the production web build, which proxies
 * /api to this API, which runs every migration against this database.
 */
const apiDir = path.resolve(__dirname, '../../api');
// embedded-postgres is an API dependency; resolve it from there.
const EmbeddedPostgres = createRequire(path.join(apiDir, 'package.json'))('embedded-postgres').default;

const PG_PORT = Number(process.env.E2E_PG_PORT ?? 5446);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4146);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3146);
const DB = 'nigafiy_e2e';

async function waitFor(url: string, api: ChildProcess, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (api.exitCode !== null) throw new Error(`API exited early with code ${api.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nigafiy-e2e-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB);

  let apiLog = '';
  const api = spawn(process.execPath, ['src/main.ts'], {
    cwd: apiDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${DB}`,
      APP_DATABASE_URL: `postgres://lan_app:e2e-app-password@127.0.0.1:${PG_PORT}/${DB}`,
      // A fixed test-only key for this throw-away database.
      APP_ENCRYPTION_KEY: 'e2'.repeat(32),
      WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
      ALLOW_REGISTRATION: 'true',
      ALLOW_LOOPBACK_SCOPES: 'false',
      // No engine for this throw-away stack (a real one may be running on this computer).
      ENGINE_CONTROL_URL: 'off',
      // Nigafiy Mind is left out of this install, so the browser tests check the real "not installed"
      // path (install notes, switcher, Hub programs page) against the API's own answer.
      NIGAFIY_PROGRAMS: process.env.E2E_NIGAFIY_PROGRAMS ?? 'hub,radar,watch,guard,fleet,toolbox',
    },
  });
  api.stdout?.on('data', (d) => (apiLog += d));
  api.stderr?.on('data', (d) => (apiLog += d));

  const stop = async () => {
    if (api.exitCode === null) {
      api.kill();
      await new Promise((r) => api.once('exit', r));
    }
    await pg.stop().catch(() => undefined);
    // Windows can hold the data directory for a moment after shutdown; cleanup is best effort.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  };

  try {
    await waitFor(`http://127.0.0.1:${API_PORT}/healthz`, api, 120_000);
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n--- API output ---\n${apiLog.slice(-4000)}`);
  }
  return stop;
}
