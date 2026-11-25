import { defineModule } from '../../infrastructure/module.ts';
import { CAPTURE_EVERY_MS, captureAllOrganizations } from './capture.ts';
import { knowledgeRouter } from './routes.ts';

/**
 * Knowledge memory: what fixed an incident before, and hand-written runbooks.
 *
 *   capture.ts   resolved incidents with a note or comments → pre-filled candidates (automation
 *                `suggest.knowledge_from_incidents`; the `knowledge-capture` job, every 15 s;
 *                GET routes never write)
 *   ranking.ts   deterministic similarity score with an explanation for every point
 *   suggest.ts   GET /knowledge/suggest?incident_id= | device_id= | rule=&site_id=
 *   routes.ts    list / detail / create / edit / publish / discard / restore / delete, votes, "fix used"
 */
export const knowledgeModule = defineModule({
  name: 'knowledge',
  api: knowledgeRouter,
  jobs: [{ name: 'knowledge-capture', everyMs: CAPTURE_EVERY_MS, lockKey: 727180, run: async () => void (await captureAllOrganizations()) }],
});

export { captureAllOrganizations, captureCandidates, syncCandidates } from './capture.ts';
export { rankEntries, scoreEntry } from './ranking.ts';
