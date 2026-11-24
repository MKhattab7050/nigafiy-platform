import { Router } from 'express';
import { z } from 'zod';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { cancelJob, createJob, getJob, listJobs, pauseJob, rerunFailed, resultOutput, runJobNow } from './jobs.ts';
import { jobCreateSchema, jobListQuery, jobPauseSchema, outputParams, outputQuery, scriptCreateSchema, scriptListQuery, scriptPatchSchema } from './schema.ts';
import { archiveScript, createScript, getScript, getScriptVersion, listScripts, updateScript } from './scripts.ts';

/**
 * Fleet Pro: scripts library and jobs (migration 042).
 *   GET    /fleet/scripts                       technician+ (technicians: scripts runnable by technicians)
 *   GET    /fleet/scripts/:id                   technician+ (with its versions)
 *   GET    /fleet/scripts/:id/versions/:v       technician+
 *   POST   /fleet/scripts                       admin
 *   PATCH  /fleet/scripts/:id                   admin   (body, parameters or timeout: a new version)
 *   POST   /fleet/scripts/:id/archive|restore   admin
 *   GET    /fleet/jobs                          technician+
 *   POST   /fleet/jobs                          technician+ (technicians: runnable scripts only)
 *   GET    /fleet/jobs/:id                      technician+
 *   POST   /fleet/jobs/:id/run-now|rerun|cancel technician+ (admins, or the technician who created it)
 *   POST   /fleet/jobs/:id/pause                technician+ (same)
 *   GET    /fleet/jobs/:id/results/:resultId/output?stream=stdout|stderr   the full copy
 */
export const fleetJobsRouter: Router = Router();

fleetJobsRouter.get('/fleet/scripts', requireRole('technician'), async (req, res) => {
  res.json({ scripts: await listScripts(auth(req), parse(scriptListQuery, req.query)) });
});

fleetJobsRouter.get('/fleet/scripts/:id', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await getScript(auth(req), id));
});

fleetJobsRouter.get('/fleet/scripts/:id/versions/:version', requireRole('technician'), async (req, res) => {
  const { id, version } = parse(z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) }), req.params);
  res.json(await getScriptVersion(auth(req), id, version));
});

fleetJobsRouter.post('/fleet/scripts', requireRole('admin'), async (req, res) => {
  res.status(201).json(await createScript(req, auth(req), parse(scriptCreateSchema, req.body)));
});

fleetJobsRouter.patch('/fleet/scripts/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await updateScript(req, auth(req), id, parse(scriptPatchSchema, req.body)));
});

fleetJobsRouter.post('/fleet/scripts/:id/archive', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await archiveScript(req, auth(req), id, true));
});

fleetJobsRouter.post('/fleet/scripts/:id/restore', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await archiveScript(req, auth(req), id, false));
});

fleetJobsRouter.get('/fleet/jobs', requireRole('technician'), async (req, res) => {
  res.json({ jobs: await listJobs(auth(req), parse(jobListQuery, req.query)) });
});

fleetJobsRouter.post('/fleet/jobs', requireRole('technician'), async (req, res) => {
  res.status(201).json(await createJob(req, auth(req), parse(jobCreateSchema, req.body)));
});

fleetJobsRouter.get('/fleet/jobs/:id', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await getJob(auth(req), id));
});

fleetJobsRouter.post('/fleet/jobs/:id/run-now', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.status(201).json(await runJobNow(req, auth(req), id));
});

fleetJobsRouter.post('/fleet/jobs/:id/rerun', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ run_id: z.uuid().optional() }).strict(), req.body ?? {});
  res.status(201).json(await rerunFailed(req, auth(req), id, body.run_id));
});

fleetJobsRouter.post('/fleet/jobs/:id/pause', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await pauseJob(req, auth(req), id, parse(jobPauseSchema, req.body).paused));
});

fleetJobsRouter.post('/fleet/jobs/:id/cancel', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await cancelJob(req, auth(req), id));
});

fleetJobsRouter.get('/fleet/jobs/:id/results/:resultId/output', requireRole('technician'), async (req, res) => {
  const { id, resultId } = parse(outputParams, req.params);
  const { stream } = parse(outputQuery, req.query);
  const out = await resultOutput(req, auth(req), id, resultId, stream);
  const safe = out.endpointName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'computer';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-${stream}.txt"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(out.text);
});
