import { defineModule } from '../../infrastructure/module.ts';
import { insightsRouter } from './routes.ts';

/** Actionable insights (GET /insights) from the pure rule set in rules.ts. */
export const insightsModule = defineModule({ name: 'insights', api: insightsRouter });

export { loadInsightFacts } from './routes.ts';
export { buildInsights } from './rules.ts';
