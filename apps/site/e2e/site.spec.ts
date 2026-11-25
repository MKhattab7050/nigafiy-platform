import { type Page, expect, request, test } from '@playwright/test';
import { FIXTURE_PORT, SITE_PORT } from './playwright.config.ts';

/**
 * The static export, served as a static host would (scripts/serve.ts):
 *   1. a crawl from /, /en/ and /ar/ that requests every internal link and checks every #anchor;
 *   2. every crawled page opened in the browser, English in the light theme and Arabic in the dark
 *      theme (dir=rtl), with no console error, no page error and one <h1>;
 *   3. the Downloads page with no release file ("Not released yet", no links, sizes or hashes) and
 *      with the populated fixture release; the bundle picker; the manifest page both ways;
 *   4. keyboard focus visible, the theme and language switches, the docs search and the 404 page.
 */
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

type Crawl = { pages: string[]; anchors: { from: string; to: string; id: string }[] };

function linksOf(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
}

async function crawl(origin: string): Promise<Crawl> {
  const ctx = await request.newContext();
  const seen = new Set<string>();
  const queue = ['/', '/en/', '/ar/'];
  const anchors: Crawl['anchors'] = [];
  const bodies = new Map<string, string>();
  const broken: string[] = [];
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    const res = await ctx.get(origin + p, { maxRedirects: 0 });
    if (res.status() !== 200) {
      broken.push(`${p} → ${res.status()}`);
      continue;
    }
    const type = res.headers()['content-type'] ?? '';
    if (!type.startsWith('text/html')) continue;
    const html = await res.text();
    bodies.set(p, html);
    for (const raw of linksOf(html)) {
      if (/^(https?:|mailto:)/.test(raw)) continue;
      const u = new URL(raw, origin + p);
      if (u.origin !== origin) continue;
      if (u.hash) anchors.push({ from: p, to: u.pathname, id: decodeURIComponent(u.hash.slice(1)) });
      if (!seen.has(u.pathname)) queue.push(u.pathname);
    }
  }
  // Every #anchor exists on its page.
  for (const a of anchors) {
    const html = bodies.get(a.to);
    if (html && !html.includes(`id="${a.id}"`)) broken.push(`${a.from}: #${a.id} missing on ${a.to}`);
  }
  // The assets the pages reference (screenshots, icons, fonts in the CSS are checked by the browser pass).
  for (const [p, html] of bodies) {
    for (const m of html.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/g)) {
      const res = await ctx.get(new URL(m[1]!, origin + p).href);
      if (res.status() !== 200) broken.push(`${p}: image ${m[1]} → ${res.status()}`);
    }
  }
  await ctx.dispose();
  expect(broken, 'broken internal links, anchors or images').toEqual([]);
  return { pages: [...bodies.keys()].sort(), anchors };
}

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`);
  });
  return problems;
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('nigafiy-site-theme', t), theme);
}

/**
 * Records the first DOM changes on every page load (from document start), so an intermittent
 * hydration error (React #418, seen only on the CI runner) can be traced to what changed the page
 * before React hydrated it. Read back by pageDiagnostics() only when a page check fails.
 */
async function recordDomChanges(page: Page) {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __domLog: string[] }).__domLog = log;
    const show = (n: Node): string => {
      if (!(n instanceof Element)) return n.nodeName + (n.textContent ? `(${JSON.stringify(n.textContent.slice(0, 40))})` : '');
      const attrs = [...n.attributes].map((a) => `${a.name}="${a.value.slice(0, 60)}"`).join(' ');
      return `<${n.localName}${attrs ? ` ${attrs}` : ''}>`;
    };
    const where = (n: Node): string => {
      const parts: string[] = [];
      for (let e: Node | null = n; e && e instanceof Element && parts.length < 4; e = e.parentNode) parts.unshift(e.localName);
      return parts.join('>');
    };
    const t0 = performance.now();
    const at = () => `${Math.round(performance.now() - t0)}ms`;
    document.addEventListener('DOMContentLoaded', () => log.push(`${at()} DOMContentLoaded`));
    window.addEventListener('load', () => log.push(`${at()} load`));
    window.addEventListener('error', (e) => log.push(`${at()} error: ${String(e.message).slice(0, 80)}`));
    new MutationObserver((records) => {
      if (document.readyState === 'loading') return; // the parser building the page
      for (const r of records) {
        if (log.length > 80) return;
        if (r.type === 'attributes') log.push(`${at()} attr ${r.attributeName} on ${where(r.target)} (was ${JSON.stringify(r.oldValue)})`);
        for (const n of r.addedNodes) log.push(`${at()} + ${where(r.target)} ${show(n)}`);
        for (const n of r.removedNodes) log.push(`${at()} - ${where(r.target)} ${show(n)}`);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
  });
}

/** Runs one page's checks; on failure, adds the page's recorded DOM changes to the error. */
async function checkPage(page: Page, problems: string[], checks: () => Promise<void>) {
  try {
    await checks();
  } catch (err) {
    const log = await page.evaluate(() => (window as unknown as { __domLog?: string[] }).__domLog ?? []).catch(() => ['(no log)']);
    (err as Error).message += `\n\nProblems: ${JSON.stringify(problems)}\n\nDOM changes after parsing (diagnostic):\n${log.join('\n')}`;
    throw err;
  }
}

test.describe.configure({ mode: 'serial' });

let pages: string[] = [];

test('crawl: every internal link, anchor and image resolves (real build)', async () => {
  const c = await crawl(SITE);
  pages = c.pages;
  // Home, 9 program pages, downloads, docs, changelog, security, manifest in both languages, the docs, the chooser.
  expect(pages.length).toBeGreaterThan(100);
  for (const p of ['/', '/en/', '/ar/', '/en/downloads/', '/ar/programs/radar/', '/en/programs/sensor/', '/ar/docs/guide/routers/', '/en/docs/operations/updates/', '/en/changelog/', '/ar/security/', '/en/release-manifest/']) {
    expect(pages, p).toContain(p);
  }
  expect(c.anchors.length).toBeGreaterThan(10);
});

test('crawl: the populated fixture build has no broken internal links either', async () => {
  await crawl(FIXTURE);
});

test('every page in English (light): lang, dir, theme, one heading, no console errors', async ({ page }) => {
  test.setTimeout(600_000);
  const problems = watch(page);
  await setTheme(page, 'light');
  await recordDomChanges(page);
  for (const p of pages.filter((x) => x.startsWith('/en/'))) {
    await page.goto(p);
    await checkPage(page, problems, async () => {
    const html = page.locator('html');
    await expect(html, p).toHaveAttribute('lang', 'en');
    await expect(html, p).toHaveAttribute('dir', 'ltr');
    await expect(html, p).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('h1'), p).toHaveCount(1);
    await expect(page.locator('main'), p).toBeVisible();
    expect(problems, p).toEqual([]);
    });
  }
});

test('every page in Arabic (dark, RTL): lang, dir, theme, one heading, no console errors', async ({ page }) => {
  test.setTimeout(600_000);
  const problems = watch(page);
  await setTheme(page, 'dark');
  await recordDomChanges(page);
  for (const p of pages.filter((x) => x.startsWith('/ar/'))) {
    await page.goto(p);
    await checkPage(page, problems, async () => {
    const html = page.locator('html');
    await expect(html, p).toHaveAttribute('lang', 'ar');
    await expect(html, p).toHaveAttribute('dir', 'rtl');
    await expect(html, p).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('h1'), p).toHaveCount(1);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), p).toBe('rgb(17, 20, 24)');
    expect(problems, p).toEqual([]);
    });
  }
});

test('the dark theme follows the system when nothing is chosen', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(`${SITE}/en/`);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(17, 20, 24)');
  await ctx.close();
});

test('Downloads with no release: every item says "Not released yet", with no links, sizes or hashes', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/en/downloads/');
  await expect(page.getByTestId('no-release')).toContainText('No release of Nigafiy has been published yet');
  const rows = page.locator('tr[data-component]');
  await expect(rows).toHaveCount(10);
  for (const row of await rows.all()) await expect(row.getByTestId('not-released')).toHaveText('Not released yet');
  await expect(page.locator('main a[href^="http"]')).toHaveCount(0);
  await expect(page.locator('main a[download]')).toHaveCount(0);
  expect(await page.locator('main').textContent()).not.toMatch(/[0-9a-f]{64}|\d+(\.\d+)? (MB|KB|GB)/);
  await expect(page.locator('#store')).toContainText('Not published yet');

  await page.goto('/ar/downloads/');
  await expect(page.getByTestId('no-release')).toContainText('لم يُنشر أي إصدار');
  for (const row of await page.locator('tr[data-component]').all()) await expect(row.getByTestId('not-released')).toHaveText('لم يُصدر بعد');
  await page.goto('/en/release-manifest/');
  await expect(page.getByTestId('manifest-none')).toBeVisible();
  await expect(page.getByTestId('manifest-link')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the bundle picker shows the exact installer option for the ticked programs', async ({ page }) => {
  await page.goto('/en/downloads/#bundle');
  const picker = page.getByTestId('bundle-picker');
  await expect(picker.locator('#cmd-nsis')).toHaveText('"Nigafiy Setup <version>.exe" /S /currentuser /PROGRAMS=all');
  await expect(picker.locator('#cmd-msi')).toHaveText('msiexec /i "Nigafiy <version>.msi" /qn PROGRAMS=all');
  for (const name of ['Nigafiy Watch', 'Nigafiy Guard', 'Nigafiy Mind', 'Nigafiy Toolbox']) await picker.getByLabel(name).uncheck();
  await expect(picker.locator('#cmd-nsis')).toHaveText('"Nigafiy Setup <version>.exe" /S /currentuser /PROGRAMS=hub,radar,fleet');
  await expect(picker.locator('#cmd-msi')).toHaveText('msiexec /i "Nigafiy <version>.msi" /qn PROGRAMS=hub,radar,fleet');
  await expect(picker.getByTestId('bundle-choice')).toContainText('Nigafiy Radar, Nigafiy Fleet');
  // Hub cannot be left out, and no download button exists before a release.
  await expect(picker.getByLabel('Nigafiy Hub')).toBeDisabled();
  await expect(picker.getByLabel('Nigafiy Hub')).toBeChecked();
  await expect(picker.getByRole('link')).toHaveCount(0);
  await expect(picker).toContainText('Not released yet');
  // Keyboard: Space toggles a box.
  await picker.getByLabel('Nigafiy Mind').focus();
  await page.keyboard.press('Space');
  await expect(picker.locator('#cmd-nsis')).toHaveText('"Nigafiy Setup <version>.exe" /S /currentuser /PROGRAMS=hub,radar,fleet,mind');
});

test('Downloads with the populated fixture release: version, size, SHA-256 and links; the rest still "Not released yet"', async ({ page }) => {
  const problems = watch(page);
  await page.goto(`${FIXTURE}/en/downloads/`);
  await expect(page.getByTestId('release-line')).toContainText('9.8.7');
  const setup = page.locator('tr[data-component="desktop-windows-x64"]');
  await expect(setup).toContainText('Nigafiy Setup 9.8.7.exe');
  await expect(setup).toContainText('117.7 MB');
  await expect(setup).toContainText('123,456,789 bytes');
  await expect(setup).toContainText('0000000000000000000000000000000000000000000000000000000000000001');
  await expect(setup.getByRole('link')).toHaveAttribute('href', 'https://downloads.example.com/9.8.7/Nigafiy%20Setup%209.8.7.exe');
  await expect(page.locator('tr[data-component="endpoint-agent-windows-x64"]')).toContainText('2.7 MB');
  await expect(page.locator('tr[data-component="sensor-linux-x64"]').getByTestId('not-released')).toBeVisible();
  await expect(page.locator('tr[data-component="android-agent-apk"]').getByTestId('not-released')).toBeVisible();
  const picker = page.getByTestId('bundle-picker');
  await expect(picker.locator('#cmd-nsis')).toHaveText('"Nigafiy Setup 9.8.7.exe" /S /currentuser /PROGRAMS=all');
  await expect(picker.getByRole('link', { name: 'Download the Hub installer' })).toHaveAttribute('href', /Nigafiy%20Setup%209\.8\.7\.exe$/);

  // Arabic: values stay left-to-right inside the right-to-left page.
  await page.goto(`${FIXTURE}/ar/downloads/`);
  const hash = page.locator('tr[data-component="desktop-windows-x64"] bdi[dir="ltr"]').filter({ hasText: /^0{63}1$/ });
  await expect(hash).toHaveCount(1);
  await page.goto(`${FIXTURE}/en/release-manifest/`);
  await expect(page.getByTestId('manifest-link').getByRole('link')).toHaveAttribute('href', 'https://downloads.example.com/9.8.7/manifest.json');
  expect(problems).toEqual([]);
});

test('keyboard: skip link first, then every focused control shows a visible focus ring', async ({ page }) => {
  for (const [p, theme] of [
    ['/en/', 'light'],
    ['/ar/downloads/', 'dark'],
  ] as const) {
    await setTheme(page, theme);
    await page.goto(p);
    await page.keyboard.press('Tab');
    const skip = page.locator('.skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        return { tag: el.tagName, style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth) };
      });
      expect(ring, `${p} tab ${i + 1}`).not.toBeNull();
      expect(ring!.style, `${p} ${ring!.tag}`).not.toBe('none');
      expect(ring!.width, `${p} ${ring!.tag}`).toBeGreaterThanOrEqual(2);
    }
  }
  // The skip link moves focus to the main landmark.
  await page.goto('/en/programs/watch/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
});

test('the theme switch and the language switch', async ({ page }) => {
  await page.goto('/en/programs/radar/');
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('link', { name: 'العربية' }).click();
  await expect(page).toHaveURL(/\/ar\/programs\/radar\/$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'النظام' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  await page.getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en\/programs\/radar\/$/);
});

test('program pages show real screenshots and the honest "not verified" note', async ({ page }) => {
  await page.goto('/en/programs/guard/');
  await expect(page.locator('h1')).toHaveText('Nigafiy Guard');
  await expect(page.locator('#unverified-h')).toHaveText('Not verified on real hardware');
  await expect(page.locator('main')).toContainText('Zyxel VMG3625-T50B');
  const imgs = page.locator('.shots img');
  await expect(imgs).toHaveCount(2);
  for (const img of await imgs.all()) {
    await img.scrollIntoViewIfNeeded();
    expect(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1440);
    await expect(img).toHaveAttribute('alt', /Nigafiy Guard: /);
  }
  await page.goto('/ar/programs/fleet/');
  await expect(page.locator('.shots img').first()).toHaveAttribute('src', '/screenshots/ar/fleet-endpoints.png');
});

test('docs: search in the browser, English-only docs labelled on the Arabic site, the Arabic guide', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/en/docs/');
  await page.getByLabel('Search the docs').fill('Ed25519');
  await expect(page.getByTestId('search-results').locator('li').first()).toBeVisible();
  await expect(page.getByTestId('search-results')).toContainText('Updates');
  await page.goto('/ar/docs/');
  await page.getByLabel('ابحث في الوثائق').fill('الراوتر');
  await expect(page.getByTestId('search-results').getByRole('link', { name: /الوصول إلى الراوتر/ }).first()).toBeVisible();
  await page.goto('/ar/docs/operations/updates/');
  await expect(page.locator('main')).toContainText('بالإنجليزية فقط');
  await expect(page.locator('main [lang="en"][dir="ltr"] h1')).toHaveText('Updates');
  await page.goto('/ar/docs/guide/routers/');
  await expect(page.locator('h1')).toHaveText('الوصول إلى الراوتر');
  await expect(page.locator('main bdi[dir="ltr"]').first()).toBeVisible();
  expect(problems).toEqual([]);
});

test('404: an unknown address answers 404 with the bilingual page', async ({ page }) => {
  const res = await page.goto('/en/no-such-page/');
  expect(res?.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('Page not found');
  await expect(page.locator('[lang="ar"]')).toContainText('الصفحة غير موجودة');
  await expect(page.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/en/');
});

test('sitemap.xml and robots.txt', async ({ request: req }) => {
  const sitemap = await (await req.get('/sitemap.xml')).text();
  expect(sitemap).toContain('<loc>http://127.0.0.1:3290/en/downloads/</loc>');
  expect(sitemap).toContain('hreflang="ar" href="http://127.0.0.1:3290/ar/downloads/"');
  const robots = await (await req.get('/robots.txt')).text();
  expect(robots).toContain('Sitemap: http://127.0.0.1:3290/sitemap.xml');
  expect((await req.get('/og.png')).headers()['content-type']).toBe('image/png');
  expect((await req.get('/favicon.ico')).status()).toBe(200);
});

test('no third-party requests, cookies or trackers', async ({ page, context }) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(SITE) && !r.url().startsWith('data:')) outside.push(r.url());
  });
  for (const p of ['/en/', '/ar/downloads/', '/en/docs/', '/en/programs/fleet/']) await page.goto(p);
  expect(outside).toEqual([]);
  expect(await context.cookies()).toEqual([]);
});

test('phone width (375 px): no page scrolls sideways', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  for (const p of ['/en/', '/ar/', '/en/downloads/', '/ar/downloads/', '/en/programs/fleet/', '/ar/docs/operations/installers/', '/en/docs/features/fleet-pro/', '/en/changelog/', '/ar/security/', '/en/release-manifest/']) {
    await page.goto(SITE + p);
    const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll, p).toBeLessThanOrEqual(inner);
  }
  await ctx.close();
});
