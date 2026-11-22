# System self-check (Hub → /system/modules)

Shows every registered API module and every background job, so a stalled job is visible instead of
silently missing.

## What it does

- `GET /api/v1/system/modules` (any signed-in role) lists modules and jobs. Per job: interval,
  whether it is scheduled or running, last start / finish / duration, last error, last skip (another
  instance held the lock), and **overdue** with `overdue_at`.
- **Overdue** (`apps/api/src/infrastructure/scheduler.ts`, `overdueAt`): grace = interval × 2
  (`OVERDUE_GRACE_FACTOR`) + 60 s (`OVERDUE_SLACK_MS`). A running job is overdue when its current run
  has lasted longer than the grace; an idle job when the grace has passed since its last sign of life
  (last start, last lock skip, or the moment it was scheduled). Computed on the server, so every
  viewer sees the same answer.
- Web: the Hub page `/system/modules` (EN + AR) lists modules and jobs with last run, last error and
  an overdue badge; Settings shows a one-line verdict and links to it.

## Verified

`apps/api/tests/modules.test.ts`: the module/job listing (nothing overdue on a fresh start); a
scheduled job becomes overdue only after interval × grace without a start; `overdueAt` uses the
latest start / skip / schedule mark for an idle job and the current start for a running one.

## Not verified

Not observed with a job that really stalls in a long-running installation; the rule is tested with
constructed timestamps.
