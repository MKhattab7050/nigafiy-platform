import { readFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { createApp } from './app.ts';
import { env, tlsPinSha256 } from './config/env.ts';
import { migrate } from './database/migrate.ts';
import { closePools } from './infrastructure/db.ts';
import { ensureLanTls, setTlsStatus, statusFromMaterial, tlsStatus } from './infrastructure/lan-tls.ts';
import { logger } from './infrastructure/logger.ts';
import { startJobs, stopJobs } from './infrastructure/scheduler.ts';
import { modules } from './modules/registry.ts';
import { streamHub } from './modules/endpoints/remote-desktop/stream-hub.ts';
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
const onListening = () => logger.info({ port: env.PORT, host: env.HOST ?? 'all interfaces', env: env.NODE_ENV }, 'Nigafiy API listening');
const server = env.HOST ? app.listen(env.PORT, env.HOST, onListening) : app.listen(env.PORT, onListening);

let httpsServer: https.Server | undefined;
let tlsRenewTimer: NodeJS.Timeout | undefined;
const httpsHost = env.HTTPS_HOST ?? env.HOST;
const listenHttps = (srv: https.Server, onHttps: () => void) => {
  if (httpsHost) srv.listen(env.HTTPS_PORT, httpsHost, onHttps);
  else srv.listen(env.HTTPS_PORT, onHttps);
};
if (env.HTTPS_PORT && env.TLS_CERT_FILE && env.TLS_KEY_FILE) {
  const tlsPin = tlsPinSha256();
  httpsServer = https.createServer({ cert: readFileSync(env.TLS_CERT_FILE), key: readFileSync(env.TLS_KEY_FILE) }, app);
  setTlsStatus({ ...tlsStatus(), mode: 'files', https_port: env.HTTPS_PORT, https_host: httpsHost ?? null, pin_sha256: tlsPin, pin_kind: tlsPin ? 'leaf' : null });
  listenHttps(httpsServer, () => logger.info({ https_port: env.HTTPS_PORT, host: httpsHost ?? 'all interfaces', tls_pin_sha256: tlsPin }, 'Nigafiy HTTPS listening'));
} else if (env.HTTPS_PORT && (env.TLS_CERT_FILE || env.TLS_KEY_FILE)) {
  // One file without the other is a mistake; do not silently replace it with the built-in certificate.
  logger.error({ https_port: env.HTTPS_PORT }, 'TLS_CERT_FILE and TLS_KEY_FILE must both be set; HTTPS is off');
} else if (env.HTTPS_PORT && env.LAN_TLS === 'auto') {
  // Built-in LAN TLS: local CA + server certificate in the data folder, renewed before expiry or when
  // this computer's names / addresses change. Collectors and agents pin the CA (docs/features/lan-tls.md).
  const dir = path.resolve(env.TLS_AUTO_DIR ?? path.join(process.cwd(), '.data', 'tls'));
  try {
    const port = env.HTTPS_PORT;
    let material = ensureLanTls(dir);
    let renewedAt: Date | null = material.action === 'loaded' ? null : new Date();
    if (material.action !== 'loaded') logger.info({ dir, action: material.action, ca_sha256: material.caFingerprint256 }, 'LAN TLS certificate created');
    setTlsStatus(statusFromMaterial(material, port, httpsHost ?? null, renewedAt));
    const srv = https.createServer({ cert: readFileSync(material.certFile), key: readFileSync(material.keyFile) }, app);
    httpsServer = srv;
    listenHttps(srv, () => logger.info({ https_port: port, host: httpsHost ?? 'all interfaces', tls_pin_sha256: material.caFingerprint256, pin: 'local CA' }, 'Nigafiy HTTPS listening (built-in LAN TLS)'));
    tlsRenewTimer = setInterval(() => {
      try {
        const next = ensureLanTls(dir);
        if (next.action === 'loaded') return;
        if (next.action === 'created_ca') logger.warn({ ca_sha256: next.caFingerprint256 }, 'LAN TLS: a new local CA was created; collectors and agents pinned to the old one must be given the new pin');
        srv.setSecureContext({ cert: readFileSync(next.certFile), key: readFileSync(next.keyFile) });
        material = next;
        renewedAt = new Date();
        setTlsStatus(statusFromMaterial(material, port, httpsHost ?? null, renewedAt));
        logger.info({ action: next.action, leaf_not_after: next.leafNotAfter.toISOString() }, 'LAN TLS certificate renewed');
      } catch (err) {
        logger.error({ err }, 'LAN TLS renewal failed; the current certificate stays in use');
      }
    }, 6 * 3600_000);
    tlsRenewTimer.unref();
  } catch (err) {
    logger.error({ err, dir }, 'built-in LAN TLS could not start; HTTPS is off');
  }
}

// Live Remote Desktop streams (WebSocket upgrades on both listeners; the endpoints module starts the hub).
streamHub().attach(server);
if (httpsServer) streamHub().attach(httpsServer);

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
async function shutdown(signal: string, code = 0): Promise<void> {
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
  if (tlsRenewTimer) clearInterval(tlsRenewTimer);
  if (httpsServer) await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopJobs();
  await closePools();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
// A throw nobody caught (a socket or timer callback outside Express) leaves the process in an
// unknown state: log it, close what can be closed and exit 1 so the engine starts a fresh API,
// instead of Node ending at once without a word in the log.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception: restarting the API');
  void shutdown('uncaughtException', 1).catch(() => process.exit(1));
});
