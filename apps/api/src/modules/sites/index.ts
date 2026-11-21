import { defineModule } from '../../infrastructure/module.ts';
import { sitesRouter } from './routes.ts';

/** Sites, their authorized network scopes, and scope suggestions from what collectors report (scope-suggestions.ts). */
export const sitesModule = defineModule({ name: 'sites', api: sitesRouter });
