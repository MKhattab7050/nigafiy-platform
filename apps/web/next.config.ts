import path from 'node:path';
import type { NextConfig } from 'next';

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4100';

const config: NextConfig = {
  // NEXT_OUTPUT=standalone: self-contained server for the desktop installer (apps/desktop/scripts/bundle-backend.mjs).
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const, outputFileTracingRoot: path.resolve(import.meta.dirname, '../..') } : {}),
  transpilePackages: ['@lan-detective/shared-types'],
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
    ];
  },
};

export default config;
