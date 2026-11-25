## What and why

<!-- One paragraph: what changed, why, and which program or component it touches. -->

## How it was verified

<!-- Commands and numbers, e.g. "API suite (NIGAFIY_TEST_PG_PORT=5484): 58 files, 408 passed, 6 skipped". -->

| Ran for real (real hardware or OS) | Tests only (doubles, fixtures, loopback) | Never run |
| --- | --- | --- |
|  |  |  |

## Gate

- [ ] `pnpm typecheck` exit 0
- [ ] `pnpm lint` 0 errors, no new warnings in touched files
- [ ] `pnpm check:brand` exit 0
- [ ] `go vet ./...` and `go test -count=1 ./...` in every Go module touched
- [ ] `pnpm test` (API suite) all pass; skips explained
- [ ] `pnpm --filter @nigafiy/web test:unit`; `pnpm build` and `pnpm test:web` if web pages changed
- [ ] `pnpm --filter @nigafiy/desktop test` if `apps/desktop` changed
- [ ] `packages/brand` has no line-ending-only changes

## Product rules

- [ ] Every new user-visible string exists in English **and** Arabic, and the screen works in RTL
- [ ] Technical values (IP, MAC, host names, ids) wrapped in bidi isolates
- [ ] Role checks on the server; viewers see no write buttons
- [ ] Audit rows for every change; no secret, typed text or file content in logs or audit
- [ ] Secrets sealed and listed in `ops/sealed-columns.ts`
- [ ] No AI, no mock or simulated data in product paths, no button without a handler
- [ ] Docs updated (`docs/features/...`) with the real-hardware versus tests-only split
- [ ] A new migration has its own number; no applied migration edited
