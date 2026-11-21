import { defineModule } from '../../infrastructure/module.ts';
import { ipamRouter } from './routes.ts';

/**
 * IP address management: subnets as observed and as documented, the address plan (plan.ts, pure),
 * conflicts between the two (conflicts.ts, raised as events), CSV export and address history.
 */
export const ipamModule = defineModule({ name: 'ipam', api: ipamRouter });

export { syncIpamConflicts } from './conflicts.ts';
