import { randomUUID } from 'node:crypto';
import express, { type Express, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { AppError, errorHandler } from './common/http.ts';
import { env } from './config/env.ts';
import { systemPool } from './infrastructure/db.ts';
import { logger } from './infrastructure/logger.ts';
import { limiterStore } from './infrastructure/rate-limit.ts';
import type { ModuleManifest } from './infrastructure/module.ts';
import { requireSession } from './modules/auth/index.ts';
import { modules as registeredModules } from './modules/registry.ts';

function trustProxySetting(value: string): boolean | number | string {
  if (value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/**
 * Builds the HTTP app from the module registry. The composition — not the modules — owns the
 * cross-cutting order: request id/logging → helmet → health → machine gateways (own limits and
 * body parsers) → user API (limit, JSON parser, public routes, requireSession, module routes) →
 * 404 → error handler.
 *
 * Fault isolation: Express 5 forwards a rejected promise from any route handler or middleware to
 * `next(err)`, so a failure inside one module's handler ends in the error handler as a 500 for
 * that request only; nothing else is affected.
 *
 * @param modules the module list; tests may pass their own.
 */
export function createApp(modules: readonly ModuleManifest[] = registeredModules): Express {
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

  // Counters live in Redis when REDIS_URL is set (shared by every API instance), else in memory.
  const limiter = (limit: number, name: string) =>
    rateLimit({
      store: limiterStore(name),
      windowMs: 60_000,
      limit: env.NODE_ENV === 'test' ? 100_000 : limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many requests' } },
    });

  // ── Collector-facing & Endpoint-agent-facing APIs (credential auth, own body limit) ──
  for (const m of modules) {
    if (m.gateway) app.use(m.gateway.path, limiter(m.gateway.rateLimitPerMinute, `gateway:${m.gateway.path}`), m.gateway.router);
  }

  // ── User-facing API (session auth) ──
  const api = Router();
  api.use(limiter(600, 'api'));
  api.use(express.json({ limit: '100kb' }));
  for (const m of modules) {
    if (m.publicApi) api.use(m.publicApi.path, m.publicApi.router);
  }
  api.use(requireSession); // everything below requires a valid session + membership
  for (const m of modules) {
    if (m.api) api.use(m.api);
  }
  app.use('/api/v1', api);

  app.use((_req, _res, next) => next(new AppError(404, 'not_found', 'No such endpoint')));
  app.use(errorHandler);
  return app;
}
