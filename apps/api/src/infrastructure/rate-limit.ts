import type { Store } from 'express-rate-limit';
import { env } from '../config/env.ts';
import { logger } from './logger.ts';
import { rateLimitStores } from './rate-limit-store.ts';

/**
 * The counter store for one `rateLimit()` limiter: shared through Redis when `REDIS_URL` is set,
 * otherwise `undefined` (express-rate-limit's own per-instance MemoryStore, as before). Call it once
 * per limiter with a prefix unique to that limiter.
 */
export function limiterStore(prefix: string): Store | undefined {
  return rateLimitStores(env.REDIS_URL, logger).storeFor(prefix);
}
