// Local development database: a real PostgreSQL server (embedded binaries from npm),
// for machines without Docker. Data lives in <repo>/.data/pg. Stop with Ctrl+C.
//
// On Windows the server is started and stopped with PostgreSQL's own pg_ctl, as tests/pg-server.ts
// does: embedded-postgres spawns postgres.exe directly, and PostgreSQL refuses to run under an
// account with administrative rights ("Execution of PostgreSQL by a user with administrative
// permissions is not permitted"), so `dev:db` failed in an elevated prompt. pg_ctl (like initdb,
// used by initialise()) drops those rights with a restricted token first, and works the same
// without them. Elsewhere embedded-postgres starts and stops the server as before.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readEnv } from '../src/config/env-compat.ts';

// embedded-postgres chmods its binaries to add the executable bit. Windows has no such bit, and in an
// installed app the binaries live under C:\Program Files, which a normal user cannot modify — the call
// then fails with EPERM although the binaries run fine. Ignore exactly that case.
if (process.platform === 'win32') {
  const chmod = fsp.chmod;
  fsp.chmod = (async (...args: Parameters<typeof chmod>) => {
    try {
      await chmod(...args);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
  }) as typeof chmod;
}

const url = new URL(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/lan_detective');
// NIGAFIY_PG_DIR (legacy LD_PG_DIR): set by the desktop app, which keeps its data in the user's profile.
const pgDir = readEnv('NIGAFIY_PG_DIR');
const databaseDir = pgDir ? path.resolve(pgDir) : path.resolve(import.meta.dirname, '../../../.data/pg');
const database = url.pathname.slice(1) || 'lan_detective';

const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const port = Number(url.port || 5432);

const server = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
  // UTF-8 regardless of the host locale (Windows would otherwise default to WIN1252).
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => undefined,
  onError: (e) => console.error(String(e)),
});

/** pg_ctl.exe of the binaries embedded-postgres uses (resolved the way tests/pg-server.ts does). */
function windowsPgCtl(): string {
  const embedded = createRequire(import.meta.url).resolve('embedded-postgres');
  const entry = createRequire(embedded).resolve('@embedded-postgres/windows-x64');
  return path.resolve(path.dirname(entry), '..', 'native', 'bin', 'pg_ctl.exe');
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

// Resolved before initdb, so a missing binary package leaves no data directory behind.
const pgCtl = process.platform === 'win32' ? windowsPgCtl() : null;
// The server log lives next to (not inside) the data directory; it is read only when a start fails.
const logFile = `${databaseDir}.log`;

if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) {
  console.log('initialising database cluster in', databaseDir);
  await server.initialise();
}

if (pgCtl) {
  await fsp.rm(logFile, { force: true }).catch(() => undefined);
  const started = await run(pgCtl, ['start', '-w', '-t', '120', '-D', databaseDir, '-l', logFile, '-o', `-p ${port}`]);
  if (started.code !== 0) {
    const log = await fsp.readFile(logFile, 'utf8').then((s) => s.slice(-4000), () => '(no server log)');
    console.error(`pg_ctl start failed (exit ${started.code}): ${started.output.trim()}\n--- server log ---\n${log}`);
    process.exit(1);
  }
  const client = new pg.Client({ host: 'localhost', port, user, password, database: 'postgres' });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(database)}`);
    console.log('created database', database);
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err; // 42P04: already exists
  } finally {
    await client.end();
  }
} else {
  await server.start();
  try {
    await server.createDatabase(database);
    console.log('created database', database);
  } catch {
    // already exists
  }
}
console.log(`PostgreSQL ready on port ${url.port} (database "${database}"). Ctrl+C to stop.`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (pgCtl) {
    // A clean ("fast") shutdown: no postmaster.pid left behind, no recovery on the next start. The
    // server is not a child of this process, so it must be stopped before scripts/local.mjs gives
    // up waiting (15 s, then it kills this process tree): fast for 8 s, then immediate.
    const ctl = (mode: string, seconds: number) =>
      run(pgCtl, ['stop', '-D', databaseDir, '-m', mode, '-w', '-t', String(seconds)]).catch((err: unknown) => ({ code: null, output: String(err) }));
    let r = await ctl('fast', 8);
    if (r.code !== 0) r = await ctl('immediate', 5);
    if (r.code !== 0) console.error(`pg_ctl stop failed (exit ${r.code}): ${r.output.trim()}`);
  } else {
    await server.stop();
  }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// Started by scripts/local.mjs: stop cleanly when the launcher goes away (Windows has no SIGINT for children).
if (process.send) {
  process.on('disconnect', stop);
  process.on('message', (m) => m === 'stop' && void stop());
}
setInterval(() => undefined, 1 << 30);
