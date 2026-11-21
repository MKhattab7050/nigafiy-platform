import { readFileSync } from 'node:fs';
import https from 'node:https';
import { createApp } from './app.ts';
import { env, tlsPinSha256 } from './config/env.ts';
import { migrate } from './database/migrate.ts';
import { closePools } from './infrastructure/db.ts';
import { logger } from './infrastructure/logger.ts';
import { startJobs, stopJobs } from './infrastructure/scheduler.ts';
import { modules } from './modules/registry.ts';
import { scheduledJobsOf } from './modules/system/index.ts';

// The database may still be starting (container order, crash recovery): wait for it instead of dying.
for (let attempt = 1; ; attempt++) {
  try {
    await migrate(env.DATABASE_URL, env.APP_DATABASE_URL, (m) => logger.info({ migration: m }, 'migration'));
    break;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const transient = code === '57P03' || code === 'ECONNREFUSED' || code === 'ECONNRESET';
    if (!transient || attempt >= 30) throw err;
    logger.warn({ attempt, code }, 'database not ready yet, retrying');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const app = createApp(modules);
const onListening = () => logger.info({ port: env.PORT, host: env.HOST ?? 'all interfaces', env: env.NODE_ENV }, 'LAN Detective API listening');
const server = env.HOST ? app.listen(env.PORT, env.HOST, onListening) : app.listen(env.PORT, onListening);

let httpsServer: https.Server | undefined;
if (env.HTTPS_PORT && env.TLS_CERT_FILE && env.TLS_KEY_FILE) {
  const tlsPin = tlsPinSha256();
  httpsServer = https.createServer({ cert: readFileSync(env.TLS_CERT_FILE), key: readFileSync(env.TLS_KEY_FILE) }, app);
  const onHttps = () =>
    logger.info({ https_port: env.HTTPS_PORT, host: env.HOST ?? 'all interfaces', tls_pin_sha256: tlsPin }, 'LAN Detective HTTPS listening');
  if (env.HOST) httpsServer.listen(env.HTTPS_PORT, env.HOST, onHttps);
  else httpsServer.listen(env.HTTPS_PORT, onHttps);
}

// A module whose start-up fails is logged; the API keeps serving every other module.
for (const m of modules) {
  if (!m.lifecycle?.start) continue;
  try {
    await m.lifecycle.start();
  } catch (err) {
    logger.error({ err, module: m.name }, 'module failed to start');
  }
}
try {
  startJobs(scheduledJobsOf(modules));
} catch (err) {
  logger.error({ err }, 'background jobs failed to start');
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  // Module resources first (the realtime module ends its SSE streams so server.close() can complete).
  for (const m of modules) {
    if (!m.lifecycle?.stop) continue;
    await m.lifecycle.stop().catch((err: unknown) => logger.error({ err, module: m.name }, 'module failed to stop'));
  }
  if (httpsServer) await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopJobs();
  await closePools();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
