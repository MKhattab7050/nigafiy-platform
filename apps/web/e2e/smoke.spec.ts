import { type Page, expect, test } from '@playwright/test';
import type { ProgramId } from '../../../packages/shared-types/src/programs';
import { countApi, localeCookie, paceApi } from './api-budget';
import { type Seeded, seedRecords } from './seed';

/**
 * One account walks every page a signed-in user can open, in English (light theme) and then in
 * Arabic (RTL, dark theme). The list is every page.tsx under app/(app): the static pages below plus
 * one of each detail page, opened on records seed.ts creates through the real API. For every
 * screen: the page heading renders, the screen did not fall into its error boundary, the shell
 * shows the page's program (html[data-program]), html dir/lang/data-theme match the locale and
 * theme, the old product name is not left in the visible text or the title, and the browser reported no
 * uncaught error and no Content-Security-Policy violation.
 */
type Screen = { path: string; name: string; program: ProgramId; sections?: readonly string[] };

const SCREENS: readonly Screen[] = [
  // Hub
  { path: '/', name: 'Dashboard', program: 'hub' },
  { path: '/programs', name: 'Hub, Programs', program: 'hub' },
  { path: '/sensors', name: 'Hub, Sensors', program: 'hub' },
  { path: '/portfolio', name: 'Hub, Portfolio', program: 'hub' },
  { path: '/system/modules', name: 'Hub, System modules', program: 'hub' },
  { path: '/settings', name: 'Settings (system health, LAN TLS, SSO)', program: 'hub', sections: ['#system', '#tls', '#sso'] },
  // Radar
  { path: '/radar/devices', name: 'Devices', program: 'radar' },
  { path: '/radar/discovery', name: 'Discovery', program: 'radar' },
  { path: '/radar/ipam', name: 'Radar, IPAM and IPv6', program: 'radar' },
  { path: '/radar/ports', name: 'Switch ports', program: 'radar' },
  { path: '/radar/topology', name: 'Radar, Topology', program: 'radar' },
  // Watch
  { path: '/watch/monitoring', name: 'Monitoring (checks)', program: 'watch' },
  { path: '/watch/events', name: 'Watch, Events', program: 'watch' },
  { path: '/watch/incidents', name: 'Incidents', program: 'watch' },
  { path: '/watch/doctor', name: 'Watch, Network Doctor', program: 'watch' },
  { path: '/watch/time-machine', name: 'Watch, Time machine', program: 'watch' },
  { path: '/watch/impact', name: 'Watch, Impact', program: 'watch' },
  { path: '/watch/insights', name: 'Watch, Insights', program: 'watch' },
  { path: '/watch/reports', name: 'Watch, Reports', program: 'watch' },
  { path: '/watch/notifications', name: 'Watch, Notifications', program: 'watch' },
  { path: '/watch/maintenance', name: 'Watch, Maintenance windows', program: 'watch' },
  // Guard
  { path: '/guard/security', name: 'Guard, Security', program: 'guard' },
  { path: '/guard/access', name: 'Guard, Access', program: 'guard' },
  { path: '/guard/routers', name: 'Routers', program: 'guard' },
  { path: '/guard/port-control', name: 'Guard, Switch port control', program: 'guard' },
  { path: '/guard/config-backup', name: 'Guard, Config backup', program: 'guard' },
  // Fleet
  { path: '/fleet/endpoints', name: 'Endpoints', program: 'fleet' },
  { path: '/fleet/sessions', name: 'Fleet, Remote sessions', program: 'fleet' },
  { path: '/fleet/requests', name: 'Fleet, Help requests', program: 'fleet' },
  { path: '/fleet/policies', name: 'Fleet, Access policies', program: 'fleet' },
  { path: '/fleet/approvals', name: 'Fleet, Approvals', program: 'fleet' },
  { path: '/fleet/scripts', name: 'Fleet, Scripts', program: 'fleet' },
  { path: '/fleet/jobs', name: 'Fleet, Jobs', program: 'fleet' },
  { path: '/fleet/patches', name: 'Fleet, Patches', program: 'fleet' },
  { path: '/fleet/monitoring', name: 'Fleet, Monitoring rules', program: 'fleet' },
  // Mind
  { path: '/mind/automation', name: 'Mind, Automation', program: 'mind' },
  { path: '/mind/knowledge', name: 'Mind, Knowledge', program: 'mind' },
  { path: '/mind/playbooks', name: 'Mind, Playbooks', program: 'mind' },
  { path: '/mind/playbooks/runs', name: 'Mind, Playbook runs', program: 'mind' },
  // Toolbox
  { path: '/toolbox', name: 'Toolbox, Tools', program: 'toolbox' },
  { path: '/toolbox/subnet', name: 'Toolbox, Subnet calculator', program: 'toolbox' },
  // The user guide (Hub)
  { path: '/guide', name: 'User guide', program: 'hub' },
  { path: '/guide/routers', name: 'User guide, Reach your router', program: 'hub' },
  { path: '/guide/fleet-enroll', name: 'User guide, Add a computer to Fleet', program: 'hub' },
];

