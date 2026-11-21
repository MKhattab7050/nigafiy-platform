import { defineModule } from '../../infrastructure/module.ts';
import { LIMITS } from './catalog.ts';
import { playbooksRouter } from './routes.ts';
import { playbookTick } from './triggers.ts';

/**
 * Playbooks: multi-step workflow automation with approval gates (Phase 5).
 *
 *   catalog.ts    the closed list of triggers, actions and condition tests
 *   schema.ts     validation of playbooks, steps and decisions
 *   templates.ts  built-in templates (one click → an ordinary, disabled playbook)
 *   triggers.ts   event / incident / schedule matching (idempotent trigger keys, loop guard, rate limit)
 *   engine.ts     the durable run engine: ordered steps, approval gates, conditions, waits, timeouts
 *   actions.ts    one executor per action, through the owning module's own service
 *   notify.ts     approval requests to administrators
 *
 * The `playbook-engine` job advances every due run; because all state is in the database, runs
 * resume after an API restart.
 */
export const playbooksModule = defineModule({
  name: 'playbooks',
  api: playbooksRouter,
  jobs: [{ name: 'playbook-engine', everyMs: LIMITS.pollEverySeconds * 1000, lockKey: 727140, run: () => playbookTick() }],
});

export { playbookTick } from './triggers.ts';
