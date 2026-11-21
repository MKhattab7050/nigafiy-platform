import { Router } from 'express';
import { auth, parse, requireRole } from '../../common/http.ts';
import { automationKeyParams, automationListQuery, automationPutBody, automationResetQuery } from './schema.ts';
import { listAutomations, resetAutomation, setAutomation } from './service.ts';

/** GET /automation (any role), PUT /automation/:key and DELETE /automation/:key (admin). */
export const automationRouter: Router = Router();

automationRouter.get('/automation', async (req, res) => {
  const ctx = auth(req);
  const q = parse(automationListQuery, req.query);
  res.json(await listAutomations(ctx.organizationId, q.site_id ?? null));
});

automationRouter.put('/automation/:key', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { key } = parse(automationKeyParams, req.params);
  const body = parse(automationPutBody, req.body);
  res.json(await setAutomation(req, ctx, key, body));
});

automationRouter.delete('/automation/:key', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { key } = parse(automationKeyParams, req.params);
  const q = parse(automationResetQuery, req.query);
  res.json(await resetAutomation(req, ctx, key, q.site_id ?? null));
});
