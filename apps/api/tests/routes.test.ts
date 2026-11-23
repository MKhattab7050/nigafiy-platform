import { PROGRAM_IDS, PROGRAMS } from '@nigafiy/shared-types/programs';
import {
  currentHref,
  devicePath,
  LEGACY_ROUTES,
  legacyRedirect,
  nigafiyUrlToPath,
  OLD_ROUTE_SAMPLES,
  PROGRAM_HOME,
  programForPath,
  ROUTE_PROGRAM_IDS,
  UNMOVED_ROUTES,
} from '@nigafiy/shared-types/routes';
import { describe, expect, it } from 'vitest';

/** What the web proxy does with a request: path from the table, query kept, an action folded in. */
function resolve(url: string): string {
  const u = new URL(url, 'http://app.test');
  const next = legacyRedirect(u.pathname);
  if (!next) return u.pathname + u.search;
  for (const [k, v] of Object.entries(next.query ?? {})) u.searchParams.set(k, v);
  return next.path + u.search;
}

describe('URL namespacing (Milestone 4): every old URL still opens the right page', () => {
  it('walks the full list of pre-namespace pages', () => {
    // Every old prefix in the table has at least one sample, so a new table row cannot go untested.
    for (const r of LEGACY_ROUTES) expect(OLD_ROUTE_SAMPLES.some((s) => s.old === r.from || s.old.startsWith(`${r.from}/`) || s.old.startsWith(`${r.from}?`))).toBe(true);
    for (const { old, now } of OLD_ROUTE_SAMPLES) expect(resolve(old), old).toBe(now);
  });

  it('never redirects twice and never redirects a current URL', () => {
    for (const { now } of OLD_ROUTE_SAMPLES) expect(legacyRedirect(new URL(now, 'http://app.test').pathname), now).toBeNull();
    for (const p of UNMOVED_ROUTES) expect(legacyRedirect(p), p).toBeNull();
    for (const p of PROGRAMS.flatMap((x) => x.pages)) expect(legacyRedirect(p), p).toBeNull();
  });

  it('assigns every page to exactly one program, in its own namespace', () => {
    expect([...ROUTE_PROGRAM_IDS]).toEqual([...PROGRAM_IDS]);
    const pages = PROGRAMS.flatMap((p) => p.pages);
    expect(new Set(pages).size).toBe(pages.length);
    for (const p of PROGRAMS) {
      expect(p.home).toBe(PROGRAM_HOME[p.id]);
      for (const page of p.pages) expect(programForPath(page), page).toBe(p.id);
    }
    // Each old page now lives in the program the design assigns it to.
    for (const r of LEGACY_ROUTES) expect(programForPath(r.to)).toBe(r.program);
  });

  it('keeps device cards in the program they were opened from', () => {
    expect(devicePath('5', 'guard')).toBe('/guard/devices/5');
    expect(devicePath('5', 'hub')).toBe('/radar/devices/5');
    expect(devicePath('5')).toBe('/radar/devices/5');
    expect(programForPath('/fleet/devices/5')).toBe('fleet');
    expect(legacyRedirect('/guard/devices/5/explode')).toBeNull();
  });

  it('rewrites stored app links and leaves other links alone', () => {
    expect(currentHref('/incidents/123')).toBe('/watch/incidents/123');
    expect(currentHref('/ports?switch=2#p3')).toBe('/radar/ports?switch=2#p3');
    expect(currentHref('/guard/devices/1/pause?x=1')).toBe('/guard/devices/1?x=1&action=pause');
    expect(currentHref('https://example.com/devices/1')).toBe('https://example.com/devices/1');
    expect(currentHref('//evil.test/devices')).toBe('//evil.test/devices');
    expect(currentHref('/settings')).toBe('/settings');
  });

  it('maps nigafiy:// links 1:1 and refuses anything that could leave the app', () => {
    expect(nigafiyUrlToPath('nigafiy://fleet/endpoints/7')).toEqual({ program: 'fleet', path: '/fleet/endpoints/7' });
    expect(nigafiyUrlToPath('nigafiy://guard/devices/123/block')).toEqual({ program: 'guard', path: '/guard/devices/123/block' });
    expect(nigafiyUrlToPath('nigafiy://hub/settings')).toEqual({ program: 'hub', path: '/settings' });
    expect(nigafiyUrlToPath('nigafiy://hub')).toEqual({ program: 'hub', path: '/' });
    expect(nigafiyUrlToPath('nigafiy://radar/')).toEqual({ program: 'radar', path: '/radar' });
    expect(nigafiyUrlToPath('nigafiy://radar/devices?trust=unreviewed')).toEqual({ program: 'radar', path: '/radar/devices?trust=unreviewed' });
    expect(nigafiyUrlToPath('NIGAFIY://Toolbox/subnet')).toEqual({ program: 'toolbox', path: '/toolbox/subnet' });
    for (const bad of ['nigafiy://evil/x', 'nigafiy://radar/../settings', 'nigafiy://radar/%2e%2e/x', 'nigafiy://radar/a b', 'https://radar/devices', 'nigafiy://radar/x?<script>', 'nigafiy:radar']) {
      expect(nigafiyUrlToPath(bad), bad).toBeNull();
    }
  });
});
