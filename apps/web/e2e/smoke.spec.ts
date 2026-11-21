import { type Page, expect, test } from '@playwright/test';
import { countApi, localeCookie, paceApi } from './api-budget';

/**
 * One account walks the main screens in English and then in Arabic (RTL). For every screen:
 * the page heading renders, the screen did not fall into its error boundary, the shell shows the
 * page's program (html[data-program]), the browser reported no uncaught error and no
 * Content-Security-Policy violation.
 */
const SCREENS = [
  { path: '/', name: 'Dashboard', program: 'hub' },
  { path: '/programs', name: 'Hub, Programs', program: 'hub' },
  { path: '/sensors', name: 'Hub, Sensors', program: 'hub' },
  { path: '/radar/devices', name: 'Devices', program: 'radar' },
  { path: '/radar/discovery', name: 'Discovery', program: 'radar' },
  { path: '/radar/ports', name: 'Switch ports', program: 'radar' },
  { path: '/guard/routers', name: 'Routers', program: 'guard' },
  { path: '/guard/port-control', name: 'Guard, Switch port control', program: 'guard' },
  { path: '/watch/monitoring', name: 'Monitoring', program: 'watch' },
  { path: '/watch/incidents', name: 'Incidents', program: 'watch' },
  { path: '/watch/insights', name: 'Watch, Insights', program: 'watch' },
  { path: '/watch/reports', name: 'Watch, Reports', program: 'watch' },
  { path: '/watch/notifications', name: 'Watch, Notifications', program: 'watch' },
  { path: '/watch/maintenance', name: 'Watch, Maintenance windows', program: 'watch' },
  { path: '/fleet/endpoints', name: 'Endpoints', program: 'fleet' },
  { path: '/mind/automation', name: 'Mind, Automation', program: 'mind' },
  { path: '/toolbox/subnet', name: 'Toolbox, Subnet calculator', program: 'toolbox' },
  { path: '/settings', name: 'Settings', program: 'hub' },
] as const;

const ERROR_BOUNDARY = /This page could not be displayed|تعذّر عرض هذه الصفحة/;

function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) problems.push(`CSP: ${text}`);
  });
  return problems;
}

async function visitAll(page: Page, problems: string[]) {
  for (const screen of SCREENS) {
    await test.step(screen.name, async () => {
      await paceApi();
      await page.goto(screen.path);
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(main).not.toContainText(ERROR_BOUNDARY);
      // The shell paints the page in its program's accent.
      await expect(page.locator('html')).toHaveAttribute('data-program', screen.program);
      expect(problems, `${screen.path} reported problems`).toEqual([]);
    });
  }
}

async function register(page: Page, prefix: string) {
  await paceApi();
  await page.goto('/register');
  await page.getByLabel('Work email').fill(`${prefix}-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill(`e2e-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).not.toHaveURL(/\/register/);
}

