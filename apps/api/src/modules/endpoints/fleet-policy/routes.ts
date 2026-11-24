import { Router } from 'express';
import { z } from 'zod';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { approveSession, denySession, listApprovals } from './approvals.ts';
import { assignEndpoints, createGroup, deleteGroup, listGroups, updateGroup } from './groups.ts';
import { policyPreview } from './preview.ts';
import { createProfile, deleteProfile, listProfiles, updateProfile } from './profiles.ts';
import { approvalDecisionSchema, approvalListQuery, groupAssignSchema, groupCreateSchema, groupPatchSchema, profileCreateSchema, profilePatchSchema, stepUpSchema } from './schema.ts';
import { stepUp } from './step-up.ts';

/**
 * Fleet permission profiles, groups, access policy, MFA step-up and approvals:
 *   GET    /fleet/profiles                      technician+ (the connect dialog lists them)
 *   POST   /fleet/profiles | PATCH|DELETE /fleet/profiles/:id          admin
 *   GET    /fleet/groups                        technician+
 *   POST   /fleet/groups | PATCH|DELETE /fleet/groups/:id              admin (the policy lives on the group)
 *   POST   /fleet/groups/assign                 admin (bulk: endpoint_ids → a group or none)
 *   GET    /endpoints/:id/remote-desktop/policy technician+ (what the connect dialog needs)
 *   POST   /fleet/step-up                       technician+ (TOTP → short-lived step-up token)
 *   GET    /fleet/approvals                     admin
 *   POST   /fleet/approvals/:id/approve | deny  admin, never the requester
 */
export const fleetPolicyRouter: Router = Router();

fleetPolicyRouter.get('/fleet/profiles', requireRole('technician'), async (req, res) => {
  res.json({ profiles: await listProfiles(auth(req)) });
});

fleetPolicyRouter.post('/fleet/profiles', requireRole('admin'), async (req, res) => {
  const body = parse(profileCreateSchema, req.body ?? {});
  res.status(201).json({ profile: await createProfile(req, auth(req), body) });
});

fleetPolicyRouter.patch('/fleet/profiles/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(profilePatchSchema, req.body ?? {});
  res.json({ profile: await updateProfile(req, auth(req), id, body) });
});

fleetPolicyRouter.delete('/fleet/profiles/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await deleteProfile(req, auth(req), id);
  res.json({ ok: true });
});

fleetPolicyRouter.get('/fleet/groups', requireRole('technician'), async (req, res) => {
  res.json({ groups: await listGroups(auth(req)) });
});

fleetPolicyRouter.post('/fleet/groups/assign', requireRole('admin'), async (req, res) => {
  const body = parse(groupAssignSchema, req.body ?? {});
  res.json(await assignEndpoints(req, auth(req), body.endpoint_ids, body.fleet_group_id));
});

fleetPolicyRouter.post('/fleet/groups', requireRole('admin'), async (req, res) => {
  const body = parse(groupCreateSchema, req.body ?? {});
  res.status(201).json({ group: await createGroup(req, auth(req), body) });
});

fleetPolicyRouter.patch('/fleet/groups/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(groupPatchSchema, req.body ?? {});
  res.json({ group: await updateGroup(req, auth(req), id, body) });
});

fleetPolicyRouter.delete('/fleet/groups/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await deleteGroup(req, auth(req), id);
  res.json({ ok: true });
});

fleetPolicyRouter.get('/endpoints/:id/remote-desktop/policy', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await policyPreview(req, auth(req), id));
});

fleetPolicyRouter.post('/fleet/step-up', requireRole('technician'), async (req, res) => {
  const body = parse(stepUpSchema, req.body ?? {});
  res.json(await stepUp(req, auth(req), body.code));
});

fleetPolicyRouter.get('/fleet/approvals', requireRole('admin'), async (req, res) => {
  const q = parse(approvalListQuery, req.query);
  res.json({ approvals: await listApprovals(auth(req), q.state, q.limit) });
});

const decisionParams = z.object({ id: z.uuid(), decision: z.enum(['approve', 'deny']) });

fleetPolicyRouter.post('/fleet/approvals/:id/:decision', requireRole('admin'), async (req, res) => {
  const { id, decision } = parse(decisionParams, req.params);
  const body = parse(approvalDecisionSchema, req.body ?? {});
  if (decision === 'approve') {
    res.json({ ok: true, ...(await approveSession(req, auth(req), id, body.note)) });
  } else {
    await denySession(req, auth(req), id, body.note);
    res.json({ ok: true });
  }
});
