import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { endpointPolicySchema } from '../schema.ts';
import { updatePolicy } from './service.ts';

/** Policy & compliance (admin): PATCH /endpoints/:id/policy. */
export const policyRouter: Router = Router();

policyRouter.patch('/endpoints/:id/policy', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(endpointPolicySchema, req.body);
  res.json({ policy: await updatePolicy(req, ctx, id, body) });
});
