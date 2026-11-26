import os from 'node:os';
import path from 'node:path';
import type { NextConfig } from 'next';

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4100';

// `next dev` refuses its dev resources (HMR socket, dev chunks) to any origin but localhost, and the page then
// never hydrates — a phone opening http://<this PC's LAN IP>:3100 sticks on the boot splash. Allow this machine's
// own IPv4 addresses, plus any extra hosts in NIGAFIY_DEV_ORIGINS (comma-separated). Dev only; `next start` ignores it.
const lanOrigins = Object.values(os.networkInterfaces())
  .flat()
  .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
  .map((a) => a.address);
const extraOrigins = (process.env.NIGAFIY_DEV_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const config: NextConfig = {
  allowedDevOrigins: [...lanOrigins, ...extraOrigins],
  // NEXT_OUTPUT=standalone: self-contained server for the desktop installer (apps/desktop/scripts/bundle-backend.mjs).
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const, outputFileTracingRoot: path.resolve(import.meta.dirname, '../..') } : {}),
  // NEXT_DIST_DIR: a second dev server for the same checkout (e.g. against an isolated API) needs its own build folder.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  transpilePackages: ['@nigafiy/shared-types', '@nigafiy/brand'],
  poweredByHeader: false,
  turbopack: { root: path.resolve(import.meta.dirname, '../..') },
  // The browser only ever talks to this origin; /api is proxied to the API service.
  // Same-origin means the session cookie needs no CORS and stays SameSite=Lax.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
      {
        // The push service worker (UX review item 11): always fetched fresh, may only talk to this origin.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'; connect-src 'self'" },
        ],
      },
    ];
  },
};

export default config;
