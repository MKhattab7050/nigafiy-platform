import { type Page, expect, test } from '@playwright/test';

/**
 * One account walks the main screens in English and then in Arabic (RTL). For every screen:
 * the page heading renders, the screen did not fall into its error boundary, the browser reported
 * no uncaught error and no Content-Security-Policy violation.
 */
const SCREENS = [
  { path: '/', name: 'Dashboard' },
  { path: '/devices', name: 'Devices' },
  { path: '/routers', name: 'Routers' },
  { path: '/monitoring', name: 'Monitoring' },
  { path: '/incidents', name: 'Incidents' },
  { path: '/endpoints', name: 'Endpoints' },
  { path: '/settings', name: 'Settings' },
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
      await page.goto(screen.path);
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(main).not.toContainText(ERROR_BOUNDARY);
      expect(problems, `${screen.path} reported problems`).toEqual([]);
    });
  }
}

test('sign up, walk every main screen in English and Arabic, sign out and back in', async ({ page }) => {
  const problems = watchForProblems(page);
  const email = `e2e-${Date.now()}@example.test`;
  const password = `e2e-${crypto.randomUUID()}`;

  await test.step('register', async () => {
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
    await page.context().addCookies([{ name: 'ld_locale', value: 'ar', url: page.url() }]);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await visitAll(page, problems);
    await page.context().addCookies([{ name: 'ld_locale', value: 'en', url: page.url() }]);
  });

  await test.step('sign out and sign in again', async () => {
    const status = await page.evaluate(async () => (await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-LD-CSRF': '1' } })).status);
    expect(status).toBe(200);
    await page.goto('/devices');
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
  const problems = watchForProblems(page);
  await page.goto('/register');
  await page.getByLabel('Work email').fill(`hub-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill(`e2e-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).not.toHaveURL(/\/register/);

  const programs = page.locator('main').getByText('Programs', { exact: true });
  await expect(programs).toBeVisible();
  for (const name of ['Radar', 'Watch', 'Guard', 'Fleet', 'Mind', 'Toolbox']) {
    await expect(page.getByRole('link', { name: `Open Nigafiy ${name}` })).toBeVisible();
  }
  await page.getByRole('link', { name: 'Open Nigafiy Radar' }).click();
  await expect(page).toHaveURL(/\/devices$/);
  await page.goto('/');
  // The API in this test was not started by an engine, and no update source is configured: both say so.
  await expect(page.locator('main')).toContainText('No engine is running on this computer');
  await expect(page.locator('main')).toContainText('Update checks are off: no update source is configured.');
  await page.screenshot({ path: test.info().outputPath('hub-home-en.png'), fullPage: true });

  await page.context().addCookies([{ name: 'ld_locale', value: 'ar', url: page.url() }]);
  await page.goto('/');
  await expect(page.locator('main').getByText('البرامج', { exact: true })).toBeVisible();
  await expect(page.locator('main')).toContainText('التحقق من التحديثات متوقف');
  await page.screenshot({ path: test.info().outputPath('hub-home-ar.png'), fullPage: true });
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
