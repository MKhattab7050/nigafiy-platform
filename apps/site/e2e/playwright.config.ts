import path from 'node:path';
import { defineConfig } from '@playwright/test';

const SITE = path.resolve(import.meta.dirname, '..');

/**
 * Browser tests of the static export, served the way a static host serves it (scripts/serve.ts):
 *   - out/          the real build (no release file: every download reads "Not released yet"), port 3290
 *   - out-fixture/  the same site built with tests/fixtures/release.json, port 3294
 *
 *   pnpm --filter @nigafiy/site build && pnpm --filter @nigafiy/site test
 *
 * Uses the installed Microsoft Edge (E2E_BROWSER_CHANNEL=chrome to switch), so no browser download.
 */
export const SITE_PORT = Number(process.env.SITE_PORT ?? 3290);
export const FIXTURE_PORT = Number(process.env.SITE_FIXTURE_PORT ?? 3294);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: path.join(SITE, 'playwright-report') }]] : 'list',
  outputDir: path.join(SITE, 'test-results', 'e2e'),
  use: {
    baseURL: `http://127.0.0.1:${SITE_PORT}`,
    channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: `node scripts/serve.ts out ${SITE_PORT}`, cwd: SITE, url: `http://127.0.0.1:${SITE_PORT}/en/`, reuseExistingServer: false, timeout: 30_000 },
    { command: `node scripts/serve.ts out-fixture ${FIXTURE_PORT}`, cwd: SITE, url: `http://127.0.0.1:${FIXTURE_PORT}/en/`, reuseExistingServer: false, timeout: 30_000 },
  ],
});
