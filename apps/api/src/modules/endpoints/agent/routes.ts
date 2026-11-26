import express, { Router } from 'express';
import { z } from 'zod';
import { endSessionByUser } from '../remote-desktop/service.ts';
import { rateLimit } from 'express-rate-limit';
import { AppError, parse } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';
import { logger } from '../../../infrastructure/logger.ts';
import { HEARTBEAT_INTERVAL_SECONDS } from '../repo.ts';
import { agentCommandResultsSchema, agentEnrollSchema, agentHeartbeatSchema, agentInventorySchema } from '../schema.ts';
import { requireEndpointAgent } from './auth.ts';
import { parsePollWaitMs } from './wake.ts';
import { enrollAgent, leaveFromDevice, longPollCommands, recordCommandResults, recordHeartbeat, recordInventory } from './service.ts';
import { limiterStore } from '../../../infrastructure/rate-limit.ts';
import { agentHelpRequestSchema, quickRegisterSchema } from '../fleet-reach/schema.ts';
import { createHelpRequest } from '../fleet-reach/help-requests.ts';
import { quickSupportClosedByUser, quickSupportStatus, registerQuickSupport } from '../fleet-reach/quick-support.ts';
import { agentShellEndSchema } from '../fleet-shell/schema.ts';
import { agentShellEnd, itActivity } from '../fleet-shell/shells.ts';
import { agentHardwareSchema, recordHardware } from '../fleet-inventory/hardware.ts';
import { agentPatchStatusSchema } from '../fleet-patches/schema.ts';
import { recordPatchStatus } from '../fleet-patches/service.ts';
import { agentRecordingLink, agentRecordings, recordingLinkSchema } from '../fleet-user/recordings.ts';
import { androidGatewayRouter } from '../fleet-android/routes.ts';

const quickRegisterLimiter = rateLimit({
  store: limiterStore('agent:quick-support'),
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many Quick Support registrations' } },
});

/** Agent-facing gateway, mounted at /api/v1/agent. Agents only ever make outbound HTTPS requests to it. */
export const agentGatewayRouter: Router = Router();

const enrollLimiter = rateLimit({
  store: limiterStore('agent:enroll'),
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many enrollment attempts' } },
});

agentGatewayRouter.use(express.json({ limit: '6mb' }));

agentGatewayRouter.post('/enroll', enrollLimiter, async (req, res) => {
  const body = parse(agentEnrollSchema, req.body);
  const enrolled = await enrollAgent(body);
  if (!enrolled) {
    logger.warn({ ip: req.ip }, 'rejected endpoint enrollment');
    throw new AppError(401, 'invalid_enrollment_token', 'Enrollment token is invalid, already used or expired');
  }
  res.status(201).json({
    endpoint_id: enrolled.endpoint.id,
    credential: `lda_${enrolled.endpoint.id}.${enrolled.secret}`,
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
  });
});

agentGatewayRouter.post('/heartbeat', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(agentHeartbeatSchema, req.body);
  res.json(await recordHeartbeat(ep, body));
});

// Command poll. `?wait_ms=` (≤ 25 s) makes it a long poll: the request is held until a command is
// queued for this endpoint (woken through pg_notify on any API instance, agent/wake.ts) or the wait
// ends. Without it the poll answers at once (older agents poll every 500 ms that way).
agentGatewayRouter.post('/poll', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const waitMs = parsePollWaitMs(req.query.wait_ms);
  const aborted = new AbortController();
  res.on('close', () => aborted.abort());
  const commands = await longPollCommands(ep, waitMs, aborted.signal);
  if (!aborted.signal.aborted) res.json({ commands });
});

// Immediate command result delivery endpoint.
agentGatewayRouter.post('/command-result', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(agentCommandResultsSchema, req.body);
  await recordCommandResults(ep, body.command_results);
  res.json({ ok: true });
});

agentGatewayRouter.post('/inventory', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(agentInventorySchema, req.body);
  await recordInventory(ep, body);
  res.json({ ok: true });
});

// Hardware and licence inventory (every 6 hours and on refresh): fleet-inventory/hardware.ts.
agentGatewayRouter.post('/hardware', requireEndpointAgent, async (req, res) => {
  await recordHardware(req.endpoint!, parse(agentHardwareSchema, req.body));
  res.json({ ok: true });
});

// Missing updates (every 6 hours, after an install, and on request): fleet-patches/service.ts.
agentGatewayRouter.post('/patch-status', requireEndpointAgent, async (req, res) => {
  await recordPatchStatus(req.endpoint!, parse(agentPatchStatusSchema, req.body));
  res.json({ ok: true });
});

// "Past recordings…" from the tray (only when the computer's group allows it): fleet-user/recordings.ts.
agentGatewayRouter.post('/recordings', requireEndpointAgent, async (req, res) => {
  res.json(await agentRecordings(req.endpoint!));
});
agentGatewayRouter.post('/recordings/link', requireEndpointAgent, async (req, res) => {
  res.json(await agentRecordingLink(req.endpoint!, parse(recordingLinkSchema, req.body)));
});

// The person logged out in the app on the device: the credential stops working now.
agentGatewayRouter.post('/leave', requireEndpointAgent, async (req, res) => {
  res.json({ ok: true, revoked: await leaveFromDevice(req.endpoint!) });
});

// The person at the computer pressed "End session" on the remote support banner.
const rdSessionEndSchema = z.object({ session_id: z.string().min(1).max(64) }).strict();
agentGatewayRouter.post('/rd-session/end', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const body = parse(rdSessionEndSchema, req.body);
  res.json({ ok: true, ended: await endSessionByUser(ep, body.session_id) });
});

// "Request help" from the agent's tray: the person's note (fleet-reach/help-requests.ts).
agentGatewayRouter.post('/help-request', requireEndpointAgent, async (req, res) => {
  const body = parse(agentHelpRequestSchema, req.body);
  res.status(201).json(await createHelpRequest(req.endpoint!, body.note, body.user));
});

// Quick Support (nigafiy-support.exe): register with the signed link, then poll the code's state.
agentGatewayRouter.post('/quick-support/register', quickRegisterLimiter, async (req, res) => {
  res.status(201).json(await registerQuickSupport(parse(quickRegisterSchema, req.body)));
});

agentGatewayRouter.get('/quick-support/status', requireEndpointAgent, async (req, res) => {
  res.json(await quickSupportStatus(req.endpoint!));
});

agentGatewayRouter.post('/quick-support/close', requireEndpointAgent, async (req, res) => {
  await quickSupportClosedByUser(req.endpoint!);
  res.json({ ok: true });
});

// Fleet Pro remote shell: the shell ended on the computer (End on the session bar, exit, idle, limit).
agentGatewayRouter.post('/shell-end', requireEndpointAgent, async (req, res) => {
  const body = parse(agentShellEndSchema, req.body);
  res.json({ ok: await agentShellEnd(req.endpoint!, body.shell_id, body.reason, body.exit_code ?? null) });
});

// The person's "IT activity" list in the tray: sessions, shells and jobs on this computer.
agentGatewayRouter.post('/it-activity', requireEndpointAgent, async (req, res) => {
  res.json({ items: await itActivity(req.endpoint!) });
});

// Android: the agent APK for QR provisioning and APKs pushed from Fleet (fleet-android/routes.ts).
agentGatewayRouter.use(androidGatewayRouter);
