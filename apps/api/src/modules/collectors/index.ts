import { defineModule } from '../../infrastructure/module.ts';
import { ALIVE_TICK_MS, detectRestartGap, recordAliveTick, startCollectorWatchGrace } from './monitor-gaps.ts';
import { collectorsRouter } from './routes.ts';
import { COLLECTOR_OFFLINE_AFTER_SECONDS, watchCollectors } from './watch.ts';

/**
 * Collector management (create, enrollment tokens, revoke, commands) and the collector-watch job,
 * which marks silent collectors — and silent endpoint agents — offline. The collector-facing
 * gateway itself is the ingest module.
 *
 * Also records when monitoring itself was off (monitor-gaps.ts): on start the API compares now with
 * its last alive tick, and the monitor-alive job keeps that tick current.
 */
export const collectorsModule = defineModule({
  name: 'collectors',
  api: collectorsRouter,
  jobs: [
    { name: 'collector-watch', everyMs: 15_000, lockKey: 727101, run: watchCollectors },
    { name: 'monitor-alive', everyMs: ALIVE_TICK_MS, lockKey: 727181, run: () => recordAliveTick() },
  ],
  lifecycle: {
    start: async () => {
      startCollectorWatchGrace(COLLECTOR_OFFLINE_AFTER_SECONDS);
      await detectRestartGap();
    },
  },
});

export { COLLECTOR_OFFLINE_AFTER_SECONDS, watchCollectors } from './watch.ts';
export { type SiteCommandKind, type SiteCommandQueued, collectorCommandStates, queueSiteCollectorCommand } from './commands.ts';
export { type AvailabilityInterval, GAP_MIN_SECONDS, applyMonitorGaps, detectRestartGap, recordAliveTick, recordCollectorGap } from './monitor-gaps.ts';
