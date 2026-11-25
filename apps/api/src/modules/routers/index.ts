import { defineModule } from '../../infrastructure/module.ts';
import { runRouterPauses } from './pause-block.ts';
import { runProductSchedules } from './product-schedule.ts';
import { routersRouter } from './routes.ts';

/**
 * Router control: the site's routers, read and controlled through the site's collector.
 *
 *   schema.ts            request validation, limits
 *   credentials.ts       router credentials (sealed at rest; decrypted only for the site's collector)
 *   collector-config.ts  the heartbeat `routers` block (lockout-aware)
 *   service.ts           router CRUD, certificate trust on first use, refresh, request queueing
 *   control.ts           block / unblock (ledger-aware, with protected-device guards), rate limit, schedule
 *   product-schedule.ts  schedules Nigafiy enforces with the router's block (router-schedules job)
 *   pause-block.ts       internet pauses enforced with the router's block (router-pauses job)
 *   settings.ts          router settings (overview, Wi-Fi, reservations, port forwards) and their controls; rename; reboot
 *   ingest.ts            router_result telemetry → clients, ledger, settings, health events, lockout pause
 *   controls.ts          GET /devices/:id/controls: one consolidated description from every module
 *
 * Nothing here acts without an explicit administrator request, except the collector's read-only
 * periodic refresh, the schedules an administrator set (router-schedules job) and the internet
 * pauses someone set (router-pauses job). Blocking is never automatic otherwise.
 */
export const routersModule = defineModule({
  name: 'routers',
  api: routersRouter,
  jobs: [
    { name: 'router-schedules', everyMs: 30_000, lockKey: 727150, run: () => runProductSchedules() },
    { name: 'router-pauses', everyMs: 30_000, lockKey: 727151, run: () => runRouterPauses() },
  ],
});

export { buildRouterConfig } from './collector-config.ts';
export { processRouterResult } from './ingest.ts';
export { type DeviceResult, changeBlocks, setRateLimit } from './control.ts';
export { rebootRouter, setWifi } from './settings.ts';
