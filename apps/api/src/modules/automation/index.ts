import { defineModule } from '../../infrastructure/module.ts';
import { automationRouter } from './routes.ts';

/**
 * Smart defaults: the catalogue of automatic behaviours (catalogue.ts), their per-organization and
 * per-site settings, and the helpers owning modules call before acting:
 *
 *   automationEnabled(db, org, site, key)   site row → organization row → catalogue default
 *   automationSetting(...)                   the same, with the effective config
 *   actedRecently(...)                       rate limit from the automation's system audit entries
 *
 * Every automatic action is recorded with common/audit.ts `auditSystem()` (metadata.automation = key).
 */
export const automationModule = defineModule({ name: 'automation', api: automationRouter });

export { AUTOMATIONS, type AutomationKey } from './catalogue.ts';
export { actedRecently, automationEnabled, automationSetting, automationSettingsForSites } from './repo.ts';
