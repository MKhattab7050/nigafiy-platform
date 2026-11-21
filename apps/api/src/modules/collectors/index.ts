import { defineModule } from '../../infrastructure/module.ts';
import { collectorsRouter } from './routes.ts';
import { watchCollectors } from './watch.ts';

/**
 * Collector management (create, enrollment tokens, revoke, commands) and the collector-watch job,
 * which marks silent collectors — and silent endpoint agents — offline. The collector-facing
 * gateway itself is the ingest module.
 */
export const collectorsModule = defineModule({
  name: 'collectors',
  api: collectorsRouter,
  jobs: [{ name: 'collector-watch', everyMs: 15_000, lockKey: 727101, run: watchCollectors }],
});

export { COLLECTOR_OFFLINE_AFTER_SECONDS, watchCollectors } from './watch.ts';
export { type SiteCommandKind, type SiteCommandQueued, collectorCommandStates, queueSiteCollectorCommand } from './commands.ts';
