import { randomUUID } from 'node:crypto';
import express, { type Express, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { AppError, errorHandler } from './common/http.ts';
import { env } from './config/env.ts';
import { systemPool } from './infrastructure/db.ts';
import { logger } from './infrastructure/logger.ts';
import { authRouter } from './modules/auth/routes.ts';
import { requireSession } from './modules/auth/session.ts';
import { collectorsRouter } from './modules/collectors/routes.ts';
import { devicesRouter } from './modules/devices/routes.ts';
import { eventsRouter } from './modules/events/routes.ts';
import { incidentsRouter } from './modules/incidents/routes.ts';
import { collectorGatewayRouter } from './modules/ingest/routes.ts';
import { monitoringRouter } from './modules/monitoring/routes.ts';
import { notificationsRouter } from './modules/notifications/routes.ts';
import { overviewRouter } from './modules/overview/routes.ts';
import { realtimeRouter } from './modules/realtime/routes.ts';
import { sitesRouter } from './modules/sites/routes.ts';
import { timeMachineRouter } from './modules/timemachine/routes.ts';
import { topologyRouter } from './modules/topology/routes.ts';

function trustProxySetting(value: string): boolean | number | string {
  if (value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxySetting(env.TRUST_PROXY));

  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const started = performance.now();
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      // Method, path and status only — never headers, cookies, query strings or bodies.
      logger.info({ request_id: req.id, method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(performance.now() - started) }, 'request');
    });
    next();
  });
  app.use(helmet());

  // Liveness: the process is up. Readiness: it can reach its database.
  app.get('/healthz', (_req, res) => void res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      await systemPool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });

  const limiter = (limit: number) =>
    rateLimit({
      windowMs: 60_000,
      limit: env.NODE_ENV === 'test' ? 100_000 : limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many requests' } },
    });

  // ── Collector-facing API (credential auth, own body limit) ──
  app.use('/api/v1/collector', limiter(240), collectorGatewayRouter);

  // ── User-facing API (session auth) ──
  const api = Router();
  api.use(limiter(600));
  api.use(express.json({ limit: '100kb' }));
  api.use('/auth', authRouter);
  api.use(requireSession); // everything below requires a valid session + membership
  api.use(overviewRouter, sitesRouter, collectorsRouter, devicesRouter, monitoringRouter, eventsRouter, notificationsRouter, realtimeRouter, incidentsRouter, timeMachineRouter, topologyRouter);
  app.use('/api/v1', api);

  app.use((_req, _res, next) => next(new AppError(404, 'not_found', 'No such endpoint')));
  app.use(errorHandler);
  return app;
}
