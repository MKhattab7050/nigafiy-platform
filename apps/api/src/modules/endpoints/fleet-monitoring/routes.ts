import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { createRule, deleteRule, listRules, listStates, updateRule } from './rules.ts';
import { monitorRuleSchema, monitorStatesQuery } from './schema.ts';

/**
 * Fleet Pro: monitoring rules for managed computers (migration 043).
 *   GET    /fleet/monitoring/rules        viewer+
 *   POST   /fleet/monitoring/rules        admin
 *   PUT    /fleet/monitoring/rules/:id    admin (the whole rule; open alerts of the old rule are resolved)
 *   DELETE /fleet/monitoring/rules/:id    admin
 *   GET    /fleet/monitoring/states       viewer+ (?breaching=1, ?endpoint_id=)
 */
export const fleetMonitoringRouter: Router = Router();

fleetMonitoringRouter.get('/fleet/monitoring/rules', requireRole('viewer'), async (req, res) => {
  res.json({ rules: await listRules(auth(req)) });
});

fleetMonitoringRouter.post('/fleet/monitoring/rules', requireRole('admin'), async (req, res) => {
  res.status(201).json(await createRule(req, auth(req), parse(monitorRuleSchema, req.body)));
});

fleetMonitoringRouter.put('/fleet/monitoring/rules/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await updateRule(req, auth(req), id, parse(monitorRuleSchema, req.body)));
});

fleetMonitoringRouter.delete('/fleet/monitoring/rules/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await deleteRule(req, auth(req), id);
  res.status(204).end();
});

fleetMonitoringRouter.get('/fleet/monitoring/states', requireRole('viewer'), async (req, res) => {
  res.json({ states: await listStates(auth(req), parse(monitorStatesQuery, req.query)) });
});
