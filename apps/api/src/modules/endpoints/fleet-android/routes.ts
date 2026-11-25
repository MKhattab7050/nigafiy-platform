import { existsSync, createReadStream } from 'node:fs';
import express, { Router } from 'express';
import { z } from 'zod';
import { AppError, auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { requireEndpointAgent } from '../agent/auth.ts';
import { approveAndroidRequest, denyAndroidRequest, endpointAndroidRequests, listAndroidRequests, performAndroidAction } from './actions.ts';
import { MAX_APK_BYTES, agentApk, deleteApk, listApks, uploadApk } from './apks.ts';
import { agentApkDigest, androidApkPath, provisioningInfo } from './provisioning.ts';
import { androidActionSchema, androidRequestDecisionSchema, androidRequestListQuery, apkUploadQuery } from './schema.ts';

/**
 * Android phones (docs/features/android.md):
 *   POST   /endpoints/:id/android/actions        technician+ (some actions admin; policy, MFA, approvals in actions.ts)
 *   GET    /endpoints/:id/android/requests       technician+
 *   GET    /fleet/android/requests               admin
 *   POST   /fleet/android/requests/:id/approve | deny   admin, never the requester
 *   GET    /fleet/android/apks                   technician+
 *   POST   /fleet/android/apks?name=&file_name=  admin (body: the APK, ≤ 100 MiB)
 *   DELETE /fleet/android/apks/:id               admin
 *   GET    /fleet/android/provisioning           admin (what the enrollment QR codes need)
 */
export const fleetAndroidRouter: Router = Router();

fleetAndroidRouter.post('/endpoints/:id/android/actions', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(androidActionSchema, req.body ?? {});
  const result = await performAndroidAction(req, auth(req), id, body);
  res.status(result.state === 'queued' ? 202 : 201).json(result);
});

fleetAndroidRouter.get('/endpoints/:id/android/requests', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ requests: await endpointAndroidRequests(auth(req), id) });
});

fleetAndroidRouter.get('/fleet/android/requests', requireRole('admin'), async (req, res) => {
  const q = parse(androidRequestListQuery, req.query);
  res.json({ requests: await listAndroidRequests(auth(req), q.state, q.limit) });
});

const decisionParams = z.object({ id: z.uuid(), decision: z.enum(['approve', 'deny']) });

fleetAndroidRouter.post('/fleet/android/requests/:id/:decision', requireRole('admin'), async (req, res) => {
  const { id, decision } = parse(decisionParams, req.params);
  const body = parse(androidRequestDecisionSchema, req.body ?? {});
  if (decision === 'approve') {
    res.json({ ok: true, ...(await approveAndroidRequest(req, auth(req), id, body.note)) });
  } else {
    await denyAndroidRequest(req, auth(req), id, body.note);
    res.json({ ok: true });
  }
});

fleetAndroidRouter.get('/fleet/android/apks', requireRole('technician'), async (req, res) => {
  res.json({ apks: await listApks(auth(req)) });
});

const apkBody = express.raw({ type: ['application/vnd.android.package-archive', 'application/octet-stream'], limit: MAX_APK_BYTES });

fleetAndroidRouter.post('/fleet/android/apks', requireRole('admin'), apkBody, async (req, res) => {
  const meta = parse(apkUploadQuery, req.query);
  res.status(201).json({ apk: await uploadApk(req, auth(req), meta, req.body as Buffer) });
});

fleetAndroidRouter.delete('/fleet/android/apks/:id', requireRole('admin'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await deleteApk(req, auth(req), id);
  res.json({ ok: true });
});

fleetAndroidRouter.get('/fleet/android/provisioning', requireRole('admin'), (req, res) => {
  res.json(provisioningInfo(req));
});

/** Agent gateway additions (mounted on /api/v1/agent). */
export const androidGatewayRouter: Router = Router();

// The Nigafiy agent APK for Device Owner QR provisioning: the setup wizard of a factory-reset phone
// downloads it before any credential exists, and checks it against the SHA-256 in the QR code. The
// file is the public app, nothing secret.
androidGatewayRouter.get('/android/agent.apk', (_req, res) => {
  const file = androidApkPath();
  const digest = agentApkDigest();
  if (!digest || !existsSync(file)) throw new AppError(404, 'android_apk_not_built', 'The Nigafiy Android agent has not been built on this server (pnpm build:android, or set NIGAFIY_ANDROID_APK)');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Length', String(digest.size_bytes));
  res.setHeader('Content-Disposition', 'attachment; filename="nigafiy-agent.apk"');
  res.setHeader('X-Content-SHA256', digest.sha256);
  createReadStream(file).pipe(res);
});

// An APK pushed from Fleet, only for an open install command of this phone (apks.ts).
androidGatewayRouter.get('/android/apks/:id', requireEndpointAgent, async (req, res) => {
  const { id } = parse(idParams, req.params);
  const apk = await agentApk(req.endpoint!, id);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Length', String(apk.bytes.length));
  res.setHeader('X-Content-SHA256', apk.sha256);
  res.end(apk.bytes);
});
