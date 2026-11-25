import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

/**
 * A throw-away PostgreSQL server for the API integration tests and the browser smoke tests.
 *
 * Why not just `EmbeddedPostgres.start()` everywhere: that spawns `postgres.exe` directly, and on
 * Windows PostgreSQL refuses to run under an account with administrative rights ("Execution of
 * PostgreSQL by a user with administrative permissions is not permitted"). Windows CI runners run
 * elevated, so the server exited at once and embedded-postgres rejected with `undefined`, which
 * vitest reported as "No test files found" plus "Unknown Error: undefined". PostgreSQL's own tools
 * handle this: `initdb` (used by `initialise()`) and `pg_ctl` drop the administrator rights with a
 * restricted token before starting the server. So on Windows the server is started and stopped
 * with `pg_ctl`; elsewhere embedded-postgres starts it as before.
 *
 * Self-contained on purpose (no relative imports): apps/web/e2e/global-setup.ts imports it too.
 */

export interface ThrowawayPostgres {
  stop(): Promise<void>;
}

export interface ThrowawayPostgresOptions {
  /** Data directory; created by initdb and removed on stop. */
  dir: string;
  port: number;
  /** Database created after start (owned by the `postgres` superuser, password `postgres`). */
  database: string;
}

function windowsBinDir(): string {
  // createRequire, not import.meta.resolve: vitest's module runner does not provide the latter.
  const embedded = createRequire(import.meta.url).resolve('embedded-postgres');
  const entry = createRequire(embedded).resolve('@embedded-postgres/windows-x64');
  return path.resolve(path.dirname(entry), '..', 'native', 'bin');
}

function run(file: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    // pg_ctl leaves the server running with inherited handles, so wait for 'exit', not 'close'.
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

async function tail(file: string): Promise<string> {
  try {
    return (await readFile(file, 'utf8')).slice(-4000);
  } catch {
    return '(no server log)';
  }
}

export async function startThrowawayPostgres(opts: ThrowawayPostgresOptions): Promise<ThrowawayPostgres> {
  let log = '';
  const server = new EmbeddedPostgres({
    databaseDir: opts.dir,
    user: 'postgres',
    password: 'postgres',
    port: opts.port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: (m) => {
      log = (log + String(m)).slice(-8000);
    },
    onError: (e) => {
      log = (log + String(e)).slice(-8000);
    },
  });
  const removeDir = () =>
    // Windows can hold the data directory for a moment after shutdown; cleanup is best effort.
    rm(opts.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  // Resolved before initdb, so a missing binary package leaves no data directory behind.
  const pgCtl = process.platform === 'win32' ? path.join(windowsBinDir(), 'pg_ctl.exe') : null;
  try {
    await server.initialise();
  } catch (err) {
    await removeDir();
    throw err;
  }

  let stopServer: () => Promise<void>;
  if (pgCtl) {
    // The log lives next to (not inside) the data directory, so a failed start still leaves it readable.
    const logFile = `${opts.dir}.log`;
    const started = await run(pgCtl, ['start', '-w', '-t', '120', '-D', opts.dir, '-l', logFile, '-o', `-p ${opts.port}`]);
    if (started.code !== 0) {
      await run(pgCtl, ['stop', '-D', opts.dir, '-m', 'immediate', '-w']).catch(() => undefined);
      await removeDir();
      throw new Error(
        `pg_ctl start failed (exit ${started.code}): ${started.output.trim()}\n--- server log ---\n${await tail(logFile)}`,
      );
    }
    stopServer = async () => {
      await run(pgCtl, ['stop', '-D', opts.dir, '-m', 'fast', '-w', '-t', '60']).catch(() => undefined);
      await rm(logFile, { force: true }).catch(() => undefined);
    };
  } else {
    try {
      await server.start();
    } catch (err) {
      await removeDir();
      // embedded-postgres rejects with `undefined` when the server exits early; say what it printed.
      throw new Error(`PostgreSQL did not start: ${String(err ?? 'server exited')}\n--- server output ---\n${log}`);
    }
    stopServer = () => server.stop().catch(() => undefined);
  }

  const stop = async () => {
    await stopServer();
    await removeDir();
  };

  try {
    const client = new pg.Client({ host: '127.0.0.1', port: opts.port, user: 'postgres', password: 'postgres', database: 'postgres' });
    await client.connect();
    try {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(opts.database)}`);
    } finally {
      await client.end();
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { stop };
}
