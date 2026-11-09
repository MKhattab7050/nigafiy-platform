import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { migrate } from './database/migrate.ts';
import { closePools } from './infrastructure/db.ts';
import { logger } from './infrastructure/logger.ts';
import { startJobs, stopJobs } from './jobs/scheduler.ts';
import { startRealtime, stopRealtime } from './modules/realtime/routes.ts';

await migrate(env.DATABASE_URL, env.APP_DATABASE_URL, (m) => logger.info({ migration: m }, 'migration'));

const app = createApp();
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'LAN Detective API listening'));
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
