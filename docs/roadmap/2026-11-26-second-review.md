# Second project review (2026-11-26): findings, status, resume point

## When the owner says "كمل" — resume exactly here

1. Read this whole file. The Status table says what is done; "Parallel sessions" says who was doing
   what; "What is left" is the order to continue in. Update the Status table as items finish.
2. For each parallel session: `mcp__ccd_session_mgmt__list_sessions` (look for the ids below).
   - Still running → leave it; it reports back when done.
   - Stopped / idle with work unfinished → send it "كمل" (SendMessage to its `local_…` id); it has
     its own context and continues from where it stopped.
   - Gone (archived/deleted) → find its worktree branch (`git branch --list '*<branch>*'`), and start
     a new worktree session from that branch (`source_branch` = that branch) with the brief below plus
     "a previous session stopped mid-way: run `git status` and `git log`, finish what is missing,
     do not redo what works".
   - Done → check its branch (diff, typecheck, its tests), set its row to "ready to merge", and tell
     the owner.
3. Then continue with the first unfinished step of "What is left". Never merge a branch, push, or
   restart the dev stack without the owner's go-ahead.
4. Commit only this project's own finished work; leave other sessions' uncommitted files alone
   (`git status` shows them; commit with explicit paths, never `git add -A`).

## What the review found (run on localhost:3100 with a real account, Playwright desktop + phone)

1. **Critical — the API stops answering after boot.** Every scheduler job took a `systemPool`
   connection (`max: 12`) and held it for its whole run (`scheduler.ts`: `systemPool.connect()` then
   `await job.run()`). ~25 jobs start within seconds of boot, so all 12 connections were held; the
   jobs' own queries and every request (sign-in, `/readyz`) then waited forever (no connection
   timeout). Symptoms: login spinner forever, `/healthz` 200, `/readyz` and `POST /auth/login` hang.
   Proof: 12 idle `ld-system` sessions each holding a different advisory lock (727101, 727102, …);
   raising `max` to 48 made `/readyz` 200 in 2 s and login 200 in 122 ms.
   CI passed because tests use `createApp()` and never call `startJobs`.
2. Knowledge capture job failed every 15 s: `knowledge_entries_incident_kinds_check` allowed only 4
   incident kinds while the code also makes `dhcp` and `endpoint` incidents.
3. `apps/web/lib/api.ts` had no request timeout (spinner forever when the API hangs).
4. `/fleet/endpoints` was 412 px wide on a 390 px phone (a `whitespace-nowrap` segmented button).
5. The running dev API was older than HEAD (started 14:22, last commit 15:28) — testers saw old code.
6. Uncommitted WIP in the tree (since committed by the other session as 5bcefff).

Worked well: the "Monitoring was off from … to …" banner (gap shown as "monitoring off", not "down").
The black "N" circle in screenshots is the Next.js dev indicator, not part of the product.

### Review's improvement ideas (days 3–7)

- UX: a "Next" box with 1–3 steps and buttons; "What lowered the score" open by default in plain
  sentences; Ctrl/⌘+K command palette instead of several searches; bottom nav on phones (Home,
  Devices, Alerts, Settings); one meaning per state (Unknown / Offline / Revoked / Pending); timeout,
  retry and offline banner; onboarding checklist; even card density on Fleet.
- Smarter without AI: "explain this number" (measurements, window, accepted/excluded data);
  real baselines ("DNS 3× slower than usual at this hour"); group related alerts into one incident;
  locate the probable source with the topology ("the switch serving 12 devices"); one-click fix and
  then verify it worked; watch-the-watcher (external heartbeat via ntfy/Telegram); "Ask Nigafiy"
  rule-based questions; a short weekly report with the top 3 improvements.
- Reliability order: pool fix → real boot test in CI → incident kinds in sync with DB → `/readyz` +
  System Health → timeouts for all jobs → `pnpm local` runs HEAD → test a real installed release.

## Status

