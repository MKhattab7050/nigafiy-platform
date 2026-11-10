import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { migrate } from './database/migrate.ts';
import { closePools } from './infrastructure/db.ts';
import { logger } from './infrastructure/logger.ts';
import { startJobs, stopJobs } from './jobs/scheduler.ts';
import { startRealtime, stopRealtime } from './modules/realtime/routes.ts';

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

const app = createApp();
const onListening = () => logger.info({ port: env.PORT, host: env.HOST ?? 'all interfaces', env: env.NODE_ENV }, 'LAN Detective API listening');
const server = env.HOST ? app.listen(env.PORT, env.HOST, onListening) : app.listen(env.PORT, onListening);
await startRealtime();
startJobs();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await stopRealtime(); // ends SSE streams so server.close() can complete
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopJobs();
  await closePools();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
