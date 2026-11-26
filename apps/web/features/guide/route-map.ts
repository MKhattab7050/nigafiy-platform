// Which guide section the help button opens on each signed-in page. Pure data and functions with no
// runtime imports, so guide.test.ts checks that every page under app/(app) has an entry.
import type { GuideSectionId } from './types.ts';

export interface GuideRoute {
  /** A URL path prefix, matched on whole segments (`/guard/routers` matches `/guard/routers/abc`). */
  prefix: string;
  section: GuideSectionId;
  /** Optional sub-heading anchor inside the section (the `id` of an `h` block). */
  anchor?: string;
}

/**
 * The route → section map. The longest matching prefix wins, so a specific page (`/guard/routers`)
 * can point somewhere other than its program (`/guard`).
 */
export const GUIDE_ROUTES: readonly GuideRoute[] = [
  // Hub
  { prefix: '/', section: 'hub' },
  { prefix: '/portfolio', section: 'hub' },
  { prefix: '/sensors', section: 'first-scan', anchor: 'sensor' },
  { prefix: '/programs', section: 'programs', anchor: 'on-off' },
  { prefix: '/settings', section: 'getting-started', anchor: 'roles' },
  { prefix: '/system/modules', section: 'troubleshooting', anchor: 'background-jobs' },
  { prefix: '/system/health', section: 'troubleshooting', anchor: 'background-jobs' },
  { prefix: '/system/weekly', section: 'hub' },
  { prefix: '/guide', section: 'getting-started' },
  // Radar
  { prefix: '/radar', section: 'radar' },
  { prefix: '/radar/devices', section: 'devices' },
  { prefix: '/radar/discovery', section: 'first-scan', anchor: 'scope' },
  // Watch
  { prefix: '/watch', section: 'watch' },
  // Guard
  { prefix: '/guard', section: 'guard' },
  { prefix: '/guard/routers', section: 'routers' },
  // Fleet (the Fleet Pro pages point at the Fleet Pro section)
  { prefix: '/fleet', section: 'fleet' },
  { prefix: '/fleet/endpoints', section: 'fleet' },
  { prefix: '/fleet/sessions', section: 'fleet-pro' },
  { prefix: '/fleet/recordings', section: 'fleet-pro' },
  { prefix: '/fleet/requests', section: 'fleet-enroll', anchor: 'quick-support' },
  { prefix: '/fleet/policies', section: 'fleet-pro' },
  { prefix: '/fleet/approvals', section: 'fleet-pro' },
  { prefix: '/fleet/scripts', section: 'fleet-pro' },
  { prefix: '/fleet/jobs', section: 'fleet-pro' },
  { prefix: '/fleet/patches', section: 'fleet-pro' },
  { prefix: '/fleet/monitoring', section: 'fleet-pro' },
  // Mind, Toolbox
  { prefix: '/mind', section: 'mind' },
  { prefix: '/toolbox', section: 'toolbox' },
];

/** Where help leads when no entry matches (a page added later without an entry; the unit test catches it). */
export const GUIDE_FALLBACK: GuideSectionId = 'getting-started';

export interface GuideTarget {
  section: GuideSectionId;
  anchor?: string;
  /** True when no entry matched and the fallback was used. */
  fallback: boolean;
}

const segments = (path: string): string[] => path.split(/[?#]/, 1)[0]!.split('/').filter(Boolean);

/** The guide section for a URL path: the longest prefix in GUIDE_ROUTES, else the fallback. */
export function guideTargetForPath(pathname: string): GuideTarget {
  const path = segments(pathname);
  let best: GuideRoute | null = null;
  let bestLen = -1;
  for (const route of GUIDE_ROUTES) {
    const prefix = segments(route.prefix);
    // `/` matches only the home page itself, not every page.
    if (prefix.length === 0 && path.length !== 0) continue;
    if (prefix.length > path.length || prefix.some((s, i) => s !== path[i])) continue;
    if (prefix.length > bestLen) {
      best = route;
      bestLen = prefix.length;
    }
  }
  return best ? { section: best.section, anchor: best.anchor, fallback: false } : { section: GUIDE_FALLBACK, fallback: true };
}

/** The guide URL for a target: `/guide/<section>` with the anchor, if any. */
export const guideHref = (target: { section: GuideSectionId; anchor?: string }): string =>
  `/guide/${target.section}${target.anchor ? `#${target.anchor}` : ''}`;
