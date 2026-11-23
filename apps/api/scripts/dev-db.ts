// Local development database: a real PostgreSQL server (embedded binaries from npm),
// for machines without Docker. Data lives in <repo>/.data/pg. Stop with Ctrl+C.
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
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

const server = new EmbeddedPostgres({
  databaseDir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: Number(url.port || 5432),
  persistent: true,
  // UTF-8 regardless of the host locale (Windows would otherwise default to WIN1252).
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => undefined,
  onError: (e) => console.error(String(e)),
});

if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) {
  console.log('initialising database cluster in', databaseDir);
  await server.initialise();
}
await server.start();
try {
  await server.createDatabase(database);
  console.log('created database', database);
} catch {
  // already exists
}
console.log(`PostgreSQL ready on port ${url.port} (database "${database}"). Ctrl+C to stop.`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
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
