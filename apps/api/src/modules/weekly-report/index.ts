import { defineModule } from '../../infrastructure/module.ts';
import { weeklyReportRouter } from './routes.ts';
import { generateWeeklyReports } from './service.ts';

/**
 * Weekly report: one short, rule-based summary per organization and local week (the week's main
 * events, one sentence each, and the top 3 improvements). Always on its page; sent through the
 * notification channels only when the user turns that on.
 */
export const weeklyReportModule = defineModule({
  name: 'weekly-report',
  api: weeklyReportRouter,
  jobs: [{ name: 'weekly-report', everyMs: 3_600_000, lockKey: 727198, run: async () => void (await generateWeeklyReports()) }],
});

export { currentWeekPreview, generateWeeklyReport, generateWeeklyReports, mergeGaps } from './service.ts';
export { weeklyEvents, weeklyImprovements, weeklyTitle } from './rules.ts';