/** One of each detail page, on the seeded records. */
function detailScreens(s: Seeded): Screen[] {
  return [
    ...(['radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'] as const).map((program) => ({
      path: `/${program}/devices/${s.deviceId}`,
      name: `Device card in ${program}`,
      program,
    })),
    { path: `/watch/incidents/${s.incidentId}`, name: 'Incident detail', program: 'watch' },
    { path: `/guard/routers/${s.routerId}`, name: 'Router detail', program: 'guard' },
    { path: `/guard/config-backup/${s.configTargetId}`, name: 'Config backup target (backup and restore)', program: 'guard' },
    { path: `/fleet/endpoints/${s.endpointId}`, name: 'Endpoint detail', program: 'fleet' },
    { path: `/fleet/endpoints/${s.endpointId}?tab=security`, name: 'Endpoint, security and compliance', program: 'fleet' },
    { path: `/fleet/endpoints/${s.endpointId}?tab=desktop`, name: 'Endpoint, remote desktop', program: 'fleet' },
    { path: `/fleet/endpoints/${s.endpointId}?tab=files`, name: 'Endpoint, files', program: 'fleet' },
    { path: `/fleet/endpoints/${s.endpointId}?tab=software`, name: 'Endpoint, software', program: 'fleet' },
    { path: `/fleet/endpoints/${s.endpointId}?tab=hardware`, name: 'Endpoint, hardware and licences', program: 'fleet' },
    { path: `/fleet/endpoints/${s.endpointId}?tab=patches`, name: 'Endpoint, patches', program: 'fleet' },
    { path: `/fleet/endpoints/${s.endpointId}?tab=commands`, name: 'Endpoint, commands', program: 'fleet' },
    { path: `/fleet/endpoints/${s.endpointId}?tab=shell`, name: 'Endpoint, remote shell', program: 'fleet' },
    // The Android phone: its own panel (actions, apps, wipe) and the tabs a phone has.
    { path: `/fleet/endpoints/${s.androidEndpointId}`, name: 'Android endpoint', program: 'fleet', sections: ['[data-testid="android-panel"]'] },
    { path: `/fleet/endpoints/${s.androidEndpointId}?tab=security`, name: 'Android endpoint, security and compliance', program: 'fleet' },
    { path: `/fleet/endpoints/${s.androidEndpointId}?tab=software`, name: 'Android endpoint, apps', program: 'fleet' },
    { path: `/fleet/endpoints/${s.androidEndpointId}?tab=commands`, name: 'Android endpoint, commands', program: 'fleet' },
    { path: `/mind/knowledge/${s.knowledgeId}`, name: 'Knowledge article', program: 'mind' },
    { path: `/mind/playbooks/${s.playbookId}`, name: 'Playbook editor', program: 'mind' },
    { path: `/mind/playbooks/new`, name: 'New playbook', program: 'mind' },
    { path: `/mind/playbooks/runs/${s.runId}`, name: 'Playbook run', program: 'mind' },
  ];
}

const ERROR_BOUNDARY = /This page could not be displayed|تعذّر عرض هذه الصفحة/;
// The old product name, spelled out of pieces so the brand check (pnpm check:brand) does not flag this line.
const OLD_NAME = new RegExp(['lan', 'detective'].join('[ -]'), 'i');

