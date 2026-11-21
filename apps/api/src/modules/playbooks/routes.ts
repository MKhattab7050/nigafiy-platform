import { Router } from 'express';
import { z } from 'zod';
import { auth, idParams, parse, requireRole } from '../../common/http.ts';
import { approvalsQuery, decisionSchema, fromTemplateSchema, listQuery, playbookCreateSchema, playbookPatchSchema, runNowSchema, runsQuery, settingsSchema } from './schema.ts';
import {
  cancelRun,
  catalog,
  createFromTemplate,
  createPlaybook,
  decide,
  deletePlaybook,
  getPlaybook,
  getRun,
  getSettings,
  listApprovals,
  listPlaybooks,
  listRuns,
  putSettings,
  runNow,
  updatePlaybook,
} from './service.ts';

/**
 * Playbooks. Reading: any role. Writing playbooks and settings, approving/rejecting: administrator.
 * Running a playbook by hand: technician (its disruptive steps still wait for an administrator).
 * Cancelling a run: an administrator, or the person who started it.
 */
export const playbooksRouter: Router = Router();

const stepParams = z.object({ id: z.uuid(), stepId: z.uuid() });
const cancelBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();

// Static paths first (they would otherwise match /playbooks/:id).
playbooksRouter.get('/playbooks/catalog', (_req, res) => {
  res.json(catalog());
});

playbooksRouter.get('/playbooks/settings', async (req, res) => {
  res.json(await getSettings(auth(req).organizationId));
});

playbooksRouter.put('/playbooks/settings', requireRole('admin'), async (req, res) => {
  res.json(await putSettings(req, auth(req), parse(settingsSchema, req.body)));
});

playbooksRouter.post('/playbooks/from-template', requireRole('admin'), async (req, res) => {
  const body = parse(fromTemplateSchema, req.body);
  res.status(201).json(await createFromTemplate(req, auth(req), body.template, body.site_id));
});

playbooksRouter.get('/playbooks', async (req, res) => {
  const q = parse(listQuery, req.query);
  res.json(await listPlaybooks(auth(req).organizationId, q.site_id ?? null));
});

playbooksRouter.post('/playbooks', requireRole('admin'), async (req, res) => {
  res.status(201).json(await createPlaybook(req, auth(req), parse(playbookCreateSchema, req.body)));
});

playbooksRouter.get('/playbooks/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await getPlaybook(auth(req).organizationId, id));
});

playbooksRouter.patch('/playbooks/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await updatePlaybook(req, auth(req), id, parse(playbookPatchSchema, req.body)));
});

playbooksRouter.delete('/playbooks/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await deletePlaybook(req, auth(req), id);
  res.status(204).end();
});

playbooksRouter.post('/playbooks/:id/run', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.status(201).json(await runNow(req, auth(req), id, parse(runNowSchema, req.body ?? {})));
});

playbooksRouter.get('/playbook-runs', async (req, res) => {
  res.json(await listRuns(auth(req).organizationId, parse(runsQuery, req.query)));
});

playbooksRouter.get('/playbook-approvals', async (req, res) => {
  const q = parse(approvalsQuery, req.query);
  res.json(await listApprovals(auth(req), q.page_size));
});

playbooksRouter.get('/playbook-runs/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await getRun(auth(req), id));
});

playbooksRouter.post('/playbook-runs/:id/cancel', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(cancelBody, req.body ?? {});
  res.json(await cancelRun(req, auth(req), id, body.reason));
});

playbooksRouter.post('/playbook-runs/:id/steps/:stepId/decision', requireRole('admin'), async (req, res) => {
  const { id, stepId } = parse(stepParams, req.params);
  res.json(await decide(req, auth(req), id, stepId, parse(decisionSchema, req.body)));
});
