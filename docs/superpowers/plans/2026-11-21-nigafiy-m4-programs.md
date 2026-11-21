# Milestone 4: Programs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the one UI codebase (`apps/web`) becomes seven program scopes. Each program has its own URL namespace, sidebar, name, glyph and accent; every old URL keeps working; the device card is shared and offers every program's actions; Hub keeps gathering everything; the desktop runtime opens `nigafiy://` links and per-program windows with their own taskbar identity.

**Architecture:** one route table in `@lan-detective/shared-types/routes` (old prefix → new prefix, program of a path, device-card paths, `nigafiy://` mapping) is read by the web proxy (redirects), the web registry (links), the API (links it generates) and the tests. `lib/programs.ts` in the web app joins that table with the brand tokens and the feature registry into the program registry the shell renders from. `GET /api/v1/platform/programs` says which programs are installed.

**Tech Stack:** as in the master plan (Next.js 16.4 `proxy.ts`, React 19, Tailwind 4 tokens; Node 24 API; Electron 39; Go 1.27 for the launchers).

**Spec:** `docs/superpowers/specs/2026-11-21-nigafiy-platform-design.md` §5, §6.2, §6.3, §8. Master plan Part A row 4 and Global Constraints. Builds on Milestone 3 (`2026-11-21-nigafiy-m3-engine-hub.md`): `packages/shared-types/src/programs.ts`, `modules/platform`, `features/platform` (Programs strip, Engine card) and `engine/` already exist and are extended, not redone.

**Starts after:** Milestone 3 (commit `87a71b2`) and the router-controls work (`4f72290` plus the uncommitted Zyxel limits / controls changes, which are carried along untouched except for UI link paths).

## Global Constraints (in addition to the master plan's)

- Nothing is dropped or simplified. A sub-feature that today lives inside another page and that spec §5 assigns to a different program gets its own page in its program, rendering the same component; the old place keeps a pointer to it.
- Every pre-Milestone-4 URL answers with a permanent redirect (308) to its new URL, query string kept. One table drives the redirects, the links and the tests.
- Whether a program is installed decides only which UI is offered, never which data is collected (spec §6.1). A missing program's actions read "Available in Nigafiy X: install" and lead to the Hub's install page; they are never hidden and never dead.
- The installed LAN Detective and ports 47100/47130/47133 are never touched. The running dev stack (5433 / 4100 / 3100 / one `scripts/local.mjs`) keeps running. The protocol handler is registered only by a packaged build, never from a source checkout, so no test run writes `HKCU\Software\Classes\nigafiy` on the owner's PC.
- No commit (owner approves).

## Review Focus

1. **Old links.** Every page that existed before Milestone 4 (`/devices/<id>`, `/routers/<id>`, `/incidents/<id>`, `/playbooks/runs/<id>`, `/ports?switch=…`, …) opens the right new page. Pinned by `apps/api/tests/routes.test.ts` (walks the full old route list against the shared table) and `apps/web/e2e/redirects.spec.ts` (the real Next.js server answers 308 with the right `Location`).
2. **Accent never replaces status.** Program accents drive the active sidebar item, primary buttons, focus rings and the glyph; ok / warning / critical keep their own tokens and always travel with an icon and a word.
3. **A not-installed program** shows its actions as "Available in Nigafiy X: install" on the device card and in the switcher. Pinned by `NIGAFIY_PROGRAMS` tests in `platform.test.ts` and checked in the browser with the dev stack's real response.
4. **Arabic / RTL** for every new string (`ar: Record<keyof typeof en, string>` makes a missing key a type error) and the mirrored shell.
5. **Links the API writes** (global search, insights, device controls, notification e-mails) point at the new URLs. Pinned by API tests.

## Decisions (builder's call; spec §11)

