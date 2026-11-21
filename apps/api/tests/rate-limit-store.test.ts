import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { describe, expect, it } from 'vitest';
import { createRateLimitStores, FallbackStore, redactRedisUrl } from '../src/infrastructure/rate-limit-store.ts';

// No Redis server is available here: these tests cover store selection, the per-instance fallback
// and a real redis client pointed at a port nothing listens on. Test doubles stand in for a working
// (or broken) shared store only inside this file.

const options = { windowMs: 60_000 } as Options;

function recordingLog() {
  const lines: { level: 'info' | 'warn'; obj: object; msg: string }[] = [];
  return {
    lines,
    info: (obj: object, msg: string) => void lines.push({ level: 'info', obj, msg }),
    warn: (obj: object, msg: string) => void lines.push({ level: 'warn', obj, msg }),
  };
}

/** A shared store stand-in whose availability the test controls. */
class SwitchableStore implements Store {
  up = true;
  hang = false;
  hits = new Map<string, number>();
  inits = 0;
  init() {
    this.inits++;
  }
  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (this.hang) return new Promise(() => undefined);
    if (!this.up) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const n = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, n);
    return { totalHits: n, resetTime: new Date(Date.now() + 60_000) };
  }
  async decrement(key: string) {
    if (!this.up) throw new Error('down');
    this.hits.set(key, (this.hits.get(key) ?? 1) - 1);
  }
  async resetKey(key: string) {
    if (!this.up) throw new Error('down');
    this.hits.delete(key);
  }
}

describe('rate-limit store selection', () => {
  it('without REDIS_URL keeps express-rate-limit’s default memory store (no store configured)', () => {
    const log = recordingLog();
    const stores = createRateLimitStores(undefined, log);
    expect(stores.kind).toBe('memory');
    expect(stores.storeFor('api')).toBeUndefined();
    expect(log.lines).toEqual([]);
  });

  it('never logs credentials from the Redis URL', () => {
    expect(redactRedisUrl('redis://user:s3cret@cache.internal:6380/0')).toBe('redis://cache.internal:6380');
    expect(redactRedisUrl('rediss://:pw@10.0.0.5')).toBe('rediss://10.0.0.5');
  });
});

describe('FallbackStore', () => {
  it('uses the shared store while it answers', async () => {
    const shared = new SwitchableStore();
    const errors: unknown[] = [];
    const store = new FallbackStore('rl:t:', () => shared, (e) => errors.push(e));
    store.init(options);
    expect((await store.increment('1.2.3.4')).totalHits).toBe(1);
    expect((await store.increment('1.2.3.4')).totalHits).toBe(2);
    expect(shared.hits.get('1.2.3.4')).toBe(2);
    expect(shared.inits).toBe(1);
    expect(errors).toEqual([]);
  });

  it('counts in per-instance memory while the shared store fails, and returns to it when it is back', async () => {
    const shared = new SwitchableStore();
    const errors: unknown[] = [];
    let oks = 0;
    const store = new FallbackStore(
      'rl:t:',
      () => shared,
      (e) => errors.push(e),
      () => oks++,
    );
    store.init(options);
    shared.up = false;
    // Still limited (not fail-open): the memory store counts 1, 2, 3.
    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    expect((await store.increment('k')).totalHits).toBe(3);
    expect(errors).toHaveLength(3);
    shared.up = true;
    expect((await store.increment('k')).totalHits).toBe(1); // shared counter again
    expect(oks).toBe(1);
  });

  it('falls back when the shared store does not answer in time', async () => {
    const shared = new SwitchableStore();
    shared.hang = true;
    const errors: unknown[] = [];
    const store = new FallbackStore('rl:t:', () => shared, (e) => errors.push(e), undefined, 50);
    store.init(options);
    const started = Date.now();
    expect((await store.increment('k')).totalHits).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(String(errors[0])).toMatch(/did not answer within 50 ms/);
  });

  it('uses memory when no shared store is available yet (not connected)', async () => {
    const errors: unknown[] = [];
    const store = new FallbackStore('rl:t:', () => null, (e) => errors.push(e));
    store.init(options);
    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    await store.decrement('k');
    expect((await store.increment('k')).totalHits).toBe(2);
    await store.resetKey('k');
    expect((await store.increment('k')).totalHits).toBe(1);
    store.shutdown();
  });
});

