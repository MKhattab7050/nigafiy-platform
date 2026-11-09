import pg from 'pg';
import { env } from '../config/env.ts';
import { logger } from './logger.ts';

/**
 * Two connection pools, two trust levels.
 *
 *  - `appPool` connects as the restricted `lan_app` role. Row Level Security is enforced for it:
 *    a query can only see rows of the organization set with `withTenant()`. With no tenant set,
 *    tenant tables return zero rows. ALL tenant data access goes through here.
 *
 *  - `systemPool` connects as the schema owner. It is used only for: migrations, the identity
 *    tables (users / sessions) that the app role cannot read at all, collector credential lookup,
 *    and platform-level jobs that sweep across tenants with set-based SQL.
 */
export const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 6, application_name: 'ld-system' });
export const appPool = new pg.Pool({ connectionString: env.APP_DATABASE_URL, max: 16, application_name: 'ld-app' });

for (const [name, pool] of [['system', systemPool], ['app', appPool]] as const) {
  pool.on('error', (err) => logger.error({ err, pool: name }, 'idle database client error'));
}

export type Db = Pick<pg.PoolClient, 'query'>;

async function inTransaction<T>(pool: pg.Pool, setup: ((c: pg.PoolClient) => Promise<void>) | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (setup) await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Run `fn` in a transaction that can only see and write data of `organizationId`. */
export function withTenant<T>(organizationId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(
    appPool,
    async (c) => {
      // set_config(..., true) is transaction-local: it cannot leak to the next user of the pooled connection.
      await c.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
    },
    fn,
  );
}

/** Platform-level transaction (bypasses tenant RLS). Keep usage minimal and always filter explicitly. */
export function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(systemPool, null, fn);
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([systemPool.end(), appPool.end()]);
}
