import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../common/http.ts';
import { deviceActivity, pauseDevice, setDeviceAccess } from './services/devices.ts';
import { createProfile, deleteProfile, pauseProfile, updateProfile } from './services/profiles.ts';
import {
  activityQuery,
  deviceAccessBody,
  pauseBody,
  pauseUntil,
  profileBody,
  profilePatchBody,
  settingsBody,
  siteQuery,
} from './schema.ts';
import { getSiteAccess, updateSettings } from './services/settings.ts';

export const accessRouter: Router = Router();

// ── settings ────────────────────────────────────────────────────────────────

accessRouter.get('/access', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(siteQuery, req.query);
  res.json(await getSiteAccess(ctx.organizationId, site_id));
});

accessRouter.put('/access/settings', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(settingsBody, req.body);
  await updateSettings(req, ctx, body);
  res.json({ ok: true });
});

// ── profiles ────────────────────────────────────────────────────────────────

accessRouter.post('/access/profiles', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(siteQuery, req.query);
  const body = parse(profileBody, req.body);
  res.status(201).json(await createProfile(req, ctx, site_id, body));
});

accessRouter.patch('/access/profiles/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(profilePatchBody, req.body);
  await updateProfile(req, ctx, id, body);
  res.json({ ok: true });
});

accessRouter.delete('/access/profiles/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await deleteProfile(req, ctx, id);
  res.status(204).end();
});

// ── pause ───────────────────────────────────────────────────────────────────

accessRouter.post('/access/profiles/:id/pause', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { minutes } = parse(pauseBody, req.body);
  const until = pauseUntil(minutes, new Date());
  await pauseProfile(req, ctx, id, minutes, until);
  res.json({ paused_until: until });
});

accessRouter.post('/devices/:id/pause', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { minutes } = parse(pauseBody, req.body);
  const until = pauseUntil(minutes, new Date());
  await pauseDevice(req, ctx, id, minutes, until);
  res.json({ paused_until: until });
});

// ── per-device rules ────────────────────────────────────────────────────────

accessRouter.patch('/devices/:id/access', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(deviceAccessBody, req.body);
  await setDeviceAccess(req, ctx, id, body);
  res.json({ ok: true });
});

// ── activity ────────────────────────────────────────────────────────────────

accessRouter.get('/devices/:id/activity', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { hours } = parse(activityQuery, req.query);
  res.json(await deviceActivity(ctx.organizationId, id, hours));
});
