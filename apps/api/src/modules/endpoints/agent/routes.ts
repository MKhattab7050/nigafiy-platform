import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError, parse } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';
import { logger } from '../../../infrastructure/logger.ts';
import { HEARTBEAT_INTERVAL_SECONDS } from '../repo.ts';
import { agentCommandResultsSchema, agentEnrollSchema, agentHeartbeatSchema, agentInventorySchema } from '../schema.ts';
import { requireEndpointAgent } from './auth.ts';
import { enrollAgent, pollCommands, recordCommandResults, recordHeartbeat, recordInventory } from './service.ts';
import { limiterStore } from '../../../infrastructure/rate-limit.ts';

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

// Fast sub-second command poll endpoint for interactive File Manager & Remote Desktop sessions.
agentGatewayRouter.post('/poll', requireEndpointAgent, async (req, res) => {
  const ep = req.endpoint!;
  const commands = await pollCommands(ep);
  res.json({ commands });
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
