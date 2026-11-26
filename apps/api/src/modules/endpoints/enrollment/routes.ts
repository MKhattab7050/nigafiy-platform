import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { endpointCreateSchema, phoneRoleSchema } from '../schema.ts';
import { createEndpoint, reissueEnrollmentToken, revokeEndpoint, setPhoneRole } from './service.ts';
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

/** Admin phone or regular user's phone (Android only; docs/roadmap/2026-11-26-admin-phones.md). */
enrollmentRouter.post('/endpoints/:id/phone-role', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { role } = parse(phoneRoleSchema, req.body);
  res.json({ endpoint: await setPhoneRole(req, ctx, id, role) });
});

enrollmentRouter.post('/endpoints/:id/revoke', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await revokeEndpoint(req, ctx, id);
  res.json({ ok: true });
});
