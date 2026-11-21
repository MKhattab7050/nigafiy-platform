import { defineModule } from '../../infrastructure/module.ts';
import { rollupCheckResults } from './rollup.ts';
import { monitoringRouter } from './routes.ts';

/** Monitoring checks (CRUD, series), the default checks of a new site, and the hourly roll-up job. */
export const monitoringModule = defineModule({
  name: 'monitoring',
  api: monitoringRouter,
  jobs: [{ name: 'rollup', everyMs: 600_000, lockKey: 727104, run: rollupCheckResults }],
});

export { AUTO_GATEWAY, createDefaultChecks, restoreDefaultChecks } from './defaults.ts';
export { rollupCheckResults } from './rollup.ts';
