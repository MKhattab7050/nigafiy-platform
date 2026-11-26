# Contributing (internal)

This is a private repository. This page is the working agreement for everyone who changes it.

## Product rules (non-negotiable)

- **No AI or LLM anywhere.** Diagnoses, insights and automation are deterministic and evidence-backed.
- **Real product only.** No mock data, simulation mode or placeholder buttons in the product; protocol
  test doubles live only in test files. `scripts/seed-simulated.mjs` is a clearly labelled dev tool.
- **Never remove or silently simplify a feature.** When hardware or an OS is not available, build the
  real code, document the prerequisite and say honestly that it did not run for real.
- **Every feature** has the backend, a migration if needed, the UI, Zod validation, role checks
  (owner / admin / technician / viewer; viewers see no write buttons), audit rows, tests and a doc.
- **English and Arabic.** Every user-visible string exists in both, the layout works in RTL, and
  technical values (IP, MAC, host names, ids) are wrapped in bidi isolates
  (`apps/web/lib/localize/bidi.ts`). The product name is always "Nigafiy" (`pnpm check:brand`).
- **Secrets** are write-only, sealed with AES-256-GCM, listed in `apps/api/src/ops/sealed-columns.ts`
  for `rotate-key`, never logged and never returned by an API.
- **No covert behaviour:** no keylogging, credential capture, stealth install or interception. Typed
  text and file contents never reach the audit log.

## Branches

- `main`: the default branch on GitHub.
- `phase-2-network-intelligence`: the current integration branch. Work lands here after the gate.
- `worktree-<topic>` (for example `worktree-webrtc`, `worktree-engine-sensor`): one branch per piece of
  work, usually in its own git worktree under `.claude/worktrees/<topic>`. Merge the integration branch
  into yours before you hand it over (`Merge branch 'phase-2-network-intelligence' into worktree-<topic>`).

Never force-push a shared branch. Commit per finished item; a clearly named `WIP:` commit is fine when
you must stop mid-way.

## Commit messages

Follow what `git log` shows: an area, a colon, then what changed and why, in plain sentences.

```
Agent: BannerMux passes Windows user-session switching (TargetSession) through to the wrapped desktop
Docs: one executable for the engine and the Sensor in engine.md (sensor command, --sensor-exe default, ...)
Tests: guide unit tests (every signed-in page maps to a section, EN/AR parity of sections, ...)
```

Common areas: `API`, `Web`, `Agent`, `Sensor`, `Engine`, `Desktop`, `Installers`, `Docs`, `Tests`,
`Gate`, `Status`, `Repo`, or a feature name (`Guide`, `Search`, `Packaging`).

## The gate

Every change must pass, before it is merged:

```bash
pnpm install
pnpm typecheck                       # exit 0
pnpm lint                            # 0 errors, no new warnings in files you touched
pnpm check:brand                     # exit 0
pnpm test                            # API suite against a throw-away PostgreSQL
pnpm test:collector                  # plus go vet ./... in collectors/lan-collector
pnpm test:agent                      # plus go vet ./... in agents/endpoint-agent
pnpm test:engine                     # plus go vet ./... in engine
pnpm --filter @nigafiy/web test:unit
pnpm --filter @nigafiy/brand test
pnpm --filter @nigafiy/desktop test  # when you touched apps/desktop
pnpm build                           # when you touched apps/web or packages/brand
pnpm test:web                        # browser walk, EN + AR, when you touched pages
```

Report the numbers (files, passed, skipped) in the pull request. Expected skips: pg_dump/pg_restore
tests without the PostgreSQL client tools, the real-Redis test without Redis, the real-agent tests
unless `pnpm build:agent` has run and `NIGAFIY_UI_TEST=1` is set (they show real banners and
messages on this desktop).

## Test databases and ports

The API suite and the browser walk start their own PostgreSQL. Give each worktree its own port so
parallel runs do not collide:

| Variable | Default | Used by |
| --- | --- | --- |
| `NIGAFIY_TEST_PG_PORT` | 5439 | `pnpm test` (`apps/api/tests/global-setup.ts`) |
| `E2E_PG_PORT`, `E2E_API_PORT`, `E2E_WEB_PORT` | 5446 for PostgreSQL | `pnpm test:web` (`apps/web/playwright.config.ts`) |

```bash
NIGAFIY_TEST_PG_PORT=5484 pnpm test
E2E_PG_PORT=5483 pnpm test:web
```

Ports to leave alone: the dev stack (3100 web, 4100 API, 5433 PostgreSQL), the installed app (47100,
47130, 47133) and the engine control API (47140). If a failed test setup leaves a `postgres.exe` on
your port, find it by port and stop that PID only. Never stop processes by image name.

## Windows notes

- `pnpm build` regenerates `packages/brand` with LF line endings. `.gitattributes` checks those files
  out with LF, so the build changes nothing. In a working copy from before `.gitattributes`, run
  `git checkout -- packages/brand` once; if they ever show as changed, do the same before committing.
- Go code is pure Go (`CGO_ENABLED=0`); there is no C compiler on the build machines.
- Do not install services, elevate, or change firewall rules and system settings from a test.
- Never scan or touch a real network, router or device from tests; router and switch protocols are
  tested only against doubles in `_test.go` files.

## Docs and status

- Update the feature's page under `docs/features/` (prerequisites, what was verified, what was not).
- `docs/roadmap/status.md` is the source of truth for what ran on real hardware versus tests only; keep
  that split honest.
- Applied SQL migrations are never edited; add a new numbered one.
- Diagrams in `docs/architecture/flowcharts.md` must match the code; update them with the flow.
- README artwork is generated: `node scripts/make-readme-art.mjs`.
