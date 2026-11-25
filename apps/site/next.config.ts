import path from 'node:path';
import type { NextConfig } from 'next';

// A static export: `next build` writes plain files to out/ (or SITE_OUT_DIR). No server, no API
// routes, no image optimizer. docs/website.md explains every environment variable used here.
const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  // A second build (the populated release fixture used by the browser tests) needs its own folders.
  ...(process.env.SITE_DIST_DIR ? { distDir: process.env.SITE_DIST_DIR } : {}),
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@nigafiy/shared-types', '@nigafiy/brand'],
  // The user guide's text is imported from apps/web, so the bundler root is the repository.
  turbopack: { root: path.resolve(import.meta.dirname, '../..') },
  experimental: { globalNotFound: true },
};

export default config;
