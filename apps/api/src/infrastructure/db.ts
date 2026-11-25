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
export const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 12, application_name: 'ld-system' });
export const appPool = new pg.Pool({ connectionString: env.APP_DATABASE_URL, max: 16, application_name: 'ld-app' });

for (const [name, pool] of [['system', systemPool], ['app', appPool]] as const) {
  pool.on('error', (err) => logger.error({ err, pool: name }, 'idle database client error'));
}

export type Db = Pick<pg.PoolClient, 'query'>;

const DEADLOCK_DETECTED = '40P01';
const DEADLOCK_RETRIES = 2;

/**
 * Postgres resolves a deadlock by aborting one transaction; that one is simply run again (an
 * agent's result upload and an operator's action can touch the same rows in different order).
 * Callbacks passed here must therefore only have database side effects.
 */
async function inTransaction<T>(pool: pg.Pool, begin: string, setup: ((c: pg.PoolClient) => Promise<void>) | null, fn: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runTransaction(pool, begin, setup, fn);
    } catch (err) {
      if ((err as { code?: string }).code !== DEADLOCK_DETECTED || attempt >= DEADLOCK_RETRIES) throw err;
      logger.warn({ attempt: attempt + 1 }, 'transaction deadlocked; retrying');
    }
  }
}

async function runTransaction<T>(pool: pg.Pool, begin: string, setup: ((c: pg.PoolClient) => Promise<void>) | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
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

/** Canonical UUID text, the only form the one-round-trip tenant start accepts. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The statement that opens a tenant transaction in ONE round trip: `BEGIN` and the transaction-local
 * `set_config` sent together as one simple-protocol message (node-postgres sends a query without
 * parameters that way, and PostgreSQL runs its statements in order). Same two statements, same
 * order, same transaction-local setting as before, so RLS behaves exactly as with two round trips.
 * The organization id goes in as a literal, so it is accepted ONLY as a canonical UUID (hex digits
 * and hyphens, nothing to escape); anything else returns null and the caller uses the parameterized
 * two-round-trip start.
 */
export function tenantBeginSql(organizationId: string): string | null {
  return CANONICAL_UUID.test(organizationId) ? `BEGIN; SELECT set_config('app.current_org', '${organizationId}', true)` : null;
}

/** Run `fn` in a transaction that can only see and write data of `organizationId`. */
export function withTenant<T>(organizationId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  // set_config(..., true) is transaction-local: it cannot leak to the next user of the pooled connection.
  const oneTrip = tenantBeginSql(organizationId);
  if (oneTrip) return inTransaction(appPool, oneTrip, null, fn);
  return inTransaction(
    appPool,
    'BEGIN',
    async (c) => {
      await c.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
    },
    fn,
  );
}

/** Platform-level transaction (bypasses tenant RLS). Keep usage minimal and always filter explicitly. */
export function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(systemPool, 'BEGIN', null, fn);
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([systemPool.end(), appPool.end()]);
}
