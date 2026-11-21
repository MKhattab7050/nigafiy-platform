// The Nigafiy URL scheme (Milestone 4): one table read by the web proxy (redirects), the web links,
// the API (links it writes: search results, insights, controls, e-mails), the desktop runtime and the tests.
// No runtime dependencies, so the API runs it untranspiled under Node 24.

// Type-only import: erased at run time, so this file has no runtime imports (Node runs it untranspiled).
import type { ProgramId } from './programs.ts';

/** The same ids as PROGRAM_IDS in programs.ts (a test keeps them equal). */
export const ROUTE_PROGRAM_IDS = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'] as const satisfies readonly ProgramId[];
const PROGRAM_IDS: readonly ProgramId[] = ROUTE_PROGRAM_IDS;

/** An old (pre-Milestone-4) URL prefix and the prefix that replaces it. */
export interface LegacyRoute {
  readonly from: string;
  readonly to: string;
  readonly program: ProgramId;
}

/**
 * Every page that existed before program namespacing, and where it lives now.
 * Hub pages (`/`, `/settings`, `/portfolio`), Toolbox (`/toolbox`) and the sign-in pages
 * (`/login`, `/register`, `/invite/<token>`, `/reset-password`) kept their URLs.
 */
export const LEGACY_ROUTES: readonly LegacyRoute[] = [
  { from: '/devices', to: '/radar/devices', program: 'radar' },
  { from: '/discovery', to: '/radar/discovery', program: 'radar' },
  { from: '/topology', to: '/radar/topology', program: 'radar' },
  { from: '/ipam', to: '/radar/ipam', program: 'radar' },
  { from: '/ports', to: '/radar/ports', program: 'radar' },
  { from: '/monitoring', to: '/watch/monitoring', program: 'watch' },
  { from: '/events', to: '/watch/events', program: 'watch' },
  { from: '/incidents', to: '/watch/incidents', program: 'watch' },
  { from: '/doctor', to: '/watch/doctor', program: 'watch' },
  { from: '/time-machine', to: '/watch/time-machine', program: 'watch' },
  { from: '/impact', to: '/watch/impact', program: 'watch' },
  // The summary report was listed as a page in the design (spec §5); kept for any bookmark of it.
  { from: '/reports', to: '/watch/reports', program: 'watch' },
  { from: '/security', to: '/guard/security', program: 'guard' },
  { from: '/access', to: '/guard/access', program: 'guard' },
  { from: '/routers', to: '/guard/routers', program: 'guard' },
  { from: '/config-backup', to: '/guard/config-backup', program: 'guard' },
  { from: '/endpoints', to: '/fleet/endpoints', program: 'fleet' },
  { from: '/knowledge', to: '/mind/knowledge', program: 'mind' },
  { from: '/playbooks', to: '/mind/playbooks', program: 'mind' },
];

/** Program namespaces in the URL. Hub owns the root. */
export const PROGRAM_PREFIX: Readonly<Record<ProgramId, string>> = {
  hub: '',
  radar: '/radar',
  watch: '/watch',
  guard: '/guard',
  fleet: '/fleet',
  mind: '/mind',
  toolbox: '/toolbox',
};

/** Where each program opens. `/radar` alone redirects here. */
export const PROGRAM_HOME: Readonly<Record<ProgramId, string>> = {
  hub: '/',
  radar: '/radar/devices',
  watch: '/watch/monitoring',
  guard: '/guard/security',
  fleet: '/fleet/endpoints',
  mind: '/mind/knowledge',
  toolbox: '/toolbox',
};

const isProgramId = (v: string): v is ProgramId => (PROGRAM_IDS as readonly string[]).includes(v);

/** Device-card actions that a `nigafiy://<program>/devices/<id>/<action>` link may ask for. */
export const DEVICE_ACTIONS = [
  // Radar
  'identify',
  'trust',
  'wake',
  // Watch
  'monitor',
  'mute',
  'incidents',
  'events',
  'impact',
  // Guard
  'block',
  'pause',
  'quarantine',
  'router',
  'backup',
  // Fleet
  'remote',
  'files',
  'enroll',
  // Mind
  'knowledge',
  // Toolbox
  'ping',
  'ports',
] as const;
export type DeviceAction = (typeof DEVICE_ACTIONS)[number];

