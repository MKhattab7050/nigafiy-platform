import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { moveApkContentToFiles } from './apk-file-mover.ts';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/**
 * Creates (or updates the password of) the restricted `lan_app` role from APP_DATABASE_URL. Roles are
 * cluster-wide; the restore tool (ops/backup.ts) also needs it before restoring grants into a new cluster.
 */
export async function ensureAppRole(client: pg.Client, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const appRole = decodeURIComponent(app.username);
  const appPassword = decodeURIComponent(app.password);
  if (appRole !== 'lan_app') throw new Error('APP_DATABASE_URL must connect as the "lan_app" role');
  if (!appPassword) throw new Error('APP_DATABASE_URL must include a password');
  const roleExists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole]);
  const quotedPassword = client.escapeLiteral(appPassword);
  // NOBYPASSRLS + NOSUPERUSER is what makes Row Level Security binding for this role.
  await client.query(
    `${roleExists.rowCount ? 'ALTER' : 'CREATE'} ROLE lan_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${quotedPassword}`,
  );
}

/**
 * Steps that need more than SQL. Each runs inside its migration's transaction, just before the SQL
 * file, and must be idempotent (a failed migration rolls back and runs again on the next start).
 */
const BEFORE: Readonly<Record<string, (client: pg.Client, log: (msg: string) => void) => Promise<void>>> = {
  // APK bytes leave the database for the file store (apk-file-mover.ts).
  '048_android_apk_files.sql': moveApkContentToFiles,
};

/**
 * Applies pending SQL migrations as the owner role and makes sure the restricted
 * `lan_app` role exists with the password from APP_DATABASE_URL.
 */
export async function migrate(
  ownerUrl: string,
  appUrl: string,
  log: (msg: string) => void = () => undefined,
  /** Tests only: stop before this migration file (it and later ones are not applied). */
  opts: { stopBefore?: string } = {},
): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // Serialise concurrent migrators (e.g. two API instances starting together).
    await client.query('SELECT pg_advisory_lock(727001)');

    await ensureAppRole(client, appUrl);

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (opts.stopBefore && file >= opts.stopBefore) break;
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await BEFORE[file]?.(client, log);
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    await client.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    await client.end();
  }
}
