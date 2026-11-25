# Web and API performance / UX fixes (November 2026)

An outside review listed ten problems in `apps/web` and `apps/api`. Each was checked against the
code before changing anything. One commit per item on `worktree-web-perf`.

| # | Item | Verdict | Commit |
|---|------|---------|--------|
| 1 | App reloads the page every 5 s while the API is down | Confirmed, fixed: capped backoff, "Can't reach the server / Retry now" (EN + AR), no reload | cdb4f22 |
| 2 | One app context re-renders every `useQuery` on each SSE update | Confirmed, fixed: session / sites / live flag / stream split into separate contexts with stable references | c403c9f |
| 3 | No `global-error`, `not-found`, `loading`, no boundaries around Sidebar / TopBar | Confirmed, fixed | 01a3a82 |
| 4 | i18n dictionaries and Recharts on the critical path | Confirmed, fixed (numbers below) | 4beca24, be48ce8, item-4 commit |

## Item 4: first-load JavaScript

Measured with `node apps/web/scripts/first-load-js.mjs` after `pnpm build` (Next 16 / Turbopack no
longer prints sizes; the script sums the root main files plus each page's entry chunks from
`page_client-reference-manifest.js`, i.e. the scripts the browser fetches before the page runs).
gzip is level 9 on each file.

What changed:

- **Only the active language reaches the browser.** The dictionaries (`lib/i18n/messages-en.ts`,
  `messages-ar.ts`, 2430 keys each) are imported only by `lib/i18n/server.ts`; the root layout (a
  Server Component) passes the active language to `I18nProvider` as a prop. Switching language
  sets the `ld_locale` cookie and calls `router.refresh()`, so the server re-renders with the other
  language and client state is kept. The dictionary now travels in the page's RSC payload, not as
  JavaScript: 140 KB (42 KB gz) for English, 181 KB (48 KB gz) for Arabic, once per full load (soft
  navigations do not re-send the root layout).
- **Recharts loads with the first chart**, not with the page: `components/charts/time-series-plot.tsx`
  is loaded through `next/dynamic` (`ssr: false`); legend and data table render at once.
- **The device page no longer imports the Fleet Pro barrel** (`DeviceEndpointCard` imported directly).
- **`"sideEffects": ["*.css"]` in `apps/web/package.json`**, so the bundler drops unused re-exports
  of the feature barrels (`features/*/index.ts`). Checked: no module in `app/`, `components/`,
  `features/`, `lib/` runs code at the top level, and the only side-effect imports are CSS
  (`globals.css`, xterm and React Flow styles), which the pattern keeps.

| Route | Before | After 1st split (i18n + Recharts) | After (+ sideEffects) |
|-------|-------:|---------------------------------:|----------------------:|
| `/` (dashboard) | 1461 KB / 432 gz | 788 / 246 | **760 / 238** |
| `/login` | 938 / 279 | 659 / 206 | **638 / 199** |
| `/radar/devices` | 2261 / 653 | 1595 / 468 | **711 / 224** |
| `/radar/devices/[id]` | 2261 / 653 | 1595 / 468 | **894 / 277** |
| `/fleet/endpoints` | 1844 / 540 | 1181 / 357 | **831 / 260** |
| `/fleet/endpoints/[id]` | 1844 / 540 | 1181 / 357 | **1028 / 321** |
| `/radar/topology` | 1227 / 370 | 945 / 296 | **912 / 286** |
| `/settings` | 1083 / 319 | 809 / 248 | **751 / 234** |
| Largest route | 2261 / 653 | 1595 / 468 | **1028 / 321** |
| Mean of 66 routes | 1382 / 407 | 939 / 287 | **745 / 233** |

The shared root (framework + React) is 543 KB raw in all three builds; it is not part of this work.