test('sign up, walk every main screen in English and Arabic, sign out and back in', async ({ page }) => {
  test.setTimeout(600_000);
  const problems = watchForProblems(page);
  countApi(page);
  const email = `e2e-${Date.now()}@example.test`;
  const password = `e2e-${crypto.randomUUID()}`;

  await test.step('register', async () => {
    await paceApi();
    await page.goto('/register');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).not.toHaveURL(/\/register/);
    await expect(page.locator('main')).toBeVisible();
  });

  await test.step('English (LTR)', async () => {
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await visitAll(page, problems);
  });

  await test.step('switch to Arabic (RTL)', async () => {
    await page.context().addCookies([localeCookie(page, 'ar')]);
    await paceApi();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await visitAll(page, problems);
    await page.context().addCookies([localeCookie(page, 'en')]);
  });

  await test.step('sign out and sign in again', async () => {
    const status = await page.evaluate(async () => (await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-LD-CSRF': '1' } })).status);
    expect(status).toBe(200);
    await paceApi();
    await page.goto('/radar/devices');
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test('Hub home lists the programs and the engine and update state', async ({ page }) => {
  test.setTimeout(180_000);
  const problems = watchForProblems(page);
  countApi(page);
  await register(page, 'hub');

  const programs = page.locator('main').getByText('Programs', { exact: true });
  await expect(programs).toBeVisible();
  for (const name of ['Radar', 'Watch', 'Guard', 'Fleet', 'Toolbox']) {
    await expect(page.getByRole('link', { name: `Open Nigafiy ${name}` })).toBeVisible();
  }
  // The API in this test was not started by an engine, and no update source is configured: both say so.
  await expect(page.locator('main')).toContainText('No engine is running on this computer');
  await expect(page.locator('main')).toContainText('Update checks are off: no update source is configured.');
  await page.screenshot({ path: test.info().outputPath('hub-home-en.png'), fullPage: true });

  await page.getByRole('link', { name: 'Open Nigafiy Radar' }).click();
  await expect(page).toHaveURL(/\/radar\/devices$/);
  await expect(page.locator('html')).toHaveAttribute('data-program', 'radar');

  await page.context().addCookies([localeCookie(page, 'ar')]);
  await paceApi();
  await page.goto('/');
  await expect(page.locator('main').getByText('البرامج', { exact: true })).toBeVisible();
  await expect(page.locator('main')).toContainText('التحقق من التحديثات متوقف');
  await page.screenshot({ path: test.info().outputPath('hub-home-ar.png'), fullPage: true });
  expect(problems).toEqual([]);
});

test('a program left out of the install reads "not installed" and leads to its install page', async ({ page }) => {
  test.setTimeout(180_000);
  const problems = watchForProblems(page);
  countApi(page);
  await register(page, 'notinstalled');
  // This test install leaves Nigafiy Mind out (NIGAFIY_PROGRAMS in global-setup); the API says so for real.
  const served = await page.evaluate(async () => (await (await fetch('/api/v1/platform/programs')).json()) as { items: { id: string; installed: boolean }[] });
  expect(served.items.find((p) => p.id === 'mind')?.installed).toBe(false);
  expect(served.items.find((p) => p.id === 'radar')?.installed).toBe(true);

  // Hub home: no "Open" for Mind, an install link instead.
  await expect(page.getByRole('link', { name: 'Open Nigafiy Radar' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Nigafiy Mind' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Install Nigafiy Mind' }).first().click();
  await expect(page).toHaveURL(/\/programs#mind$/);
  await expect(page.locator('#program-mind')).toContainText('Not installed');
  await expect(page.locator('#program-mind')).toContainText('run the Nigafiy installer again');
  await expect(page.locator('#program-radar')).toContainText('Installed');

  // The switcher keeps every program; the missing one leads to its install page.
  await paceApi();
  await page.goto('/guard/security');
  await expect(page.locator('html')).toHaveAttribute('data-program', 'guard');
  await page.getByRole('button', { name: /Switch program/ }).first().click();
  await expect(page.getByRole('link', { name: /Nigafiy Mind/ }).first()).toHaveAttribute('href', '/programs#mind');
  await page.getByRole('link', { name: /Nigafiy Watch/ }).first().click();
  await expect(page).toHaveURL(/\/watch\/monitoring$/);
  await expect(page.locator('html')).toHaveAttribute('data-program', 'watch');

  // Settings' "Moved into the programs": the Mind entry is the install note, the others link.
  await paceApi();
  await page.goto('/settings#automation');
  const automation = page.locator('#automation');
  await expect(automation).toContainText('Available in Nigafiy Mind');
  await expect(automation.getByRole('link', { name: 'Install Nigafiy Mind' })).toHaveAttribute('href', '/programs#mind');
  await expect(page.locator('#notifications').getByRole('link')).toHaveAttribute('href', '/watch/notifications');
  expect(problems).toEqual([]);
});

test('every page carries a nonce-based Content-Security-Policy', async ({ request }) => {
  const res = await request.get('/login');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  // A fresh nonce per request.
  const again = (await request.get('/login')).headers()['content-security-policy'];
  expect(again).not.toEqual(csp);
});
