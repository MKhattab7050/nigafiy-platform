import { defineModule } from '../../infrastructure/module.ts';
import { realtimeRouter, startRealtime, stopRealtime } from './routes.ts';

/** Live "something changed" hints to dashboards over Server-Sent Events (GET /api/v1/stream). */
export const realtimeModule = defineModule({
  name: 'realtime',
  api: realtimeRouter,
  lifecycle: { start: startRealtime, stop: stopRealtime },
});

export { REALTIME_CHANNEL, type RealtimeTopic, notifyRealtime } from './notify.ts';
