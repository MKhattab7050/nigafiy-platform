import { type ClientRateLimitInfo, MemoryStore, type Options, type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';

/**
 * Where `express-rate-limit` keeps its counters.
 *
 *  - `REDIS_URL` unset: nothing is configured and every limiter uses its own default MemoryStore,
 *    exactly as before (one API instance, the local stack, the engine-managed install).
 *  - `REDIS_URL` set: counters are shared through Redis so the limits hold across API instances.
 *    When Redis is unreachable, slow (> COMMAND_TIMEOUT_MS) or errors, each request is counted in a
 *    per-instance MemoryStore instead — the same protection a single instance has today — and the
 *    switch is logged once in each direction. Rate limiting therefore never fails open (no limit at
 *    all) and never fails closed (rejecting everyone because Redis is down).
 */

export interface RateLimitLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export const COMMAND_TIMEOUT_MS = 1_000;

/** Keeps a limiter's counters in `primary()` when it is available, else in a local MemoryStore. */
export class FallbackStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private readonly memory = new MemoryStore();
  private options: Options | undefined;
  private readonly initialised = new WeakSet<Store>();

  private readonly primary: () => Store | null;
  private readonly onPrimaryError: (err: unknown) => void;
  private readonly onPrimaryOk: () => void;
  private readonly timeoutMs: number;

  constructor(prefix: string, primary: () => Store | null, onPrimaryError: (err: unknown) => void, onPrimaryOk: () => void = () => undefined, timeoutMs = COMMAND_TIMEOUT_MS) {
    this.prefix = prefix;
    this.primary = primary;
    this.onPrimaryError = onPrimaryError;
    this.onPrimaryOk = onPrimaryOk;
    this.timeoutMs = timeoutMs;
  }

  init(options: Options): void {
    this.options = options;
    this.memory.init(options);
  }

  private current(): Store | null {
    const p = this.primary();
    if (p && this.options && !this.initialised.has(p)) {
      void p.init?.(this.options);
      this.initialised.add(p);
    }
    return p;
  }

  private async attempt<T>(fn: (s: Store) => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false }> {
    const p = this.current();
    if (!p) return { ok: false };
    let timer: NodeJS.Timeout | undefined;
    const pending = Promise.resolve().then(() => fn(p));
    pending.catch(() => undefined); // a late rejection after the timeout must not go unhandled
    try {
      const value = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`rate-limit store did not answer within ${this.timeoutMs} ms`)), this.timeoutMs);
        }),
      ]);
      this.onPrimaryOk();
      return { ok: true, value };
    } catch (err) {
      this.onPrimaryError(err);
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const r = await this.attempt((s) => s.increment(key));
    return r.ok ? r.value : this.memory.increment(key);
  }

  async decrement(key: string): Promise<void> {
    const r = await this.attempt((s) => s.decrement(key));
    if (!r.ok) await this.memory.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    await this.attempt((s) => s.resetKey(key));
    await this.memory.resetKey(key);
  }

  shutdown(): void {
    this.memory.shutdown();
  }
}


export interface RateLimitStores {
  kind: 'memory' | 'redis';
  /** A store for one limiter (`undefined` = express-rate-limit's default MemoryStore). Never share one between limiters. */
  storeFor(prefix: string): Store | undefined;
  close(): Promise<void>;
}

/** Host and port only: a Redis URL may carry a password. */
export function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '(unparseable REDIS_URL)';
  }
}

const memoryStores: RateLimitStores = { kind: 'memory', storeFor: () => undefined, close: async () => undefined };

export function createRateLimitStores(redisUrl: string | undefined, log: RateLimitLog): RateLimitStores {
  if (!redisUrl) return memoryStores;
  const target = redactRedisUrl(redisUrl);
  const client = createClient({
    url: redisUrl,
    // Fail fast while disconnected instead of queueing requests behind a dead connection.
    disableOfflineQueue: true,
    socket: { connectTimeout: 2_000, reconnectStrategy: (retries: number) => Math.min(500 * 2 ** Math.min(retries, 5), 15_000) },
  });
  let shared = true; // what was last logged
  const markDown = (err: unknown) => {
    if (!shared) return;
    shared = false;
    const e = err as { code?: string; name?: string };
    log.warn(
      { redis: target, error: e?.code ?? e?.name ?? 'error' },
      'Redis unreachable: rate limits fall back to this API instance’s memory until it is back',
    );
  };
  const markUp = () => {
    if (shared) return;
    shared = true;
    log.info({ redis: target }, 'Redis reachable again: rate limits are shared across API instances');
  };
  client.on('error', markDown);
  client.on('ready', markUp);

  const stores = new Map<string, RedisStore>();
  const primaryFor = (prefix: string) => (): Store | null => {
    if (!client.isReady) return null;
    let s = stores.get(prefix);
    if (!s) {
      s = new RedisStore({ prefix, sendCommand: (...args: string[]) => client.sendCommand(args) });
      // The constructor starts loading its Lua scripts; a failure there is retried on use.
      for (const p of [(s as unknown as { incrementScriptSha?: Promise<unknown> }).incrementScriptSha, (s as unknown as { getScriptSha?: Promise<unknown> }).getScriptSha]) {
        p?.catch(() => undefined);
      }
      stores.set(prefix, s);
    }
    return s;
  };

  log.info({ redis: target }, 'rate limits: shared Redis store (falls back to per-instance memory while Redis is unreachable)');
  client.connect().catch(markDown);
  client.unref();

  return {
    kind: 'redis',
    storeFor: (prefix) => new FallbackStore(`rl:${prefix}:`, primaryFor(`rl:${prefix}:`), markDown, markUp),
    close: async () => {
      try {
        client.destroy();
      } catch {
        // already closed
      }
    },
  };
}

const cache = new Map<string, RateLimitStores>();

/** One Redis connection per process (createApp may run more than once, e.g. in tests). */
export function rateLimitStores(redisUrl: string | undefined, log: RateLimitLog): RateLimitStores {
  if (!redisUrl) return memoryStores;
  let s = cache.get(redisUrl);
  if (!s) {
    s = createRateLimitStores(redisUrl, log);
    cache.set(redisUrl, s);
  }
  return s;
}