function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) problems.push(`CSP: ${text}`);
  });
  return problems;
}

type Look = { locale: 'en' | 'ar'; theme: 'light' | 'dark' };

async function visitAll(page: Page, problems: string[], screens: readonly Screen[], look: Look) {
  for (const screen of screens) {
    await test.step(`${screen.name} (${look.locale})`, async () => {
      await paceApi();
      await page.goto(screen.path);
      const html = page.locator('html');
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(main).not.toContainText(ERROR_BOUNDARY);
      // The shell paints the page in its program's accent.
      await expect(html).toHaveAttribute('data-program', screen.program);
      await expect(html).toHaveAttribute('dir', look.locale === 'ar' ? 'rtl' : 'ltr');
      await expect(html).toHaveAttribute('lang', look.locale);
      await expect(html).toHaveAttribute('data-theme', look.theme);
      for (const section of screen.sections ?? []) await expect(page.locator(section)).toBeVisible();
      // Let the screen's data arrive before reading its text.
      await page.waitForLoadState('networkidle').catch(() => undefined);
      expect(await page.title(), `${screen.path} title`).not.toMatch(OLD_NAME);
      await expect(page.locator('body'), `${screen.path} visible text`).not.toContainText(OLD_NAME, { useInnerText: true });
      expect(problems, `${screen.path} reported problems`).toEqual([]);
    });
  }
}

async function setTheme(page: Page, theme: Look['theme']) {
  await page.evaluate((v) => localStorage.setItem('ld_theme', v), theme);
}

async function register(page: Page, prefix: string) {
  await paceApi();
  await page.goto('/register');
  await page.getByLabel('Work email').fill(`${prefix}-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill(`e2e-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).not.toHaveURL(/\/register/);
}

