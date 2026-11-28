import { phoneDashboardProxy } from './modules/auth/phone-dashboard.ts';
import { randomUUID } from 'node:crypto';
import express, { type Express, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { gzipJson } from './common/gzip-json.ts';
import { AppError, errorHandler } from './common/http.ts';
import { env } from './config/env.ts';
import { databaseUnavailableCode, systemPool } from './infrastructure/db.ts';
import { logger } from './infrastructure/logger.ts';
import { limiterStore } from './infrastructure/rate-limit.ts';
import type { ModuleManifest } from './infrastructure/module.ts';
import { schedulerReadiness } from './infrastructure/scheduler.ts';
import { startupFailures } from './infrastructure/startup.ts';
import { requireSession } from './modules/auth/index.ts';
import { modules as registeredModules } from './modules/registry.ts';
import { scheduledJobsOf } from './modules/system/service.ts';

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

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
/** POST /api/v1/endpoints/:id/commands (fs_op chunks travel here). */
const COMMANDS_ROUTE = /^\/endpoints\/[0-9a-f-]{36}\/commands\/?$/i;

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
  app.use(gzipJson());

  // Liveness: the process is up. Readiness: it can reach its database (with a free connection) and,
  // where this process runs the background jobs, the scheduler is not stuck. The desktop engine
  // restarts the API after three 503s in a row, which is the cure for both. A few overdue jobs
  // (a router that answers slowly) are reported as "degraded" with 200: a restart would not help.
  const jobs = scheduledJobsOf(modules);
  // started_at / rev let `pnpm local` warn when an API left running from earlier is on older code.
  app.get('/healthz', (_req, res) => void res.json({ status: 'ok', started_at: PROCESS_STARTED_AT, rev: process.env.NIGAFIY_CODE_REV || null }));
  app.get('/readyz', async (_req, res) => {
    let database: 'ok' | 'service_busy' | 'database_unavailable' = 'ok';
    try {
      await systemPool.query('SELECT 1');
    } catch (err) {
      database = databaseUnavailableCode(err) ?? 'database_unavailable';
    }
    const scheduler = schedulerReadiness(jobs);
    const failed_steps = startupFailures(); // a module or the jobs did not start: not ready
    const ready = database === 'ok' && scheduler.state !== 'stalled' && !failed_steps.length;
    res.status(ready ? 200 : 503).json({ status: ready ? (scheduler.state === 'degraded' ? 'degraded' : 'ready') : 'not_ready', database, scheduler, failed_steps });
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

  // Admin phones' dashboard pages: after helmet, with their own limit (a page load asks for dozens of files).
  app.use(phoneDashboardProxy(env.WEB_ORIGIN, undefined, limiter(1200, 'phone-dashboard')));

  // ── Collector-facing & Endpoint-agent-facing APIs (credential auth, own body limit) ──
  for (const m of modules) {
    if (m.gateway) app.use(m.gateway.path, limiter(m.gateway.rateLimitPerMinute, `gateway:${m.gateway.path}`), m.gateway.router);
  }

  // ── User-facing API (session auth) ──
  const api = Router();
  // File transfers: one command per 1 MiB chunk (base64 in JSON). The commands route takes bodies
  // up to 2 MB and has its own counter, so a large copy neither fails on the body limit nor uses
  // up the requests the dashboard needs; every other route keeps 100 KB and the shared counter.
  const isCommandsRoute = (req: express.Request) => req.method === 'POST' && COMMANDS_ROUTE.test(req.path);
  const apiLimiter = limiter(600, 'api');
  const transferLimiter = limiter(6000, 'api-commands');
  const smallJson = express.json({ limit: '100kb' });
  const transferJson = express.json({ limit: '2mb' });
  api.use((req, res, next) => (isCommandsRoute(req) ? transferLimiter : apiLimiter)(req, res, next));
  api.use((req, res, next) => (isCommandsRoute(req) ? transferJson : smallJson)(req, res, next));
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
