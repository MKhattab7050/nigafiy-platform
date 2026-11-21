import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { endpointCreateSchema } from '../schema.ts';
import { createEndpoint, reissueEnrollmentToken, revokeEndpoint } from './service.ts';
import { enrollmentSuggestion } from './suggest.ts';

/** Enrollment lifecycle (admin): POST /endpoints, POST /endpoints/:id/enrollment-token, POST /endpoints/:id/revoke. */
export const enrollmentRouter: Router = Router();

enrollmentRouter.post('/endpoints', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(endpointCreateSchema, req.body);
  res.status(201).json(await createEndpoint(req, ctx, body));
});

enrollmentRouter.post('/endpoints/:id/enrollment-token', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await reissueEnrollmentToken(req, ctx, id));
});

/**
 * Pre-fill for enrolling a discovered device as an endpoint: suggested name and agent platform
 * (labelled inferred / default) and the server URL for the install command. Enrolling itself stays POST /endpoints.
 */
enrollmentRouter.get('/devices/:id/enrollment-suggestion', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await enrollmentSuggestion(req, ctx, id));
});

enrollmentRouter.post('/endpoints/:id/revoke', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await revokeEndpoint(req, ctx, id);
  res.json({ ok: true });
});
