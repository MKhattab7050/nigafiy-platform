import { gzipSync, constants } from 'node:zlib';
import type { RequestHandler } from 'express';

/**
 * Gzips JSON answers of 1 KB or more when the client accepts gzip.
 *
 * A phone away from home reads the dashboard through the HTTPS listener over a relayed 4G link.
 * The device page re-read /endpoints/:id every 4 s: 342 KB as plain JSON, 47 KB gzipped, so about
 * 0.9 Mbit/s of the link went to a page refresh during a remote desktop session (owner,
 * 2026-11-28, docs/roadmap/2026-11-28-wan-speed.md). Only JSON is touched: downloads, pictures and
 * streams are sent as they are.
 */
export const GZIP_MIN_BYTES = 1024;

export function gzipJson(): RequestHandler {
  return (req, res, next) => {
    if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) return next();
    const send = res.send.bind(res);
    res.send = (body?: unknown) => {
      const type = String(res.getHeader('Content-Type') ?? '');
      if (
        (typeof body === 'string' || Buffer.isBuffer(body)) &&
        type.startsWith('application/json') &&
        !res.getHeader('Content-Encoding') &&
        Buffer.byteLength(body) >= GZIP_MIN_BYTES
      ) {
        res.setHeader('Content-Encoding', 'gzip');
        res.vary('Accept-Encoding');
        return send(gzipSync(body, { level: constants.Z_BEST_SPEED + 3 }));
      }
      return send(body);
    };
    next();
  };
}
