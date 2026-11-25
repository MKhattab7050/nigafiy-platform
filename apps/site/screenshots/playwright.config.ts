import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Captures the program screenshots for the site from the real running web app:
 *
 *   pnpm --filter @nigafiy/site screenshots
 *
 * It reuses the web app's browser-test harness unchanged (apps/web/e2e/global-setup.ts starts a
 * throw-away PostgreSQL and the real API; apps/web/e2e/seed.ts creates records through the real
 * API and the real Sensor/Agent protocols), builds the web app into its own folder and starts it.
 * Every program is installed for these pictures. Nothing on the network is scanned or contacted.
 *
 * Ports (separate from the dev stack, the desktop app and the web e2e run): web 3293, API 3292,
 * PostgreSQL 5445. Override with SHOTS_WEB_PORT / SHOTS_API_PORT / E2E_PG_PORT.
 * Output: public/screenshots/en/*.png (English, light) and public/screenshots/ar/*.png (Arabic, dark).
 */
const WEB_PORT = Number(process.env.SHOTS_WEB_PORT ?? 3293);
const API_PORT = Number(process.env.SHOTS_API_PORT ?? 3292);
// global-setup.ts reads these when Playwright loads it, after this file.
process.env.E2E_WEB_PORT = String(WEB_PORT);
process.env.E2E_API_PORT = String(API_PORT);
process.env.E2E_PG_PORT ??= '5445';
process.env.E2E_NIGAFIY_PROGRAMS = 'hub,radar,watch,guard,fleet,mind,toolbox';

const webDir = path.resolve(import.meta.dirname, '../../web');
const webOrigin = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'capture.spec.ts',
  globalSetup: path.join(webDir, 'e2e', 'global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  outputDir: path.resolve(import.meta.dirname, '../test-results/screenshots'),
  use: {
    baseURL: webOrigin,
    channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${WEB_PORT} -H 127.0.0.1`,
    cwd: webDir,
    url: `${webOrigin}/login`,
    timeout: 600_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NEXT_DIST_DIR: '.next-site-shots',
      API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