describe('REDIS_URL pointing at an unreachable server', () => {
  it('answers from memory quickly, logs the fallback once, and never logs the password', async () => {
    const log = recordingLog();
    // Port 1 on loopback: nothing listens there, the connection is refused at once.
    const stores = createRateLimitStores('redis://user:hunter2-secret@127.0.0.1:1', log);
    try {
      expect(stores.kind).toBe('redis');
      const a = stores.storeFor('api')!;
      const b = stores.storeFor('auth:credentials')!;
      expect(a).toBeInstanceOf(FallbackStore);
      expect(a).not.toBe(b); // express-rate-limit refuses one store shared by two limiters
      a.init?.(options);
      const started = Date.now();
      const hits: number[] = [];
      for (let i = 0; i < 3; i++) hits.push((await a.increment('10.0.0.1')).totalHits);
      expect(hits).toEqual([1, 2, 3]);
      expect(Date.now() - started).toBeLessThan(3_000);

      // Give the connection attempt time to fail and be reported.
      for (let i = 0; i < 40 && !log.lines.some((l) => l.level === 'warn'); i++) await new Promise((r) => setTimeout(r, 50));
      const warns = log.lines.filter((l) => l.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]!.msg).toMatch(/fall back to this API instance/);
      expect(JSON.stringify(log.lines)).not.toContain('hunter2-secret');
      expect(JSON.stringify(log.lines)).toContain('redis://127.0.0.1:1');
    } finally {
      await stores.close();
    }
  });
});

// ── A real Redis server, when one is reachable ───────────────────────────────
// LD_TEST_REDIS_URL (default redis://127.0.0.1:6379). Nothing is started for this test: when no
// Redis answers, the test is skipped and says so; every test above runs regardless.

const REDIS_TEST_URL = process.env.LD_TEST_REDIS_URL || 'redis://127.0.0.1:6379';

async function redisReachable(url: string): Promise<boolean> {
  const { createConnection } = await import('node:net');
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = createConnection({ host: u.hostname, port: Number(u.port || 6379), timeout: 500 });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

describe('REDIS_URL pointing at a real Redis server', () => {
  it('shares one counter between two API instances (two clients)', async (ctx) => {
    if (!(await redisReachable(REDIS_TEST_URL))) {
      console.warn(`[rate-limit-store.test] SKIPPING the real-Redis test: no Redis server answers at ${redactRedisUrl(REDIS_TEST_URL)} (set LD_TEST_REDIS_URL to run it).`);
      return ctx.skip();
    }
    const prefix = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const a = createRateLimitStores(REDIS_TEST_URL, recordingLog());
    const b = createRateLimitStores(REDIS_TEST_URL, recordingLog());
    try {
      const sa = a.storeFor(prefix)!;
      const sb = b.storeFor(prefix)!;
      sa.init?.(options);
      sb.init?.(options);
      // Wait until both clients are connected: then B sees A's increment (+1), never before.
      let shared = false;
      for (let i = 0; i < 60 && !shared; i++) {
        const x = await sa.increment('warmup');
        const y = await sb.increment('warmup');
        shared = y.totalHits === x.totalHits + 1;
        if (!shared) await new Promise((r) => setTimeout(r, 50));
      }
      expect(shared).toBe(true);
      expect((await sa.increment('10.9.9.9')).totalHits).toBe(1);
      expect((await sb.increment('10.9.9.9')).totalHits).toBe(2);
      expect((await sa.increment('10.9.9.9')).totalHits).toBe(3);
      await sb.resetKey('10.9.9.9');
      await sa.resetKey('warmup');
    } finally {
      await a.close();
      await b.close();
    }
  });
});
