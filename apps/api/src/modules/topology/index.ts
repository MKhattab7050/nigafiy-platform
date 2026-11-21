import { defineModule } from '../../infrastructure/module.ts';
import { topologyRouter } from './routes.ts';

/** Evidence-based network topology (GET /topology). */
export const topologyModule = defineModule({ name: 'topology', api: topologyRouter });

export { buildTopology } from './routes.ts';
