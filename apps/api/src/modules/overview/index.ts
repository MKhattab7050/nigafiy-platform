import { defineModule } from '../../infrastructure/module.ts';
import { overviewRouter } from './routes.ts';

/** The dashboard figures (GET /overview), computed from stored observations only. */
export const overviewModule = defineModule({ name: 'overview', api: overviewRouter });
