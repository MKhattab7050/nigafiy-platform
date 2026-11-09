// Local development database: a real PostgreSQL server (embedded binaries from npm),
// for machines without Docker. Data lives in <repo>/.data/pg. Stop with Ctrl+C.
import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/lan_detective');
const databaseDir = path.resolve(import.meta.dirname, '../../../.data/pg');
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
setInterval(() => undefined, 1 << 30);