test('sign up, walk every screen in English and Arabic, sign out and back in', async ({ page }) => {
  test.setTimeout(1_200_000);
  const problems = watchForProblems(page);
  countApi(page);
  const email = `e2e-${Date.now()}@example.test`;
  const password = `e2e-${crypto.randomUUID()}`;
  let screens: Screen[] = [];

  await test.step('register', async () => {
    await paceApi();
    await page.goto('/register');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).not.toHaveURL(/\/register/);
    await expect(page.locator('main')).toBeVisible();
  });

  await test.step('seed one record of each kind', async () => {
    screens = [...SCREENS, ...detailScreens(await seedRecords(page))];
  });

  await test.step('English (LTR, light)', async () => {
    await setTheme(page, 'light');
    await visitAll(page, problems, screens, { locale: 'en', theme: 'light' });
  });

  await test.step('Arabic (RTL, dark)', async () => {
    await page.context().addCookies([localeCookie(page, 'ar')]);
    await setTheme(page, 'dark');
    await visitAll(page, problems, screens, { locale: 'ar', theme: 'dark' });
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

test('the help button opens the guide for the page, in English (light) and Arabic (RTL, dark); the guide searches and marks programs left out', async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watchForProblems(page);
  countApi(page);
  await register(page, 'guide');

  await test.step('English, light: keyboard to the help button on Devices', async () => {
    await setTheme(page, 'light');
    await paceApi();
    await page.goto('/radar/devices');
    const help = page.getByRole('link', { name: 'Help for this page' });
    await expect(help).toHaveAttribute('href', '/guide/devices');
    await help.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/guide\/devices$/);
    await expect(page.locator('main').getByRole('heading', { level: 1 })).toHaveText('Add and organize devices');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    // The discovery page opens its sub-heading.
    await paceApi();
    await page.goto('/radar/discovery');
    await expect(page.getByRole('link', { name: 'Help for this page' })).toHaveAttribute('href', '/guide/first-scan#scope');

    // The guide's front page: Mind is left out of this test install (global-setup), so its section says so.
    await page.getByRole('link', { name: 'User guide' }).first().click();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(page.locator('[data-guide-section="mind"]')).toContainText('Not installed');
    await expect(page.locator('[data-guide-section="radar"]')).not.toContainText('Not installed');
    await page.getByLabel('Search the guide').fill('router credentials');
    await page.locator('main').getByRole('link', { name: /Reach your router/ }).click();
    await expect(page).toHaveURL(/\/guide\/routers/);
    await expect(page.locator('#safety')).toBeVisible();

    // The global search lists guide sections too.
    await page.getByRole('button', { name: 'Global search' }).click();
    await page.getByRole('dialog').getByRole('searchbox').fill('Quick Support');
    await expect(page.locator('[data-search-guide]')).toContainText('Add a computer to Fleet');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: test.info().outputPath('guide-en.png'), fullPage: true });
  });

  await test.step('Arabic, RTL, dark: the help button on Routers', async () => {
    await page.context().addCookies([localeCookie(page, 'ar')]);
    await setTheme(page, 'dark');
    await paceApi();
    await page.goto('/guard/routers');
    await page.getByRole('link', { name: 'مساعدة لهذه الصفحة' }).click();
    await expect(page).toHaveURL(/\/guide\/routers$/);
    await expect(page.locator('main').getByRole('heading', { level: 1 })).toHaveText('الوصول إلى الراوتر');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // Technical values stay left-to-right inside Arabic text.
    await expect(page.locator('main bdi[dir="ltr"]').first()).toBeVisible();

    await paceApi();
    await page.goto('/guide');
    await expect(page.locator('[data-guide-section="mind"]')).toContainText('غير مثبّت');
    // An English word finds the section on the Arabic page, shown in Arabic.
    await page.getByLabel('ابحث في الدليل').fill('router');
    await expect(page.locator('main').getByRole('link', { name: /الوصول إلى الراوتر/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('guide-ar.png'), fullPage: true });
    await page.context().addCookies([localeCookie(page, 'en')]);
  });
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

test('Android: the phone page and the enrollment codes, in English (light) and Arabic (RTL, dark)', async ({ page }) => {
  test.setTimeout(300_000);
  const problems = watchForProblems(page);
  countApi(page);
  await register(page, 'android');
  const s = await seedRecords(page);

  await setTheme(page, 'light');
  await paceApi();
  await page.goto(`/fleet/endpoints/${s.androidEndpointId}`);
  const panel = page.getByTestId('android-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('main')).toContainText('E2E-Phone-01');
  await expect(panel.getByRole('button', { name: 'Erase phone' })).toBeVisible();
  // A phone has no hardware, patches or shell tab, and no CPU load.
  await expect(page.getByRole('tab', { name: /shell/i })).toHaveCount(0);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: test.info().outputPath('android-endpoint-en-light.png'), fullPage: true });

  // Enrolling a phone: the app link QR and the Device Owner section.
  await paceApi();
  await page.goto('/fleet/endpoints');
  await page.getByRole('button', { name: 'Enroll endpoint' }).click();
  await page.getByLabel('Device label').fill('E2E-Phone-02');
  await page.getByRole('dialog').getByRole('combobox').last().selectOption('android');
  await page.getByRole('button', { name: 'Create & generate enrollment credentials' }).click();
  const enroll = page.getByTestId('android-enroll');
  await expect(enroll).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Enroll an Android phone');
  await expect(enroll.getByRole('img', { name: /^QR code: / }).first()).toBeVisible();
  await expect(enroll).toContainText('Device Owner');
  await expect(enroll).toContainText('adb shell dpm set-device-owner');
  await page.screenshot({ path: test.info().outputPath('android-enroll-en-light.png'), fullPage: true });

  await page.context().addCookies([localeCookie(page, 'ar')]);
  await setTheme(page, 'dark');
  await paceApi();
  await page.goto(`/fleet/endpoints/${s.androidEndpointId}`);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(html).toHaveAttribute('lang', 'ar');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('android-panel')).toBeVisible();
  await expect(page.getByTestId('android-panel').getByRole('button', { name: 'مسح الهاتف' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(ERROR_BOUNDARY);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: test.info().outputPath('android-endpoint-ar-dark.png'), fullPage: true });
  await page.context().addCookies([localeCookie(page, 'en')]);
  expect(problems).toEqual([]);
});