const startsWithSegment = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/** The program that owns a URL path (the shell's current program). Anything outside a namespace is Hub. */
export function programForPath(pathname: string): ProgramId {
  const first = pathname.split('/')[1] ?? '';
  return isProgramId(first) && first !== 'hub' ? first : 'hub';
}

/** Programs that show the shared device card under their own namespace. Hub links go to Radar. */
export function devicePath(id: string, program: ProgramId = 'radar'): string {
  const owner = program === 'hub' ? 'radar' : program;
  return `${PROGRAM_PREFIX[owner]}/devices/${encodeURIComponent(id)}`;
}

/**
 * Where an incoming path must go instead, or null when it is already a current URL.
 * Covers old pre-namespace URLs, program roots (`/radar` → its home, `/hub` → `/`) and
 * device-action paths (`/guard/devices/7/block` → `/guard/devices/7?action=block`).
 * The query string is the caller's to keep; an `action` produced here is returned in `query`.
 */
export function legacyRedirect(pathname: string): { path: string; query?: Record<string, string> } | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/hub' || path.startsWith('/hub/')) {
    const rest = path.slice(4);
    const inner = rest === '' ? '/' : rest;
    return legacyRedirect(inner) ?? { path: inner };
  }
  for (const r of LEGACY_ROUTES) {
    if (startsWithSegment(path, r.from)) {
      const next = r.to + path.slice(r.from.length);
      return legacyRedirect(next) ?? { path: next };
    }
  }
  for (const id of PROGRAM_IDS) {
    const prefix = PROGRAM_PREFIX[id];
    if (prefix && path === prefix && PROGRAM_HOME[id] !== prefix) return { path: PROGRAM_HOME[id] };
  }
  const action = /^\/(radar|watch|guard|fleet|mind|toolbox)\/devices\/([^/]+)\/([a-z]+)$/.exec(path);
  if (action) {
    const [, program, id, name] = action;
    if ((DEVICE_ACTIONS as readonly string[]).includes(name!)) return { path: `/${program}/devices/${id}`, query: { action: name! } };
  }
  if (path !== pathname) return { path };
  return null;
}

