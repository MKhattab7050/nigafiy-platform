#!/usr/bin/env node
// Screenshot of a Fleet page in a real browser (Playwright, installed Edge by default), signed in
// with the session that fleet.mjs keeps in its state file. Loopback only.
//   node scripts/android-emu/web-shot.mjs <path, e.g. /fleet/endpoints/<id>> <out.png> [--state f] [--web 3272] [--lang ar] [--dark]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args.splice(i, 1), true) : false;
};
const stateFile = opt('--state', path.join(os.tmpdir(), 'nigafiy-emu-fleet.json'));
const web = `http://127.0.0.1:${opt('--web', '3272')}`;
const channel = opt('--channel', 'msedge');
const lang = opt('--lang', 'en');
const dark = flag('--dark');
const [page, out] = args;

const require = createRequire(path.resolve(import.meta.dirname, '..', '..', 'apps', 'web', 'package.json'));
const { chromium } = require('@playwright/test');
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const browser = await chromium.launch({ channel });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: dark ? 'dark' : 'light', locale: lang === 'ar' ? 'ar' : 'en-US' });
await ctx.addCookies(
  state.cookie.split('; ').map((c) => {
    const i = c.indexOf('=');
    return { name: c.slice(0, i), value: c.slice(i + 1), url: web };
  }),
);
const p = await ctx.newPage();
await p.goto(`${web}${page}`, { waitUntil: 'networkidle', timeout: 180_000 });
await p.waitForTimeout(3000);
await p.screenshot({ path: out, fullPage: true });
console.log(out);
await browser.close();
