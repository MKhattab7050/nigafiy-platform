# Web and API performance / UX fixes (November 2026)

An outside review listed ten problems in `apps/web` and `apps/api`. Each was checked against the
code before changing anything. One commit per item on `worktree-web-perf`.

| # | Item | Verdict | Commit |
|---|------|---------|--------|
| 1 | App reloads the page every 5 s while the API is down | Confirmed, fixed: capped backoff, "Can't reach the server / Retry now" (EN + AR), no reload | cdb4f22 |
| 2 | One app context re-renders every `useQuery` on each SSE update | Confirmed, fixed: session / sites / live flag / stream split into separate contexts with stable references | c403c9f |
| 3 | No `global-error`, `not-found`, `loading`, no boundaries around Sidebar / TopBar | Confirmed, fixed | 01a3a82 |
| 4 | i18n dictionaries and Recharts on the critical path | Confirmed, fixed (numbers below) | 4beca24, be48ce8, 81b43bc |
| 5 | "1 devices", no Arabic plural forms | Confirmed, fixed: `tn(key, count)` with `Intl.PluralRules` (en one/other, ar zero/one/two/few/many/other), 29 count sentences, parity tests for plural keys | 44c617e |
| 6 | Dialogs without an accessible name, drawer without focus trap, no skip link | Confirmed, fixed in the shared Modal / Drawer / phone menu, skip link (EN + AR) | 33178e2 |
| 7 | ~24 `window.confirm()` calls | Confirmed (25 found), all replaced by one `useConfirm()` dialog (EN + AR, destructive styling, focus handling) | 0b528c1 |
| 8 | Insights: unbounded inferred-device read and a settings query per site (N+1) | Confirmed, fixed: one settings query for all sites, read capped at 200 rows with the exact total from `count(*) OVER ()` | 478bae6 |
| 9 | `GET /knowledge` writes to the database | Confirmed (list, counts, suggest and detail all ran the capture), fixed: capture moved to the `knowledge-capture` job; GETs write nothing | 9e8eb25 |
| 10 | `withTenant` costs BEGIN + set_config + COMMIT for one SELECT | Confirmed, reduced: BEGIN and set_config in one round trip; RLS unchanged (numbers below) | de7bffe |

None of the ten items was stale.

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

| Route | Before | After 1st split (i18n + Recharts) | After (+ sideEffects) | Final (items 5–10, phase-2 be38e5b merged) |
|-------|-------:|---------------------------------:|----------------------:|------:|
| `/` (dashboard) | 1461 KB / 432 gz | 788 / 246 | 760 / 238 | **756 / 237** |
| `/login` | 938 / 279 | 659 / 206 | 638 / 199 | **634 / 198** |
| `/radar/devices` | 2261 / 653 | 1595 / 468 | 711 / 224 | **708 / 223** |
| `/radar/devices/[id]` | 2261 / 653 | 1595 / 468 | 894 / 277 | **891 / 276** |
| `/fleet/endpoints` | 1844 / 540 | 1181 / 357 | 831 / 260 | **827 / 260** |
| `/fleet/endpoints/[id]` | 1844 / 540 | 1181 / 357 | 1028 / 321 | **1025 / 320** |
| `/radar/topology` | 1227 / 370 | 945 / 296 | 912 / 286 | **909 / 286** |
| `/settings` | 1083 / 319 | 809 / 248 | 751 / 234 | **748 / 234** |
| Largest route | 2261 / 653 | 1595 / 468 | 1028 / 321 | **1025 / 320** |
| Mean of 66 routes | 1382 / 407 | 939 / 287 | 745 / 233 | **742 / 233** |

Overall: largest route **2261 → 1025 KB (−55 %)**, mean **1382 → 742 KB (−46 %)**, gzip mean 407 → 233 KB.

The shared root (framework + React) is 543 KB raw in all three builds; it is not part of this work.

## Item 9: knowledge capture out of GET

`GET /knowledge`, `/knowledge/counts`, `/knowledge/suggest` and `/knowledge/:id` each ran
`syncCandidates()` (turn newly resolved incidents with a note or comments into candidates, refresh
untouched candidates), i.e. up to two transactions with INSERT / UPDATE / audit rows per read, and the
sidebar badge polls `/knowledge/counts`. Now:

- The GET routes only read. A test takes a snapshot of entries, the capture ledger, revisions, audit
  rows and `max(updated_at)`, calls every knowledge GET, and checks the snapshot is identical.
- The `knowledge-capture` job (module `knowledge`, every 15 s, advisory lock 727180, single runner
  across API instances) runs one read-only set-based query over all organizations to find those with
  work (an uncaptured resolved incident with human text in the last 180 days, or an untouched candidate
  whose incident changed), at most 200 per run, then runs the existing capture for each one in its own
  tenant (RLS) transaction. Organizations with nothing to do cost nothing more than that query.
- A new candidate still reaches open pages through the realtime `events` notification. The only
  visible difference: it appears within ~15 s of the resolve instead of on the next read.

## Item 10: `withTenant` round trips

Every tenant transaction was `BEGIN`, `SELECT set_config('app.current_org', $1, true)`, the work,
`COMMIT`: four round trips for one SELECT. `BEGIN` and `set_config` are now sent together as one
simple-protocol message (`BEGIN; SELECT set_config('app.current_org', '<uuid>', true)`): the same two
statements, in the same order, with the same transaction-local setting, so Row Level Security behaves
exactly as before. Because the id is written as a literal, the one-trip form is used only for a
canonical UUID (hex digits and hyphens, nothing that could need escaping); any other spelling falls
back to the parameterized two-trip start, which PostgreSQL validates as before.

Not done, on purpose: dropping the transaction (a session-level `set_config` would leak to the next
user of a pooled connection unless reset, and a failed reset would hand another tenant's id to the
next request), or folding the setting into each statement (every query in the codebase would change).

Measured on this PC (embedded PostgreSQL 18 on loopback, 3000 calls after 300 warm-up, one indexed
SELECT per transaction, two rounds each):

| | mean | p50 | p95 |
|---|---:|---:|---:|
| Before (BEGIN / set_config / SELECT / COMMIT) | 1.40–1.44 ms | 1.36–1.39 ms | 1.67–1.75 ms |
| After (BEGIN;set_config / SELECT / COMMIT) | 1.16–1.21 ms | 1.11–1.17 ms | 1.36–1.43 ms |

About −17 % per tenant transaction on loopback; the saving is one network round trip, so it is larger
when the database is on another host. Tests: injection-shaped and non-canonical ids never reach the
literal, both starts see the same rows and none of the other tenant's, and after a commit and after a
rollback none of the 16 pooled connections keeps `app.current_org`; the existing RLS tests pass.
