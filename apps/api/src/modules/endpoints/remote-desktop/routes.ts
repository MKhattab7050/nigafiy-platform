import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import {
  participantInviteSchema,
  participantJoinSchema,
  participantParams,
  printAuditSchema,
  rdStartSchema,
  recordingListQuery,
  recordingSegmentParams,
  recordingToggleSchema,
  sessionListQuery,
  transferAuditSchema,
  wakeCreateSchema,
  wakeParams,
} from './schema.ts';
import { getSessionStatus, listSessions, startSession, stopSession } from './service.ts';
import {
  auditPrint,
  auditTransfer,
  cancelWake,
  declineInvite,
  deleteRecording,
  getRecording,
  handOver,
  inviteParticipant,
  joinSession,
  leaveSession,
  listParticipants,
  listRecordings,
  playbackSegment,
  removeParticipant,
  requestWake,
  setRecording,
  wakeStatus,
} from './session-tools.ts';

/**
 * Remote desktop sessions (technician):
 *   POST /endpoints/:id/remote-desktop/start | stop
 *   GET  /endpoints/:id/remote-desktop/session   current session, consent state, live stream
 *   GET  /fleet/sessions                         session history (fleet_sessions)
 * The live picture travels over the WebSocket of stream-hub.ts.
 *
 * In-session tools (migration 036, session-tools.ts):
 *   POST /endpoints/:id/remote-desktop/recording {on}       start / stop recording
 *   GET  /fleet/recordings, /fleet/recordings/:id            list, detail with the audit timeline
 *   GET  /fleet/recordings/:id/segments/:name                decrypted segment for the player
 *   DELETE /fleet/recordings/:id                             admin
 *   GET|POST /endpoints/:id/remote-desktop/participants      list / invite a colleague
 *   POST .../participants/join | leave | decline             the invited colleague
 *   POST .../participants/:userId/remove | handover          the holder or an admin
 *   GET|POST /endpoints/:id/remote-desktop/wake, POST .../wake/:wakeId/cancel
 *   POST /endpoints/:id/remote-desktop/print | transfer      audit of printing and file transfers
 */
export const remoteDesktopRouter: Router = Router();

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/start', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(rdStartSchema, req.body ?? {});
  res.json(await startSession(req, ctx, id, body));
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/stop', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await stopSession(req, ctx, id);
  res.json({ ok: true });
});

remoteDesktopRouter.get('/endpoints/:id/remote-desktop/session', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await getSessionStatus(ctx, id));
});

remoteDesktopRouter.get('/fleet/sessions', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const q = parse(sessionListQuery, req.query);
  res.json({ sessions: await listSessions(ctx, q) });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/recording', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { on } = parse(recordingToggleSchema, req.body ?? {});
  res.json(await setRecording(req, ctx, id, on));
});

remoteDesktopRouter.get('/fleet/recordings', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  res.json({ recordings: await listRecordings(ctx, parse(recordingListQuery, req.query)) });
});

remoteDesktopRouter.get('/fleet/recordings/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await getRecording(req, ctx, id));
});

remoteDesktopRouter.get('/fleet/recordings/:id/segments/:name', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id, name } = parse(recordingSegmentParams, req.params);
  const out = await playbackSegment(ctx, id, name);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Nigafiy-Records', String(out.records));
  if (out.error) res.setHeader('X-Nigafiy-Segment-Error', out.error);
  res.send(out.body);
});

remoteDesktopRouter.delete('/fleet/recordings/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await deleteRecording(req, ctx, id);
  res.json({ ok: true });
});

remoteDesktopRouter.get('/endpoints/:id/remote-desktop/participants', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json({ participants: await listParticipants(ctx, id) });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/participants', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json({ participant: await inviteParticipant(req, ctx, id, parse(participantInviteSchema, req.body ?? {})) });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/participants/join', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(participantJoinSchema, req.body ?? {});
  res.json({ participant: await joinSession(req, ctx, id, body.step_up_token) });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/participants/leave', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await leaveSession(req, ctx, id);
  res.json({ ok: true });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/participants/decline', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await declineInvite(req, ctx, id);
  res.json({ ok: true });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/participants/:userId/remove', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id, userId } = parse(participantParams, req.params);
  await removeParticipant(req, ctx, id, userId);
  res.json({ ok: true });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/participants/:userId/handover', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id, userId } = parse(participantParams, req.params);
  res.json({ session: await handOver(req, ctx, id, userId) });
});

remoteDesktopRouter.get('/endpoints/:id/remote-desktop/wake', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json({ wake: await wakeStatus(ctx, id) });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/wake', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json({ wake: await requestWake(req, ctx, id, parse(wakeCreateSchema, req.body ?? {})) });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/wake/:wakeId/cancel', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id, wakeId } = parse(wakeParams, req.params);
  await cancelWake(req, ctx, id, wakeId);
  res.json({ ok: true });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/print', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await auditPrint(req, ctx, id, parse(printAuditSchema, req.body ?? {}));
  res.json({ ok: true });
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/transfer', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await auditTransfer(req, ctx, id, parse(transferAuditSchema, req.body ?? {}));
  res.json({ ok: true });
});
