/**
 * Simple ("Home") view vs full view (UX review 2026-11-26, item 7).
 *
 * The simple view HIDES pages and dashboard widgets, it never removes them: a hidden page still
 * opens by its URL, keeps its sidebar link while it is the page shown, and everything is back with
 * one click on "Full view". Which pages and widgets the simple view keeps is a flag on the feature
 * registry entry (`home: true` on the feature for its sidebar link, `home: true` on its widget for
 * the dashboard), so there is no second list to keep in step.
 *
 * Kept per browser, like the theme and the collapsed sidebar (localStorage). Without a stored
 * choice the full view shows, so nobody who already uses Nigafiy sees a different app after an
 * update; the switch sits in the sidebar footer.
 *
 * Pure: no React, no DOM, so `node --test` can load it (view-mode.test.ts).
 */

export type ViewMode = 'home' | 'full';

export const VIEW_STORAGE_KEY = 'ld_view';

/** What shows when this browser never chose. */
export const DEFAULT_VIEW: ViewMode = 'full';

export const parseView = (value: string | null | undefined): ViewMode => (value === 'home' || value === 'full' ? value : DEFAULT_VIEW);

interface HomeFlag {
  home?: boolean;
}

/** Does this page (or widget) show in `mode`? The full view shows everything. */
export const shownIn = (item: HomeFlag, mode: ViewMode): boolean => mode === 'full' || item.home === true;

/**
 * The sidebar links of one program in `mode`. The page being shown always keeps its link, so a
 * hidden page opened by URL is never a page with no place in the menu.
 */
export function sidebarSections<T extends HomeFlag & { route: string }>(sections: readonly T[], mode: ViewMode, isActive: (route: string) => boolean): T[] {
  return sections.filter((f) => shownIn(f, mode) || isActive(f.route));
}

/** Dashboard widgets in `mode` (the feature's own flag is not enough: a home page can have an office widget). */
export function dashboardWidgets<T extends { widget?: HomeFlag }>(features: readonly T[], mode: ViewMode): T[] {
  return features.filter((f) => f.widget && shownIn(f.widget, mode));
}

/** Does a program have anything to show in `mode`? (The program switcher leaves the empty ones out.) */
export const programHasPages = (sections: readonly HomeFlag[], mode: ViewMode): boolean => sections.some((f) => shownIn(f, mode));