| Item | State | Where |
| --- | --- | --- |
| Pool starvation fix | done | 3ebfd60: `lockPool` (max 8) holds only advisory locks; `MAX_CONCURRENT_JOBS = 4` queue; a run > 5 min gives its slot back (`SLOT_TIMEOUT_MS`); 5 s `connectionTimeoutMillis`; `statement_timeout` app 60 s / system 300 s (migrations and backups use their own clients) |
| 503 instead of hanging | done | `databaseUnavailableCode` in `db.ts`, used by `errorHandler` (`service_busy` / `database_unavailable`, `Retry-After: 5`) |
| `/readyz` + scheduler state | done | `app.ts`: `{ status, database, scheduler: { state ok/degraded/stalled/not_running, overdue_jobs, queued, last_progress_at } }`; 503 when the pool is exhausted or no job run ended for 3 min. The desktop engine restarts the API after 3 failed checks. A few overdue jobs = 200 "degraded" (a restart would not help) |
| Real boot test | done | `tests/boot.test.ts` spawns `src/main.ts` with all jobs, each run delayed 30 s (`NIGAFIY_TEST_JOB_WAIT_MS`, honoured only with NODE_ENV=test), requires sign-in < 2 s. Fails on the old scheduler (readyz 503 service_busy), passes on the new. Without the delay jobs on the empty test DB never overlap and the test passed on the buggy code |
| Knowledge incident kinds | done | migration 063 (fixed list; parsing `pg_get_constraintdef` does not work because Postgres prints `'{a,b}'::text[]`), `modules/incidents/kinds.ts`, `knowledge/schema.ts`, `tests/incident-kinds.test.ts` |
| Web request timeout | done | `api()` 60 s default, sign-in 15 s, backup/restore none (`timeoutMs: 0`); error code `request_timeout` (status 0, worded like "can't reach the server") |
| `pnpm local` runs HEAD | done | `scripts/local.mjs` passes `NIGAFIY_CODE_REV`; `/healthz` returns `started_at` + `rev`; reusing an API warns when its commit differs or API sources changed after it started |
| Fleet 412 px on phone | done | `Segmented` (`components/ui/controls.tsx`) scrolls sideways; checked 390 px in the browser |
| Full API suite | green | 567 passed, 10 skipped (after 3ebfd60) |
| Dashboard: next steps, score reasons, onboarding, explain numbers | STOPPED (WIP saved) | session `dashboard-guidance` (own worktree; was cut from master by mistake and told to `git reset --hard phase-2-network-intelligence` — verify its base before merging) |
| Ctrl+K palette, mobile bottom bar, Fleet density | STOPPED (WIP saved) | session `navigation`, branch `*navigation-palette*` |
| One meaning per device state | STOPPED (WIP saved) | session `device-states`, branch `*device-states*` |
| System Health page, heartbeat setup card, weekly report | STOPPED (WIP saved) | session `system-health`, branch `*system-health*`; migrations must be 065+ (064 is `064_owner_source.sql`) |
| Baselines, alert grouping, topology source, verify-after-fix, "Ask Nigafiy" | not started | the review's "smarter" list beyond explain-numbers and the weekly report |
| Timeouts for every job (AbortSignal) | partly | statement timeouts + slot release are in; jobs do not take an AbortSignal yet |
| New release + installed-copy test (day 7) | not started | 1.0.4 in `D:\nigafiy-releases` very likely has the pool bug |

Decisions taken: the external heartbeat cannot be on by default (needs the owner's ntfy topic or
Telegram chat and sends data outside), so it gets a one- or two-click setup card instead.
The worktree sessions use test DB ports 5451–5454; the main checkout used 5449.

## Parallel sessions (started 2026-11-26 ~16:25, each in its own worktree, commit on own branch, no push/merge)

| Name | Session id | Branch contains | Test DB port | Brief (short) |
| --- | --- | --- | --- | --- |
| dashboard-guidance | `local_0bd3a37f-1fa9-4e8a-80e8-54910e5cc51c` | `dashboard-guidance` | 5451 | Dashboard "Next" box (1–3 steps with action buttons, from score deductions / unknown devices / insights / doctor); "What lowered the score" open by default in plain sentences; onboarding checklist inferred from real state (install → scanned → devices reviewed → alerts → first report), hides when done; "explain this number" for score, unknown-device count, latency. Only `apps/web/features/dashboard` + new API endpoints if needed. Base must be `phase-2-network-intelligence` (it was cut from master; told to reset) |
| navigation | `local_542abc00-e44e-40d9-b730-83ea5d442c43` | `navigation-palette` | 5452 | Ctrl/⌘+K command palette (pages, devices by name/IP/MAC, incidents, endpoints, actions) replacing the global search, keyboard + ARIA + full-screen on phone; bottom nav < 768 px (Home, Devices, Alerts, Settings, "More"); even Fleet card density. App shell, top bar, search only. Don't edit `Segmented` |
| device-states | `local_7c9aa137-c0b7-48e2-9050-73cd75b579c8` | `device-states` | 5453 | One shared mapping state → label (en+ar) + badge tone + tooltip for Unknown / Offline / Revoked / Pending, used on every screen; split counts that mix states (Fleet "Offline / Pending"); keep "monitoring off" ≠ "offline"; don't touch trust logic (known/unreviewed, trust_reason). Report lists changed screens |
| system-health | `local_d222fe4f-1c5a-47d2-9cef-9799a76e924c` | `system-health` | 5454 | System Health page in plain sentences (API, DB, scheduler, late/failing jobs, monitoring gaps, anything to act on; details behind a disclosure) from `/system/modules` + monitor gaps; "Tell me if Nigafiy itself stops" setup card for the existing outside heartbeat (ntfy/Telegram, says what is sent); rule-based weekly report (in-app + optional notification, top 3 improvements) as an idempotent scheduled job with a new lockKey. Migrations 065+. Don't edit `scheduler.ts`, `db.ts`, `app.ts` |

