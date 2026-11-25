import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { countApi, localeCookie, paceApi } from '../../web/e2e/api-budget.ts';
import { type Seeded, seedRecords } from '../../web/e2e/seed.ts';

/**
 * One account, the web app's own seed (apps/web/e2e/seed.ts: a Sensor's discovery sweep, an
 * internet outage that opens an incident, a Windows computer and an Android phone reporting
 * through the Agent protocol, a router, a knowledge article, a playbook run at its approval gate),
 * then every screenshot the site's program pages use, in English (light) and Arabic (RTL, dark).
 * The file names are the ones in lib/content/programs.ts.
 */
const OUT = path.resolve(import.meta.dirname, '../public/screenshots');

type Shot = { file: string; path: (s: Seeded) => string; ready?: (page: Page) => Promise<void> };

const SHOTS: readonly Shot[] = [
  { file: 'hub-home.png', path: () => '/' },
  { file: 'hub-programs.png', path: () => '/programs' },
  { file: 'radar-devices.png', path: () => '/radar/devices' },
  { file: 'radar-device.png', path: (s) => `/radar/devices/${s.deviceId}` },
  { file: 'radar-topology.png', path: () => '/radar/topology' },
  { file: 'watch-incident.png', path: (s) => `/watch/incidents/${s.incidentId}` },
  { file: 'watch-monitoring.png', path: () => '/watch/monitoring' },
  { file: 'guard-routers.png', path: () => '/guard/routers' },
  { file: 'guard-access.png', path: () => '/guard/access' },
  { file: 'fleet-endpoints.png', path: () => '/fleet/endpoints' },
  { file: 'fleet-endpoint.png', path: (s) => `/fleet/endpoints/${s.endpointId}?tab=security` },
  { file: 'mind-playbook-run.png', path: (s) => `/mind/playbooks/runs/${s.runId}` },
  { file: 'mind-knowledge.png', path: () => '/mind/knowledge' },
  { file: 'toolbox.png', path: () => '/toolbox' },
  { file: 'toolbox-subnet.png', path: () => '/toolbox/subnet' },
  { file: 'agent-android.png', path: (s) => `/fleet/endpoints/${s.androidEndpointId}` },
  { file: 'sensor-sensors.png', path: () => '/sensors' },
];

const ERROR_BOUNDARY = /This page could not be displayed|تعذّر عرض هذه الصفحة/;

async function capture(page: Page, seeded: Seeded, lang: 'en' | 'ar') {
  mkdirSync(path.join(OUT, lang), { recursive: true });
  for (const shot of SHOTS) {
    await test.step(`${lang}: ${shot.file}`, async () => {
      await paceApi();
      await page.goto(shot.path(seeded));
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(main).not.toContainText(ERROR_BOUNDARY);
      await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await shot.ready?.(page);
      // Let charts and the topology layout settle, then keep the caret and animations out of the picture.
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, lang, shot.file), animations: 'disabled', caret: 'hide' });
    });
  }
}

test('capture the site screenshots from the running web app', async ({ page }) => {
  countApi(page);
  await paceApi();
  await page.goto('/register');
  await page.getByLabel('Work email').fill(`site-shots-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill(`shots-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).not.toHaveURL(/\/register/);
  const seeded = await seedRecords(page);

  await page.evaluate(() => localStorage.setItem('ld_theme', 'light'));
  await capture(page, seeded, 'en');

  await page.context().addCookies([localeCookie(page, 'ar')]);
  await page.evaluate(() => localStorage.setItem('ld_theme', 'dark'));
  await capture(page, seeded, 'ar');
});
