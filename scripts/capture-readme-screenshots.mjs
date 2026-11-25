#!/usr/bin/env node
// Captures the README screenshots (docs/assets/readme/screens/*.webp) from a running web console
// that holds the SIMULATED demo organization, and frames each one in a browser window.
//
//   1. Start a throw-away stack on loopback (any free ports), for example an embedded PostgreSQL, the
//      API (`node apps/api/src/main.ts`) and `next start` of apps/web pointed at that API.
//   2. API_URL=http://127.0.0.1:<api port> node scripts/seed-simulated.mjs   (invented data only)
//   3. README_WEB_URL=http://127.0.0.1:<web port> node scripts/capture-readme-screenshots.mjs
//
// It signs in with the login seed-simulated.mjs wrote to .data/simulated-login.txt, refuses any
// address that is not loopback, and never starts a scan. Uses the installed Microsoft Edge through
// the Playwright that apps/web already depends on; WebP encoding is done by the browser itself.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { chromium } = createRequire(path.join(root, 'apps/web/package.json'))('@playwright/test');
const BASE = process.env.README_WEB_URL ?? 'http://127.0.0.1:3147';
const host = new URL(BASE).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error(`refusing a non-loopback address: ${BASE}`);
const out = path.join(root, 'docs/assets/readme/screens');
mkdirSync(out, { recursive: true });

// --social: render docs/assets/readme/social-preview.svg (from make-readme-art.mjs) to the 1280×640
// PNG GitHub uses as the repository's social preview. Needs no running stack.
if (process.argv.includes('--social')) {
  const svg = readFileSync(path.join(root, 'docs/assets/readme/social-preview.svg'), 'utf8');
  const b = await chromium.launch({ channel: process.env.README_BROWSER_CHANNEL ?? 'msedge' });
  const p = await b.newPage({ viewport: { width: 1280, height: 640 } });
  await p.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
  const file = path.join(root, 'docs/assets/readme/social-preview.png');
  await p.screenshot({ path: file, clip: { x: 0, y: 0, width: 1280, height: 640 } });
  await b.close();
  console.log(path.relative(root, file));
  process.exit(0);
}

const login = readFileSync(path.join(root, '.data/simulated-login.txt'), 'utf8');
const email = login.match(/email: (.*)/)?.[1].trim();
const password = login.match(/password: (.*)/)?.[1].trim();
if (!login.includes('SIMULATED') || !email || !password) throw new Error('run scripts/seed-simulated.mjs first');

// The URL shown in the frame is the dev console address, not the throw-away one.
const SHOWN_ORIGIN = 'localhost:3100';
const VIEW = { width: 1440, height: 900 };

/** Pages to capture: a path, or a function that finds the path through the API. */
const SHOTS = [
  { name: 'dashboard', path: async () => '/' },
  { name: 'radar-devices', path: async () => '/radar/devices' },
  {
    name: 'watch-incident',
    path: async (api) => {
      const items = (await api('/incidents?status=all')).items;
      const wan = items.find((i) => /internet/i.test(i.title)) ?? items[0];
      return `/watch/incidents/${wan.id}`;
    },
  },
  {
    name: 'fleet-endpoint',
    path: async (api) => {
      const items = (await api('/endpoints')).items;
      return `/fleet/endpoints/${(items.find((e) => e.platform === 'windows') ?? items[0]).id}`;
    },
  },
];
const VARIANTS = [
  { theme: 'light', locale: 'en' },
  { theme: 'dark', locale: 'ar' },
];

function frameHtml(png, theme, url) {
  const dark = theme === 'dark';
  const c = dark
    ? { bar: '#161B26', stroke: '#2A3348', pill: '#0F141E', text: '#9AA6BF', dot: '#3A4459' }
    : { bar: '#F3F5F9', stroke: '#D9DFEA', pill: '#FFFFFF', text: '#56607A', dot: '#C9D0DD' };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}body{display:inline-block}
#f{display:inline-block;margin:28px 36px 44px;border-radius:14px;overflow:hidden;border:1px solid ${c.stroke};
box-shadow:0 1px 2px rgba(11,31,92,.10),0 18px 40px -12px rgba(11,31,92,${dark ? '.55' : '.28'});background:${c.bar}}
.bar{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid ${c.stroke}}
.d{width:12px;height:12px;border-radius:50%;background:${c.dot}}
.u{margin:0 auto;transform:translateX(-26px);min-width:420px;height:28px;border-radius:8px;background:${c.pill};border:1px solid ${c.stroke};
color:${c.text};font:500 13px 'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;gap:8px}
.u svg{width:12px;height:12px}
img{display:block;width:${VIEW.width}px;height:${VIEW.height}px}
</style></head><body><div id="f"><div class="bar"><span class="d"></span><span class="d"></span><span class="d"></span>
<span class="u"><svg viewBox="0 0 24 24" fill="none" stroke="${c.text}" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>${url}</span></div>
<img alt="" src="data:image/png;base64,${png.toString('base64')}"></div></body></html>`;
}

const browser = await chromium.launch({ channel: process.env.README_BROWSER_CHANNEL ?? 'msedge' });
try {
  for (const v of VARIANTS) {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: VIEW, colorScheme: v.theme, deviceScaleFactor: 1, locale: v.locale === 'ar' ? 'ar' : 'en-US' });
    await ctx.addCookies([{ name: 'ld_locale', value: v.locale, url: BASE }]);
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('ld_theme', t);
      } catch {}
    }, v.theme);
    const res = await ctx.request.post('/api/v1/auth/login', { headers: { 'X-LD-CSRF': '1', Origin: BASE }, data: { email, password } });
    if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
    const api = async (p) => (await ctx.request.get(`/api/v1${p}`)).json();
    const page = await ctx.newPage();
    for (const shot of SHOTS) {
      const p = await shot.path(api);
      await page.goto(p, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      // Hide the text caret and any scrollbar so the frame shows the page only.
      await page.addStyleTag({ content: '*{caret-color:transparent!important}::-webkit-scrollbar{display:none}' });
      const png = await page.screenshot();
      const framePage = await ctx.newPage();
      await framePage.setViewportSize({ width: VIEW.width + 140, height: VIEW.height + 160 });
      await framePage.setContent(frameHtml(png, v.theme, `${SHOWN_ORIGIN}${p.replace(/[0-9a-f-]{36}/, (id) => `${id.slice(0, 8)}…`)}`));
      const framed = await framePage.locator('body').screenshot({ omitBackground: true });
      // Encode as WebP in the browser (keeps the transparent shadow; no image library needed).
      const webp = await framePage.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/webp', 0.86).split(',')[1];
      }, framed.toString('base64'));
      await framePage.close();
      const file = path.join(out, `${shot.name}-${v.locale}-${v.theme}.webp`);
      writeFileSync(file, Buffer.from(webp, 'base64'));
      console.log(path.relative(root, file), Math.round(Buffer.from(webp, 'base64').length / 1024), 'KB');
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