| Topic | Decision | Why |
| --- | --- | --- |
| Route table location | `packages/shared-types/src/routes.ts` (export `./routes`), no runtime deps | API, web proxy, web links and tests read one table; Node 24 runs it untranspiled in the API |
| URL scheme | `/<program>/<page>` for Radar, Watch, Guard, Fleet, Mind; Toolbox keeps `/toolbox` (its old URL already is its namespace) and adds `/toolbox/subnet`; Hub keeps the root: `/`, `/settings`, `/portfolio`, plus new `/sensors` and `/programs`. Sign-in pages (`/login`, `/register`, `/invite/<t>`, `/reset-password`) stay at the root because e-mails already sent link to them | Spec §6.2 example URLs; Hub "at /" per the brief; invitation and reset e-mails already in mailboxes keep working without a redirect |
| Redirect mechanism | `proxy.ts` (Next 16's middleware) answers `308` from `legacyRedirect()` before the CSP work; query string kept; a program root (`/radar`) redirects to its home; `/hub` → `/` | Proxy can import the TS table through `transpilePackages`; `next.config` redirects would need a second copy of the table |
| Shared device card | Rendered at `/<program>/devices/<id>` for every program except Hub (Radar is canonical; Hub links go to Radar). Links to a device go through `<DeviceLink>` which keeps the current program | Spec §5 "opening a device from any program shows the same card" without throwing the user into another program |
| Device actions in links | `nigafiy://guard/devices/123/block` maps 1:1 to `/guard/devices/123/block`, which the proxy redirects to `/guard/devices/123?action=block`; the card scrolls to and highlights that action's control | Keeps the desktop mapping dumb (1:1, spec Part C) and the meaning in the shared table |
| Action bar behaviour | Each action either jumps to the control on the same card that does the job (trust, mute, wake, monitor, block, pause, quarantine, router controls), or links to the owning page (incidents, remote desktop, files, ping, ports). The controls themselves are unchanged | No second implementation of any control; every button does something real |
| Install state | `GET /platform/programs` reads `NIGAFIY_PROGRAMS` (comma list of program ids, or `all`; default `all`; Hub is always installed). `install_source` stays `bundled` until Milestone 5's per-program installers register with the engine | The engine from M3 has no notion of installed programs yet; a documented config gives the dev stack "all installed" and lets tests and the owner check the "not installed" path for real |
| Install page | Hub `/programs`: every program with its job, pages and state; a not-installed program says how to get it ("run the Nigafiy installer and choose X") until Milestone 5 ships per-program packages | "install" must lead somewhere real |
| Sub-features moved by spec §5 | Notifications → `/watch/notifications`, maintenance windows → `/watch/maintenance`, insights → `/watch/insights`, summary report → `/watch/reports` (the top-bar report button stays everywhere), automation → `/mind/automation`, switch port control settings + request history → `/guard/port-control` (per-port buttons stay on the port rows as Guard actions), collector/Sensor management → Hub `/sensors`, subnet calculator → also `/toolbox/subnet` (stays in IPAM too). Settings keeps a "Moved to programs" card with links and the `#automation` anchor | Exactly one owning program per feature; nothing lost for people used to the old place |
| Accent tokens | `html[data-program=<id>]` redefines `--color-accent`, `--color-accent-strong`, `--color-accent-hover` per program for dark and light. Fills keep white text ≥ 4.5:1 (Watch fill darkened to `#A0650A`, Radar uses the approved button `#00809D`); ink variants ≥ 4.5:1 on their surface | Spec §8; mockup token table; WCAG AA |
| Program in the shell | `programForPath(pathname)`; the shell sets `data-program` on `<html>` in a layout effect, shows the program glyph + name at the top of the sidebar, only that program's sections, and a program switcher (popover listing the seven programs, installed state shown). Account block and sign-out stay in every program; Settings is Hub's | Spec §6.2 |
| Hub home | Unchanged composition; each widget's icon square and each "Needs your attention" item carry the owning program's glyph colour and name; widgets of a program that is not installed are left out | Mockup `Main.dc.html`; spec §5 shared notifications |
| Desktop windows | One runtime process, one window per program (`--program=<id>`, or the Hub window by default). Each window gets `setAppDetails({ appId: 'Nigafiy.<Program>', appIconPath: <program>.ico, relaunchCommand: … --program=<id> })` for its own taskbar group | Spec §6.2: separate AppUserModelID per program; one session partition = one sign-in |
| `nigafiy://` | `src/programs.cjs` parses `nigafiy://<program>/<path>` (strict: known program, path segments `[A-Za-z0-9._~-]`, no `..`, query kept) and opens/focuses that program's window on the path. Registered with `app.setAsDefaultProtocolClient` only in a packaged build; the M5 installer registers it per machine | No registry writes from dev runs |
| Launchers | Go: `engine/cmd/nigafiy-launcher` + `engine/internal/launcher`, one binary per program built with `-ldflags -X main.programID=<id>` into `engine/bin/nigafiy-<id>.exe` (`pnpm build:launchers`). Runtime found via `NIGAFIY_RUNTIME`, then `HKCU`/`HKLM\Software\Nigafiy\Runtime` `Path`, then `..\runtime\Nigafiy.exe` next to the launcher. Icons and version resources (`go-winres`) and the registry value are written by the Milestone 5 installers | Same Go module and toolchain as the engine (no new module download); real launchers need installer work that is M5's |

## Tasks

### Task 1: Shared route table
**Files:** Create `packages/shared-types/src/routes.ts`; modify `packages/shared-types/package.json` (export `./routes`), `src/programs.ts` (new `home`/`pages`); create `apps/api/tests/routes.test.ts`.
- [x] `LEGACY_ROUTES` (old prefix → new prefix), `legacyRedirect(path)`, `programForPath(path)`, `devicePath(id, program)`, `nigafiyUrlToPath(url)`, `OLD_ROUTE_SAMPLES` (every old page with a sample id/query and its expected new URL).
- [x] Test walks `OLD_ROUTE_SAMPLES` plus every program root and device-action path; asserts no new URL redirects again and every new page is owned by exactly one program.

### Task 2: API
**Files:** `src/config/env.ts` (`NIGAFIY_PROGRAMS`), `modules/platform/index.ts`, `modules/overview/search.ts`, `modules/insights/rules.ts`, `modules/endpoints/controls.ts`, `modules/routers/controls.ts` (setup href only, re-read first: another session edits it), `modules/notifications/email.ts` (an "Open" link), tests.
- [x] `platform.test.ts`: installed list from config, Hub always installed, unknown id rejected at start-up, permission (401 without a session, any role reads).
- [x] Search, insights, controls, e-mail tests assert new URLs.

### Task 3: Web program registry, proxy, routes
**Files:** create `apps/web/lib/programs.ts`, `lib/program-context.tsx`, `components/device-link.tsx`; modify `proxy.ts`; move `app/(app)/<page>` into `app/(app)/<program>/<page>`; create the new program pages and the per-program device pages; modify `features/registry.tsx` (each feature has `program`), every internal `href` / `router.push`.
- [x] Old URL → 308 in the dev server (`curl -I`), all `href`s updated (grep for old prefixes returns only API paths).

### Task 4: Program-scoped shell
**Files:** `components/shell/{index,sidebar,top-bar}.tsx`, new `components/shell/program-switcher.tsx`, `app/globals.css`, `features/platform/strings.ts`.
- [x] Only the current program's sections; glyph, name, accent; switcher; EN + AR.

### Task 5: Shared device card + Hub attention
**Files:** new `features/devices/components/device-actions.tsx`, `features/platform/components/install-note.tsx`; modify `device-detail-screen.tsx`, `controls-panel.tsx`, `device-port-card.tsx`, `dashboard-screen.tsx`, `attention-panel.tsx`, `components/widget.tsx`, `lib/attention.tsx`; new Hub pages `/programs`, `/sensors`.
- [x] Action bar grouped by program, install notes for missing programs, `?action=` focus; attention items and widgets tagged with their program.

### Task 6: Desktop runtime and launchers
**Files:** create `apps/desktop/src/programs.cjs`, `apps/desktop/test/programs.test.cjs`; modify `src/main.cjs`; create `engine/internal/launcher/{launcher.go,launcher_test.go,registry_windows.go,registry_other.go}`, `engine/cmd/nigafiy-launcher/main.go`; root `package.json` (`build:launchers`, `test:engine` covers it).

### Task 7: Gate
- [x] `tsc` for web and API, `pnpm lint` (no new warnings), full API suite (`LD_TEST_PG_PORT=5446`), desktop tests, `go vet` + `go test ./...` in `engine`, Playwright smoke + redirects, `status.md`, this plan's results section.

## Results

Gate run 2026-11-22 on the final tree (Milestone 4 builder; nothing committed):

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 (brand, shared-types, api, web) |
| `pnpm lint` (`biome lint .`) | exit 0, **0 errors**, 235 warnings, 11 infos. The files this milestone created have no warnings; every warning in a file it edited was already there at `HEAD` (checked by linting the `HEAD` copies). The warnings added since the M3 baseline are in other sessions' files (e.g. `ops/backup.ts`, `routers/product-schedule.ts`) |
| API suite, `LD_TEST_PG_PORT=5446` (`vitest run`) | 30 files passed; **215 passed, 6 skipped** (5 pg_dump/pg_restore, 1 real Redis), 0 failed |
| Desktop `npm test` | **23 / 23** pass (8 new in `test/programs.test.cjs`) |
| `engine`: `go vet ./...` | ok |
| `engine`: `go test -count=1 ./...` (= `pnpm test:engine`, includes the launcher packages) | 7 packages ok, **47** top-level tests pass, 0 fail |
| `pnpm build:launchers` | 7 launchers built into `engine/bin/` (gitignored), each answered `--launcher-info` with its own program and `Nigafiy.<Program>` |
| `pnpm test:web` (Playwright, production build in `.next-e2e`; PG 5449 / API 4149 / web 3149; `NIGAFIY_PROGRAMS` leaves Mind out) | `next build` passed, then **8 / 8 passed** (4.0 min): `redirects.spec.ts` 4, `smoke.spec.ts` 4 |
| Old-prefix grep (`href`, `router.push/replace`, `redirect(` in `app`, `components`, `features`, `lib`) | none left |

What the browser tests cover: every `OLD_ROUTE_SAMPLES` entry answers 308 with the right `Location` (query kept; only the trailing-slash sample takes Next.js's own extra hop) and lands on a final URL; `UNMOVED_ROUTES` never 308; every redirect target opens in English and in Arabic (`dir=rtl`) with no error boundary, no uncaught error and no CSP report; 18 namespaced screens in EN + AR carry the right `html[data-program]`; the Hub lists the programs; Mind (really left out by the API) reads "Not installed" with an Install link to `/programs#mind` on the Hub, in the switcher and in Settings' "Moved to programs" card.

Contrast (computed, WCAG 2.x): white on every program fill 4.59–5.36:1, white on every hover fill (`accent-strong`) 5.78–6.73:1 in both themes (the dark-theme hover fills were lightened shades below 4.5:1 and now use the darker shades), ink (`accent-hover`) ≥ 7:1 on the dark surface and ≥ 5.1:1 on the light one. Status colours are separate tokens.

Additions beyond the task list, needed so no action is dead: `GET /incidents?device_id=<uuid>` (incidents whose device or any grouped event's device matches; 400 on a bad id; `phase2.test.ts`) behind the card's "Incidents" action; `/fleet/endpoints/<id>?tab=desktop|files` opens that tab; the Settings attention source is `notifications` (it waited forever under `settings`). The e2e tests pace themselves under the API's 600 requests/min per-IP limit (`e2e/api-budget.ts`) and set the language cookie at the site root.

**Not verified:** the protocol registration and `nigafiy://` opening in a packaged build (only the parser, the window manager and the "registered only when packaged" guard are tested; no packaged run was made, so no `HKCU\Software\Classes\nigafiy` was written); separate taskbar groups per program on a real Windows taskbar; the launchers against a real installed runtime (none is installed or registered; their tests use fakes); a desktop app run with the program windows; the pages against the owner's running dev stack (5433 / 4100 / 3100), which was not used. `rm -rf apps/web/.next` was not done: the owner's dev server writes `apps/web/.next/dev`; only the stale `.next/types` and `.next-e2e/types` were removed and the tests build into `.next-e2e`.