/** Rewrites an app-relative link written before Milestone 4 (e.g. stored in a knowledge article). Leaves anything else alone. */
export function currentHref(href: string): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const cut = href.search(/[?#]/);
  const path = cut < 0 ? href : href.slice(0, cut);
  const tail = cut < 0 ? '' : href.slice(cut);
  const next = legacyRedirect(path);
  if (!next) return href;
  const extra = next.query ? new URLSearchParams(next.query).toString() : '';
  if (!extra) return next.path + tail;
  return tail.startsWith('?') ? `${next.path}${tail}&${extra}` : `${next.path}?${extra}${tail}`;
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * `nigafiy://<program>/<path>[?query]` → the app path it opens, or null when the link is not one of ours.
 * Maps 1:1 (`nigafiy://fleet/endpoints/7` → `/fleet/endpoints/7`, `nigafiy://hub/settings` → `/settings`).
 * Segments are restricted to unreserved characters and `..` is refused, so a link can never leave the app.
 */
export function nigafiyUrlToPath(link: string): { program: ProgramId; path: string } | null {
  const m = /^nigafiy:\/\/([a-z]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(link.trim());
  if (!m) return null;
  const program = m[1]!.toLowerCase();
  if (!isProgramId(program)) return null;
  const rest = (m[2] ?? '').replace(/\/+$/, '');
  const segments = rest.split('/').filter(Boolean);
  if (segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) return null;
  const query = m[3] && m[3].length > 1 ? m[3] : '';
  if (query && !/^\?[A-Za-z0-9._~\-=&%+]*$/.test(query)) return null;
  const base = PROGRAM_PREFIX[program];
  const path = segments.length ? `${base}/${segments.join('/')}` : base || '/';
  return { program, path: path + query };
}

/**
 * Every pre-Milestone-4 page with a sample id or query, and the URL it must open now.
 * Walked by the redirect tests (API unit test and the browser test against the real server).
 */
export const OLD_ROUTE_SAMPLES: readonly { readonly old: string; readonly now: string }[] = [
  { old: '/devices', now: '/radar/devices' },
  { old: '/devices?trust=unreviewed', now: '/radar/devices?trust=unreviewed' },
  { old: '/devices/3f2c7a1e-0000-4000-8000-000000000001', now: '/radar/devices/3f2c7a1e-0000-4000-8000-000000000001' },
  { old: '/discovery', now: '/radar/discovery' },
  { old: '/topology', now: '/radar/topology' },
  { old: '/ipam', now: '/radar/ipam' },
  { old: '/ipam?subnet=42', now: '/radar/ipam?subnet=42' },
  { old: '/ports', now: '/radar/ports' },
  { old: '/ports?switch=7', now: '/radar/ports?switch=7' },
  { old: '/monitoring', now: '/watch/monitoring' },
  { old: '/events', now: '/watch/events' },
  { old: '/events?type=ip_mac_changed', now: '/watch/events?type=ip_mac_changed' },
  { old: '/incidents', now: '/watch/incidents' },
  { old: '/incidents/9', now: '/watch/incidents/9' },
  { old: '/doctor', now: '/watch/doctor' },
  { old: '/time-machine', now: '/watch/time-machine' },
  { old: '/impact', now: '/watch/impact' },
  { old: '/impact?site=1&device=2', now: '/watch/impact?site=1&device=2' },
  { old: '/reports', now: '/watch/reports' },
  { old: '/security', now: '/guard/security' },
  { old: '/access', now: '/guard/access' },
  { old: '/routers', now: '/guard/routers' },
  { old: '/routers/5', now: '/guard/routers/5' },
  { old: '/routers/5?edit=credentials', now: '/guard/routers/5?edit=credentials' },
  { old: '/config-backup', now: '/guard/config-backup' },
  { old: '/config-backup/11', now: '/guard/config-backup/11' },
  { old: '/endpoints', now: '/fleet/endpoints' },
  { old: '/endpoints?enroll_device=4', now: '/fleet/endpoints?enroll_device=4' },
  { old: '/endpoints/7', now: '/fleet/endpoints/7' },
  { old: '/knowledge', now: '/mind/knowledge' },
  { old: '/knowledge/12', now: '/mind/knowledge/12' },
  { old: '/playbooks', now: '/mind/playbooks' },
  { old: '/playbooks/new', now: '/mind/playbooks/new' },
  { old: '/playbooks/8', now: '/mind/playbooks/8' },
  { old: '/playbooks/runs', now: '/mind/playbooks/runs' },
  { old: '/playbooks/runs/13', now: '/mind/playbooks/runs/13' },
  { old: '/devices/', now: '/radar/devices' },
  { old: '/radar', now: '/radar/devices' },
  { old: '/watch', now: '/watch/monitoring' },
  { old: '/guard', now: '/guard/security' },
  { old: '/fleet', now: '/fleet/endpoints' },
  { old: '/mind', now: '/mind/knowledge' },
  { old: '/hub', now: '/' },
  { old: '/hub/settings', now: '/settings' },
  { old: '/guard/devices/77/block', now: '/guard/devices/77?action=block' },
  { old: '/fleet/devices/77/remote', now: '/fleet/devices/77?action=remote' },
  { old: '/watch/devices/77/mute?from=mail', now: '/watch/devices/77?from=mail&action=mute' },
  { old: '/toolbox/devices/77/ping', now: '/toolbox/devices/77?action=ping' },
];

/** URLs that did not move: they must not redirect. */
export const UNMOVED_ROUTES: readonly string[] = ['/', '/settings', '/portfolio', '/toolbox', '/login', '/register', '/reset-password', '/invite/abc'];
