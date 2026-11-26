# Resume point: UX review items 8–18 (2026-11-26)

When the owner says "كمل": read this file and the Status table in `2026-11-26-ux-review.md`, then restart
every item marked "STOPPED" below as its own background agent, in parallel. All work is in the main
checkout (branch `phase-2-network-intelligence`), uncommitted; a stopped worker's edits stay on disk.

Each restarted worker's brief = the original brief below + "a previous worker stopped mid-way: run
`git status`, read the files listed for your item, finish what is missing, do not redo what works."

Shared rules for every worker: no branch switch, no commit; re-read shared files (registry.tsx,
view-mode.ts, dispatch.ts, apps/desktop/src/main.cjs, module index lists) right before each Edit;
run only the worker's own test files + `npx tsc --noEmit -p .` in apps/api and apps/web, never the
whole API suite; English + Arabic strings; no AI, no simulated data, no feature removed; add the
item's row to the Status table when done.

## State

| Item | State | Files to look at first |
| --- | --- | --- |
| 8 People control | REMOVED by the owner — do not restart or rebuild it (people module, page, migration 055, pause-evidence.ts deleted) | migration 055, `routers/pause-evidence.ts`, new people module, `tests/people.test.ts`; `tests/modules.test.ts` already expects a `people` job (lock 727190, every 30 s) |
| 9 Notification buttons | done | `notifications/action-tokens.ts`, migration 056, `channels.ts`, `email.ts`, `apps/web/app/notification-action/[token]`, `tests/notification-actions.test.ts` |
| 10 Telegram by QR | done (Start-here guide doesn't mention it yet) | migration 057, telegram files in notifications, Settings → Notifications UI, `tests/telegram-link.test.ts` |
| 11 PWA + push | done (not committed, 2026-11-26) | migration 059, `app/manifest.ts`, `public/sw.js`, `notifications/webpush.ts`, `webpush-routes.ts`, `lib/push.ts`, `settings/components/phone-push.tsx`, `push-strings.ts`, `tests/webpush.test.ts`; `'push'` added to `NotificationChannelKind` (channels.ts) so dispatch.ts typechecks; `push_*` error sentences present; Status row written |
| 12 Calm alerts | done (summary text English only; muting needs admin) | migration 058, `notifications/policy.ts`, `tests/calm-alerts.test.ts` |
| 13 Router assistant | done | — |
| 14 Updates | done (needs an update URL decision before the next release) | — |
| 15 Backups | done (not tried on an installed copy or in a browser) | migration 060, `modules/backups/`, `ops/logical-backup.ts`, `settings/components/backups.tsx`, `backup-strings.ts`, `tests/backup-ui.test.ts`, tray item in `apps/desktop/src/main.cjs`, doc fixed |
| 16 + 17 Start here, SmartScreen | done | — |
| 18 Outside access | done (migration 061; not tried with real Tailscale; tunnel callers share one sign-in rate limit) | `phone-access-card.tsx`, `scripts/local.mjs`, `tests/outside-access.test.ts` |

## After all items are done

1. `pnpm -r typecheck`, `pnpm --filter @nigafiy/api test` (full suite, in the background), web
   `pnpm test:unit`, desktop `pnpm test`.
2. Known open failure: `lib/i18n/error-messages.test.ts` needs sentences for the new API error codes
   (`push_*`, `dbbackup_*`); `tests/modules.test.ts` job lists need `scheduled-backups`, `telegram-updates`, `notification-calm-summaries`.
3. Look at the new screens in the browser, update the Status table, report to the owner. Commit only
   when the owner says so.
