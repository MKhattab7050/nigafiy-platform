import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { auth, idParams, parse, requireRole } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { listRestores, requestRestore, restorePreview, restoreStatus } from './restore.ts';
import {
  credentialsUpdateSchema,
  diffQuery,
  hostKeyAcceptSchema,
  listQuery,
  probeSchema,
  restorePreviewQuery,
  restoreRequestSchema,
  targetPatchSchema,
  targetsCreateSchema,
  versionsQuery,
} from './schema.ts';
import {
  acceptHostKey,
  addTargets,
  diffVersions,
  downloadVersion,
  listTargets,
  listVersions,
  loadTarget,
  present,
  probeStatus,
  removeTarget,
  requestProbe,
  runNow,
  runStatus,
  setCredentials,
  suggestions,
  targetDetail,
  updateTarget,
  versionContent,
} from './service.ts';

// Roles: anyone in the organization sees the devices, their status and the version timeline;
// technicians start a backup or an SSH check; administrators add / change devices, set credentials,
// decide about host keys, and are the only ones who read configuration content (it holds secrets)
// or restore a configuration to a device (typed device name + reason; restore.ts).

export const configBackupRouter: Router = Router();

const attachment = (name: string) => `attachment; filename="${name.replace(/["\\]/g, '_')}"`;

configBackupRouter.get('/config-backup/targets', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(listQuery, req.query);
  res.json({ items: await listTargets(ctx.organizationId, site_id) });
});

configBackupRouter.post('/config-backup/targets', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  res.status(201).json(await addTargets(req, ctx, parse(targetsCreateSchema, req.body)));
});

configBackupRouter.get('/config-backup/suggestions', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(z.object({ site_id: z.uuid() }), req.query);
  res.json(await suggestions(ctx.organizationId, site_id));
});

configBackupRouter.post('/config-backup/probe', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(probeSchema, req.body);
  res.status(202).json(await requestProbe(req, ctx, site_id));
});

configBackupRouter.get('/config-backup/probes/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await probeStatus(ctx.organizationId, id));
});

configBackupRouter.get('/config-backup/targets/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await targetDetail(ctx.organizationId, id));
});

configBackupRouter.patch('/config-backup/targets/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await updateTarget(req, ctx, id, parse(targetPatchSchema, req.body)));
});

configBackupRouter.delete('/config-backup/targets/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await removeTarget(req, ctx, id);
  res.status(204).end();
});

configBackupRouter.put('/config-backup/targets/:id/credentials', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await setCredentials(req, ctx, id, parse(credentialsUpdateSchema, req.body)));
});

configBackupRouter.post('/config-backup/targets/:id/run', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.status(202).json(await runNow(req, ctx, id));
});

configBackupRouter.post('/config-backup/targets/:id/host-key/accept', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { sha256 } = parse(hostKeyAcceptSchema, req.body);
  res.json(await acceptHostKey(req, ctx, id, sha256));
});

/**
 * Forget the pinned key (the next backup pins whatever key the device presents). For the case where the
 * device no longer offers the pinned key type at all, so there is no fingerprint to accept. Explicit and audited.
 */
configBackupRouter.post('/config-backup/targets/:id/host-key/forget', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  parse(z.object({ confirm: z.literal(true) }).strict(), req.body);
  res.json(
    await withTenant(ctx.organizationId, async (db) => {
      const t = await loadTarget(db, id, true);
      await db.query(
        `UPDATE config_backup_targets SET host_key_sha256 = NULL, host_key_type = NULL, host_key_pinned_at = NULL, host_key_pinned_via = NULL,
                host_key_status = 'none', presented_host_key = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      await audit(db, req, 'config_backup.host_key.forget', { type: 'config_backup_target', id }, { previous: t.host_key_sha256 });
      await notifyRealtime(db, ctx.organizationId, 'devices');
      return present(await loadTarget(db, id));
    }),
  );
});

configBackupRouter.get('/config-backup/runs/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await runStatus(ctx.organizationId, id));
});

configBackupRouter.get('/config-backup/targets/:id/versions', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { limit } = parse(versionsQuery, req.query);
  res.json(await listVersions(ctx.organizationId, id, limit));
});

configBackupRouter.get('/config-backup/targets/:id/diff', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const q = parse(diffQuery.extend({ format: z.enum(['json', 'unified']).default('json') }), req.query);
  if (q.format === 'unified') {
    const out = (await diffVersions(req, ctx, id, q.from, q.to, q.context, true)) as { filename: string; text: string };
    res.setHeader('Content-Type', 'text/x-diff; charset=utf-8');
    res.setHeader('Content-Disposition', attachment(out.filename));
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.text);
    return;
  }
  res.json(await diffVersions(req, ctx, id, q.from, q.to, q.context));
});

configBackupRouter.get('/config-backup/versions/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await versionContent(req, ctx, id));
});

configBackupRouter.get('/config-backup/versions/:id/download', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const out = await downloadVersion(req, ctx, id);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', attachment(out.filename));
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.text);
});

// ── restore (restore.ts) ──

configBackupRouter.get('/config-backup/targets/:id/restore-preview', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { version_id } = parse(restorePreviewQuery, req.query);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await restorePreview(req, ctx, id, version_id));
});

configBackupRouter.post('/config-backup/targets/:id/restore', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.status(202).json(await requestRestore(req, ctx, id, parse(restoreRequestSchema, req.body)));
});

configBackupRouter.get('/config-backup/targets/:id/restores', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await listRestores(ctx.organizationId, id));
});

configBackupRouter.get('/config-backup/restores/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await restoreStatus(ctx.organizationId, id));
});
