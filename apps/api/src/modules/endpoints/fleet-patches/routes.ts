import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { groupIdParams, patchApprovalSchema, patchInstallsQuery, patchPolicySchema } from './schema.ts';
import { cancelInstall, catalog, deleteApproval, deleteGroupPolicy, endpointPatches, listInstalls, listPolicies, putPolicy, requestScan, setApproval } from './service.ts';

/**
 * Fleet Pro: patches (migration 043).
 *   GET    /fleet/patches/catalog                  viewer+  updates missing across the fleet, with decisions
 *   GET    /fleet/patches/policies                 viewer+
 *   PUT    /fleet/patches/policies                 admin    organization default (fleet_group_id null) or a group's
 *   DELETE /fleet/patches/policies/group/:groupId  admin    the group follows the organization default again
 *   POST   /fleet/patches/approvals                admin    approve / decline one update (all groups or one)
 *   DELETE /fleet/patches/approvals/:id            admin
 *   GET    /fleet/patches/installs                 viewer+  (?endpoint_id=, ?open=1)
 *   POST   /fleet/patches/installs/:id/cancel      admin    only before the agent took it
 *   GET    /endpoints/:id/patches                  viewer+  status, effective policy, history
 *   POST   /endpoints/:id/patches/scan             technician+
 */
export const fleetPatchesRouter: Router = Router();

fleetPatchesRouter.get('/fleet/patches/catalog', requireRole('viewer'), async (req, res) => {
  res.json(await catalog(auth(req)));
});

fleetPatchesRouter.get('/fleet/patches/policies', requireRole('viewer'), async (req, res) => {
  res.json(await listPolicies(auth(req)));
});

fleetPatchesRouter.put('/fleet/patches/policies', requireRole('admin'), async (req, res) => {
  res.json(await putPolicy(req, auth(req), parse(patchPolicySchema, req.body)));
});

fleetPatchesRouter.delete('/fleet/patches/policies/group/:groupId', requireRole('admin'), async (req, res) => {
  await deleteGroupPolicy(req, auth(req), parse(groupIdParams, req.params).groupId);
  res.status(204).end();
});

fleetPatchesRouter.post('/fleet/patches/approvals', requireRole('admin'), async (req, res) => {
  res.status(201).json(await setApproval(req, auth(req), parse(patchApprovalSchema, req.body)));
});

fleetPatchesRouter.delete('/fleet/patches/approvals/:id', requireRole('admin'), async (req, res) => {
  await deleteApproval(req, auth(req), parse(idParams, req.params).id);
  res.status(204).end();
});

fleetPatchesRouter.get('/fleet/patches/installs', requireRole('viewer'), async (req, res) => {
  res.json({ installs: await listInstalls(auth(req), parse(patchInstallsQuery, req.query)) });
});

fleetPatchesRouter.post('/fleet/patches/installs/:id/cancel', requireRole('admin'), async (req, res) => {
  res.json(await cancelInstall(req, auth(req), parse(idParams, req.params).id));
});

fleetPatchesRouter.get('/endpoints/:id/patches', requireRole('viewer'), async (req, res) => {
  res.json(await endpointPatches(auth(req), parse(idParams, req.params).id));
});

fleetPatchesRouter.post('/endpoints/:id/patches/scan', requireRole('technician'), async (req, res) => {
  res.status(202).json(await requestScan(req, auth(req), parse(idParams, req.params).id));
});
