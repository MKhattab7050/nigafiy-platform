import type { Page } from '@playwright/test';

/**
 * The API allows 600 requests a minute per client (apps/api/src/app.ts), and every test here comes
 * from 127.0.0.1. Pages are opened at a pace that stays under it: each test counts the API requests
 * its page makes, and `paceApi()` waits before the next page while the last minute is near the limit.
 * One worker runs the specs one after another, so this module's count spans all of them.
 */
const stamps: number[] = [];
const WINDOW_MS = 61_000;

export function countApi(page: Page): void {
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) stamps.push(Date.now());
  });
}

export async function paceApi(limit = 400): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (stamps.length && stamps[0]! < now - WINDOW_MS) stamps.shift();
    if (stamps.length < limit) return;
    await new Promise((r) => setTimeout(r, stamps[0]! + WINDOW_MS - now + 50));
  }
}

/** The locale cookie for the whole site (a cookie set from a deeper URL would only cover that path). */
export function localeCookie(page: Page, value: 'en' | 'ar') {
  return { name: 'ld_locale', value, url: new URL('/', page.url()).href };
}
