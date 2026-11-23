import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { readEnv } from '../src/config/env-compat.ts';
import { migrate } from '../src/database/migrate.ts';

// NIGAFIY_TEST_PG_PORT (legacy LD_TEST_PG_PORT) lets several test runs (for example parallel worktrees) use their own server.
const PORT = Number(readEnv('NIGAFIY_TEST_PG_PORT') ?? 5439);
const OWNER_URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/lan_detective_test`;
const APP_URL = `postgres://lan_app:test-app-password@127.0.0.1:${PORT}/lan_detective_test`;

export default async function setup(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ld-test-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  try {
    await server.createDatabase('lan_detective_test');
    await migrate(OWNER_URL, APP_URL);
  } catch (err) {
    await server.stop();
    throw err;
  }
  return async () => {
    // Windows can hold the data directory for a moment after shutdown; cleanup is best effort.
    await server.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  };
}
