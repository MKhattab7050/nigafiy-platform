import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { enrollSchema, heartbeatSchema, telemetryBatchSchema } from '../../common/collector-protocol.ts';
import { AppError, parse } from '../../common/http.ts';
import { env } from '../../config/env.ts';
import { logger } from '../../infrastructure/logger.ts';
import { requireCollector } from './collector-auth.ts';
import { enrollCollector } from './enrollment.ts';
import { HEARTBEAT_INTERVAL_SECONDS, recordHeartbeat } from './heartbeat.ts';
import { applyTelemetryBatch } from './telemetry.ts';

/** Collector-facing API. Collectors only ever make outbound HTTPS requests to these endpoints. */
export const collectorGatewayRouter: Router = Router();

const enrollLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many enrollment attempts' } },
});

collectorGatewayRouter.use(express.json({ limit: '2mb' }));

collectorGatewayRouter.post('/enroll', enrollLimiter, async (req, res) => {
  const body = parse(enrollSchema, req.body);
  const enrolled = await enrollCollector(body, req.ip ?? null);
  if (!enrolled) {
    logger.warn({ ip: req.ip }, 'rejected collector enrollment');
    throw new AppError(401, 'invalid_enrollment_token', 'Enrollment token is invalid, already used or expired');
  }
  const { collector, secret } = enrolled;
  logger.info({ collector_id: collector.id, organization_id: collector.organization_id }, 'collector enrolled');
  res.status(201).json({ collector_id: collector.id, credential: `ldc_${collector.id}.${secret}`, heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS });
});

collectorGatewayRouter.post('/heartbeat', requireCollector, async (req, res) => {
  const c = req.collector!;
  const body = parse(heartbeatSchema, req.body);
  res.json(await recordHeartbeat(c, body, req.ip ?? null));
});

collectorGatewayRouter.post('/telemetry', requireCollector, async (req, res) => {
  const c = req.collector!;
  const batch = parse(telemetryBatchSchema, req.body);
  const result = await applyTelemetryBatch(c, batch);
  if (result.rejected.length) logger.warn({ collector_id: c.id, rejected: result.rejected.slice(0, 5) }, 'telemetry items rejected');
  res.json(result);
});
