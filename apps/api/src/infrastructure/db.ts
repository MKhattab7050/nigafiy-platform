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
/**
 * Waiting for a free connection is bounded: when every connection is busy a request fails after
 * this long (and the API answers 503) instead of hanging until the browser gives up.
 */
export const DB_CONNECT_TIMEOUT_MS = positiveIntFromEnv('DB_CONNECT_TIMEOUT_MS', 5000);

/**
 * Statement time limits, enforced by PostgreSQL. Requests go through appPool and must be quick;
 * systemPool also runs the hourly retention sweep, whose DELETEs can take minutes on a big database.
 * Migrations, backups and restores use their own connections without a limit.
 */
const APP_STATEMENT_TIMEOUT_MS = positiveIntFromEnv('DB_APP_STATEMENT_TIMEOUT_MS', 60_000);
const SYSTEM_STATEMENT_TIMEOUT_MS = positiveIntFromEnv('DB_SYSTEM_STATEMENT_TIMEOUT_MS', 300_000);

export const systemPool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 12,
  application_name: 'ld-system',
  connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  statement_timeout: SYSTEM_STATEMENT_TIMEOUT_MS,
});
export const appPool = new pg.Pool({
  connectionString: env.APP_DATABASE_URL,
  max: 16,
  application_name: 'ld-app',
  connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  statement_timeout: APP_STATEMENT_TIMEOUT_MS,
});

/**
 * Connections that only hold the scheduler's advisory locks (a session lock lives as long as its
 * connection). They are kept apart from systemPool: a job used to hold a systemPool connection for
 * its whole run, so a dozen jobs starting together took every connection, and both the jobs' own
 * queries and every sign-in then waited for a connection forever. A lock connection runs only
 * pg_try_advisory_lock / pg_advisory_unlock; the job's work uses the normal pools.
 * Sized for the scheduler's concurrent runs plus runs that outlived their slot (scheduler.ts).
 */
export const lockPool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 8,
  application_name: 'ld-locks',
  connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  statement_timeout: 10_000,
});

function positiveIntFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** True for the error node-postgres raises when no pool connection became free in time. */
export function isPoolTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message);
}

/**
 * Why a database call failed when the cause is the database being busy or away rather than the
 * request: `service_busy` (no free connection in time, or a statement ran past its limit) or
 * `database_unavailable` (refused, reset, starting up or shutting down). Null for any other error.
 */
export function databaseUnavailableCode(err: unknown): 'service_busy' | 'database_unavailable' | null {
  if (isPoolTimeout(err)) return 'service_busy';
  const code = (err as { code?: unknown } | null)?.code;
  if (code === '57014') return 'service_busy'; // statement_timeout
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === '57P01' || code === '57P02' || code === '57P03') return 'database_unavailable';
  return null;
}

for (const [name, pool] of [['system', systemPool], ['app', appPool], ['locks', lockPool]] as const) {
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
  await Promise.allSettled([systemPool.end(), appPool.end(), lockPool.end()]);
}
