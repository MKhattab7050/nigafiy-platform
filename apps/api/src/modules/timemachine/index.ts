import { defineModule } from '../../infrastructure/module.ts';
import { timeMachineRouter } from './routes.ts';

/** Network Time Machine: snapshots of a past moment and comparison of two periods. */
export const timeMachineModule = defineModule({ name: 'timemachine', api: timeMachineRouter });
