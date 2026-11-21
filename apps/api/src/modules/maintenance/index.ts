import { defineModule } from '../../infrastructure/module.ts';
import { maintenanceRouter } from './routes.ts';
import { watchMaintenance } from './watch.ts';

/**
 * Maintenance windows: planned work during which matching events are recorded with
 * `in_maintenance = true` without opening incidents or sending alert notifications.
 */
export const maintenanceModule = defineModule({
  name: 'maintenance',
  api: maintenanceRouter,
  jobs: [{ name: 'maintenance-watch', everyMs: 30_000, lockKey: 727105, run: () => watchMaintenance() }],
});

export { watchMaintenance } from './watch.ts';
