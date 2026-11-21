import { defineConfig } from '@playwright/test';

/**
 * Browser smoke tests against a real stack: a throw-away PostgreSQL, the real API, and a
 * production build of this app (so the production Content-Security-Policy is what gets tested).
 *
 *   pnpm --filter @lan-detective/web test:e2e
 *
 * Ports are separate from the dev stack (3100/4100/5433) and the installed desktop app
 * (47100/47130/47133). Override with E2E_WEB_PORT / E2E_API_PORT / E2E_PG_PORT.
 * Uses the installed Microsoft Edge (E2E_BROWSER_CHANNEL=chrome to switch), so no browser download.
 */
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3146);
export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 4146);
const webOrigin = `http://127.0.0.1:${E2E_WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webOrigin,
    channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Its own build folder: the /api rewrite target is fixed at build time.
    command: `pnpm exec next build && pnpm exec next start -p ${E2E_WEB_PORT} -H 127.0.0.1`,
    url: `${webOrigin}/login`,
    timeout: 600_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NEXT_DIST_DIR: '.next-e2e',
      API_INTERNAL_URL: `http://127.0.0.1:${E2E_API_PORT}`,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
