import http from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sha256 } from '../../common/crypto.ts';
import { env } from '../../config/env.ts';
import { systemPool } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { SESSION_COOKIE, readCookie } from './session.ts';

/**
 * The dashboard for admin phones (docs/roadmap/2026-11-26-admin-phones.md).
 *
 * The web app listens on this computer only (127.0.0.1). The API's HTTPS listener, which phones
 * already reach on the network, also serves the dashboard pages by passing them to the local web
 * server, but only to a request that carries a live admin-phone session (sessions.endpoint_id of an
 * active admin phone). Anyone else gets what they got before: the API's 404. /api stays the API.
 *
 * Only on the HTTPS listener, and only when the web app is on this computer (WEB_ORIGIN is a
 * loopback http address, as on an installed copy).
 */
export function phoneDashboardProxy(webOrigin: string = env.WEB_ORIGIN): RequestHandler {
  let target: URL | null = null;
  try {
    const u = new URL(webOrigin);
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) target = u;
  } catch {
    target = null;
  }
  // Each page load asks for dozens of files: remember a session's answer for 15 seconds.
  const seen = new Map<string, { ok: boolean; at: number }>();

  async function isPhoneSession(token: string): Promise<boolean> {
    const key = sha256(token);
    const hit = seen.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.ok;
    const r = await systemPool.query(
      `SELECT 1 FROM sessions s
         JOIN endpoints e ON e.id = s.endpoint_id
         JOIN memberships m ON m.user_id = s.user_id AND m.organization_id = s.active_organization_id AND m.status = 'active'
        WHERE s.token_hash = $1 AND s.expires_at > now()
          AND e.status = 'active' AND e.phone_role = 'admin' AND e.phone_admin_user_id = s.user_id AND e.organization_id = s.active_organization_id`,
      [key],
    );
    const ok = (r.rowCount ?? 0) > 0;
    if (seen.size > 500) seen.clear();
    seen.set(key, { ok, at: Date.now() });
    return ok;
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (!target || req.path.startsWith('/api/') || req.path === '/healthz' || req.path === '/readyz') return next();
    if (!(req.socket as { encrypted?: boolean }).encrypted) return next();
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return next();
    isPhoneSession(token)
      .then((ok) => {
        if (!ok) return next();
        const headers = { ...req.headers, host: target!.host };
        delete headers.connection;
        const upstream = http.request(
          { protocol: target!.protocol, hostname: target!.hostname.replace(/^\[|\]$/g, ''), port: target!.port, method: req.method, path: req.originalUrl, headers },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on('error', (err) => {
          logger.warn({ err: err.message }, 'phone dashboard: the web app did not answer');
          if (!res.headersSent) res.status(502).type('text/plain').send('Nigafiy is starting, try again in a moment.');
          else res.end();
        });
        req.pipe(upstream);
      })
      .catch(next);
  };
}
