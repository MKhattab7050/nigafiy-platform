import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/database/migrate.ts';

// Throw-away databases for the operations tools (rotate-key, backup/restore), created in the test
// PostgreSQL server of tests/global-setup.ts — never the shared lan_detective_test database, so the
// "API is connected" guards are not tripped by the API under test in other files.

const OWNER = new URL(process.env.DATABASE_URL!);

export function urlFor(database: string, user: 'owner' | 'app' = 'owner'): string {
  const u = new URL(user === 'owner' ? process.env.DATABASE_URL! : process.env.APP_DATABASE_URL!);
  u.pathname = `/${database}`;
  return u.toString();
}

export const maintenanceUrl = (): string => urlFor('postgres');

export async function adminQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
  const c = new pg.Client({ connectionString: maintenanceUrl() });
  await c.connect();
  try {
    return await c.query<T>(sql, params);
  } finally {
    await c.end();
  }
}

export async function databaseExists(name: string): Promise<boolean> {
  return Boolean((await adminQuery('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount);
}

/** Creates an empty database (optionally migrated to the current schema). */
export async function scratchDatabase(prefix: string, opts: { migrate?: boolean } = {}): Promise<{ name: string; ownerUrl: string; appUrl: string }> {
  const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await adminQuery(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`);
  const ownerUrl = urlFor(name, 'owner');
  const appUrl = urlFor(name, 'app');
  if (opts.migrate !== false) await migrate(ownerUrl, appUrl);
  return { name, ownerUrl, appUrl };
}

export async function dropDatabase(name: string): Promise<void> {
  await adminQuery(`DROP DATABASE IF EXISTS "${name.replaceAll('"', '""')}" WITH (FORCE)`);
}

/** Every database on the test server whose name starts with `prefix`. */
export async function databasesLike(prefix: string): Promise<string[]> {
  const r = await adminQuery<{ datname: string }>(`SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname`, [prefix]);
  return r.rows.map((x) => x.datname);
}

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>, applicationName?: string): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: applicationName });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export const testServerPort = Number(OWNER.port);
