import http from 'node:http';
import { networkInterfaces } from 'node:os';
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
 * A browser on another computer at home (an address in the same network as one of this computer's
 * own, owner's choice 2026-11-28) gets the pages too, login page included, and signs in as usual.
 * Tailscale (100.64.0.0/10) and anything else outside the home network still gets the 404.
 *
 * Only on the HTTPS listener, and only when the web app is on this computer (WEB_ORIGIN is a
 * loopback http address, as on an installed copy).
 *
 * app.ts mounts it after helmet, so the pages get the API's security headers too; the web app's own
 * headers win where both send one, and helmet's Content-Security-Policy is dropped because the web
 * app writes its own per-request policy (with a script nonce) on every page. `limit` (the rate
 * limiter) runs before the session lookup, so a flood of made-up cookies cannot reach the database.
 */
export function phoneDashboardProxy(
  webOrigin: string = env.WEB_ORIGIN,
  isHome: (ip: string | undefined) => boolean = isHomeAddress,
  limit?: RequestHandler,
): RequestHandler {
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
    const home = isHome(req.socket.remoteAddress);
    const token = readCookie(req, SESSION_COOKIE);
    if (!token && !home) return next();
    if (limit) {
      void Promise.resolve(limit(req, res, (err?: unknown) => (err ? next(err) : forward(req, res, next, home, token)))).catch(next);
      return;
    }
    forward(req, res, next, home, token);
  };

  function forward(req: Request, res: Response, next: NextFunction, home: boolean, token: string | undefined): void {
    (home ? Promise.resolve(true) : isPhoneSession(token!))
      .then((ok) => {
        if (!ok) return next();
        const headers = { ...req.headers, host: target!.host };
        delete headers.connection;
        const upstream = http.request(
          { protocol: target!.protocol, hostname: target!.hostname.replace(/^\[|\]$/g, ''), port: target!.port, method: req.method, path: req.originalUrl, headers },
          (up) => {
            // The web app writes full redirects to its own loopback address; send them back to the address asked.
            const loc = up.headers.location;
            if (typeof loc === 'string' && req.headers.host && loc.startsWith(target!.origin)) {
              up.headers.location = `https://${req.headers.host}${loc.slice(target!.origin.length)}`;
            }
            res.removeHeader('Content-Security-Policy'); // helmet's; the web app sends its own
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
  }
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

type Net = { base: number; mask: number };
let homeNets: { at: number; nets: Net[] } | null = null;

/** This computer's own IPv4 networks (address + netmask), without loopback, link-local and Tailscale. Re-read every 30 s. */
function ownHomeNetworks(now = Date.now()): Net[] {
  if (homeNets && now - homeNets.at < 30_000) return homeNets.nets;
  const nets: Net[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = ipv4ToInt(a.address);
      const mask = ipv4ToInt(a.netmask);
      if (ip === null || mask === null || mask === 0) continue;
      if (isTailscaleOrLinkLocal(ip)) continue;
      nets.push({ base: (ip & mask) >>> 0, mask });
    }
  }
  homeNets = { at: now, nets };
  return nets;
}

function isTailscaleOrLinkLocal(ip: number): boolean {
  if ((ip & 0xffc00000) >>> 0 === 0x64400000) return true; // 100.64.0.0/10 (Tailscale, carrier NAT)
  if ((ip & 0xffff0000) >>> 0 === 0xa9fe0000) return true; // 169.254.0.0/16
  return false;
}

/** True when the address is another device on the same home network as this computer. */
export function isHomeAddress(remote: string | undefined, nets: Net[] = ownHomeNetworks()): boolean {
  if (!remote) return false;
  const ip = ipv4ToInt(remote.replace(/^::ffff:/i, ''));
  if (ip === null || isTailscaleOrLinkLocal(ip)) return false;
  return nets.some((n) => ((ip & n.mask) >>> 0) === n.base);
}

/** For tests: networks given as "address/netmask". */
export function netsFrom(list: { address: string; netmask: string }[]): Net[] {
  return list.flatMap((a) => {
    const ip = ipv4ToInt(a.address);
    const mask = ipv4ToInt(a.netmask);
    return ip === null || mask === null || mask === 0 || isTailscaleOrLinkLocal(ip) ? [] : [{ base: (ip & mask) >>> 0, mask }];
  });
}
