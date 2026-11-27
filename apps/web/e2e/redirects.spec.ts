import { type Page, expect, test } from '@playwright/test';
import { countApi, localeCookie, paceApi } from './api-budget';
import { OLD_ROUTE_SAMPLES, UNMOVED_ROUTES } from '../../../packages/shared-types/src/routes';

/**
 * Milestone 4 URL scheme against the real Next.js server (production build, proxy.ts): every
 * pre-namespace URL, program root and device-action URL answers 308 with the right Location
 * (query string kept), current URLs do not redirect, and every target renders cleanly in English
 * and in Arabic (RTL) with no uncaught error and no Content-Security-Policy violation.
 * The list is the shared table's OLD_ROUTE_SAMPLES, also walked by apps/api/tests/routes.test.ts.
 */
const ERROR_BOUNDARY = /This page could not be displayed|تعذّر عرض هذه الصفحة/;

const pathOf = (location: string) => {
  const u = new URL(location, 'http://127.0.0.1');
  return u.pathname + u.search;
};

test('every old URL answers 308 with its new Location, query string kept', async ({ request }) => {
  for (const { old, now } of OLD_ROUTE_SAMPLES) {
    let at = old;
    const hops: string[] = [];
    // A trailing slash is first normalised by Next.js itself (also a 308); then the table answers.
    for (let i = 0; i < 3 && pathOf(at) !== now; i++) {
      const res = await request.get(at, { maxRedirects: 0 });
      expect(res.status(), `${at} (from ${old})`).toBe(308);
      const location = res.headers().location;
      expect(location, `${at} has a Location`).toBeTruthy();
      at = location!;
      hops.push(pathOf(at));
    }
    expect(pathOf(at), `${old} → ${hops.join(' → ')}`).toBe(now);
    // Only the trailing-slash sample takes Next.js's extra normalising hop.
    expect(hops.length, old).toBe(old.endsWith('/') && old !== '/' ? 2 : 1);
    // The new URL is final.
    const final = await request.get(now, { maxRedirects: 0 });
    expect(final.status(), `${now} must not redirect again`).not.toBe(308);
  }
});

test('URLs that did not move are not redirected', async ({ request }) => {
  for (const path of UNMOVED_ROUTES) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).not.toBe(308);
  }
});

function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('console', (msg) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(msg.text())) problems.push(`CSP: ${msg.text()}`);
  });
  return problems;
}

for (const locale of ['en', 'ar'] as const) {
  test(`every old URL opens its new page in the browser (${locale})`, async ({ page }) => {
    test.setTimeout(600_000);
    const problems = watchForProblems(page);
    countApi(page);
    await paceApi();
    await page.goto('/register');
    await page.getByLabel('Email', { exact: true }).fill(`redirects-${locale}-${Date.now()}@example.test`);
    await page.getByLabel('Password').fill(`e2e-${crypto.randomUUID()}`);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).not.toHaveURL(/\/register/);
    await page.context().addCookies([localeCookie(page, locale)]);

    for (const { old, now } of OLD_ROUTE_SAMPLES) {
      await test.step(`${old} → ${now}`, async () => {
        await paceApi();
        await page.goto(old);
        await expect.poll(() => pathOf(page.url()), { message: old }).toBe(now);
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
        const main = page.locator('main');
        await expect(main).toBeVisible();
        await expect(main).not.toContainText(ERROR_BOUNDARY);
        expect(problems, `${old} reported problems`).toEqual([]);
      });
    }
  });
}