### Where each session stopped (owner said "stop", 2026-11-26 ~16:45)

All four were stopped mid-turn. Their unfinished work is saved as WIP checkpoint commits on their own
branches (worktrees under `D:\network\.claude\worktrees\`). Nothing was reviewed, tests were not
confirmed, nothing is merged into `phase-2-network-intelligence`. To resume: send "كمل" to the
session id (it keeps its context), and add "your work so far is in WIP checkpoint commits on your
branch; check `git log -3` and `git show --stat HEAD`, then finish what is missing".

| Session | Branch / last commit | Base | Done so far (from the files) | Not started / unknown |
| --- | --- | --- | --- | --- |
| dashboard-guidance | `claude/dashboard-guidance-47d0bc` @ 609bf90 (3 WIP commits; its own notes: memory `dashboard-guidance-handoff.md`) | 3ebfd60 ✓ (reset worked) | API: `overview/guidance.ts` + route in `overview/routes.ts`, types in shared-types, `tests/dashboard-guidance.test.ts`; web: `dashboard/strings.ts`, `dashboard/guidance-text.ts` | components written (`next-steps.tsx`, `setup-checklist.tsx`, `explain.tsx`, `insights-panel.tsx` edit) but NOT placed on the dashboard page and not typechecked; API endpoint + its tests reported done |
| navigation | `claude/navigation-palette-0c72d4` @ 292bab1 | 5bcefff | `shell/command-palette.tsx`, `shell/bottom-nav.tsx`, changes to `shell/index.tsx`, `sidebar.tsx`, `top-bar.tsx`, `part-boundary.tsx`, `ui-strings.ts`, `e2e/smoke.spec.ts`, `apps/web/tsconfig.json` (check why) | Fleet card density; browser check en/ar at 390 px. Its `.claude/launch.json` edits (scratch `iso-db`/`iso-api` entries) are left uncommitted on purpose |
| device-states | `claude/device-states-73c610` @ 9ef50ca | 5bcefff | shared state mapping in `ui/status.tsx`, `ui/tones.ts`, `ui/index.ts`; endpoints screens/text/widget/tones, `fleet-content.tsx`, `device-endpoint-card.tsx`, `fleet-requests-screen.tsx`; `dashboard/status-header.tsx`; `core-strings.ts`, `ui-strings.ts`; API `overview/search.ts` + `tests/search.test.ts`; shared-types | devices list/detail screens (none touched yet), alerts; browser check; list of changed screens |
| system-health | `claude/system-health-b8f152` @ d21ffac | 5bcefff | API only, written but not typechecked or tested (the session says so): `system/health.ts` + `system/index.ts`, new `modules/weekly-report/` (rules, service, routes, job), migration `065_weekly_reports.sql`, registry, `email.ts`, `tests/system-health-weekly.test.ts`, `modules.test.ts`, shared-types | the web System Health page, the heartbeat setup card, the weekly report page; test run not confirmed |

Merge warnings for later: navigation and device-states both edit `shell/top-bar.tsx` and
`ui-strings.ts`; device-states and dashboard-guidance both touch the dashboard; every branch edits
`packages/shared-types/src/index.ts` (append-only, should merge cleanly). The three branches cut from
5bcefff do not have 3ebfd60 / 63 / 65a1e82 — they come in on merge.

## What is left

1. When each session reports: check its branch (diff, typecheck, its tests), tell the owner, and
   ask before merging into `phase-2-network-intelligence` (use full refs `refs/heads/…`).
2. After merging: full API suite, web typecheck + unit tests, look at the screens at desktop and
   390 px in English and Arabic.
3. Restart the dev API on 4100 (it still runs code from before 3ebfd60) — check no other session
   is using it first.
4. Build a new release (`D:\nigafiy-releases`), install it, and test sign-in, dashboard, devices,
   alerts and the System Health page on the installed copy (day 7).
5. Later: the rest of the "smarter" list and AbortSignal for jobs.
6. Nothing is pushed; push only when the owner says so.

### Resumed 2026-11-26 ~18:45 (owner said "كمل")

The four old sessions were gone (not listed, not archived). Their worktrees were clean (nothing
unsaved). Four new worktree sessions were started from the WIP branches, each told to finish only
what is missing, commit on its own branch, not push or merge:

| Name | Session id | Cut from |
| --- | --- | --- |
| dashboard-guidance-2 | `local_155613f7-90c0-4f72-8ab8-a53181174624` | `claude/dashboard-guidance-47d0bc` |
| navigation-2 | `local_ca55eba5-21ba-4118-85f9-c40ffa5eaf5a` | `claude/navigation-palette-0c72d4` |
| device-states-2 | `local_a7f23d07-7f09-4ce2-9d8e-016d880fbcb8` | `claude/device-states-73c610` |
| system-health-2 | `local_d30298d1-5640-43f0-a310-badfd036baee` | `claude/system-health-b8f152` |

Their branches are new (`*-2`); the old `claude/*` branches stay as they were.
