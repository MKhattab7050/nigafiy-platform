# Milestone 2: Rename and brand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything a person sees says Nigafiy with the approved logo, while every identifier that is persisted or on the wire keeps working.

**Architecture:** Display names, package names and binary names change. Wire and storage identifiers stay, and the few that change get a fallback that reads the old one. One decision table (`docs/architecture/naming.md`) lists every identifier and is the reference for Milestone 5's upgrade.

**Tech Stack:** as in the master plan.

**Spec:** `docs/superpowers/specs/2026-11-21-nigafiy-platform-design.md` §6.6; master plan `docs/superpowers/plans/2026-11-21-nigafiy-implementation.md` (Global Constraints apply); brand tokens `docs/design/mockups/README.md`.

**Starts after:** Milestone 0b is merged (both builders done, gate green). This milestone touches most files, so nothing else runs in parallel with Tasks 3 and 4.

## Global Constraints (in addition to the master plan's)

- Kept exactly as they are (on the wire or persisted): token prefixes `lde_`, `ldc_`, `ldea_`, `lda_`; cookie `ld_session`; header `X-LD-CSRF`; DB role `lan_app`; default DB name `lan_detective`; the collector and agent HTTP paths; collector state files (`state/*.json`, `collector.yaml`); the Electron session partition `persist:dashboard`.
- Renamed with a fallback: env vars `LD_*` → `NIGAFIY_*`, `LAN_COLLECTOR_*` → `NIGAFIY_SENSOR_*` (the new name wins, the old one is still read and logs a one-time deprecation line).
- Renamed outright (nothing persisted depends on them): npm scope `@lan-detective/*` → `@nigafiy/*`; root package `lan-detective` → `nigafiy`; Go modules → `github.com/nigafiy/sensor` and `github.com/nigafiy/agent`; binaries `lan-collector(.exe)` → `nigafiy-sensor(.exe)`, `endpoint-agent(.exe)` → `nigafiy-agent(.exe)`; User-Agents `nigafiy-sensor/<v>`, `nigafiy-agent/<v>`, `Nigafiy-Webhook/1`.
- Folders stay where they are (`collectors/lan-collector`, `agents/endpoint-agent`): moving them churns every path and doc for no gain. Decided and written in `naming.md`.
- The brand name is written in Latin letters, "Nigafiy", in Arabic text too.
- The desktop app must never orphan data: until Milestone 5's migration exists, a renamed build uses the old `%APPDATA%\LAN Detective` folder when it exists and the new `%APPDATA%\Nigafiy` one does not.

## Review Focus

1. **An agent or collector enrolled before the rename** keeps authenticating and sending. Pinned by the existing ingest/agent API tests, which must pass unchanged, plus the Go config test that loads an old `LAN_COLLECTOR_*` environment.
2. **A browser session from before the rename** stays signed in (cookie name unchanged). Pinned by `auth-and-tenancy.test.ts` being untouched and still green.
3. **Leftover "LAN Detective" text** in Arabic and English UI, window titles, emails, installers. Pinned by a repository check (Task 6) that fails on the old name outside an allow-list.
4. **The packaged app after the rename** still starts and finds its bundled backend under the new binary names. Pinned by the local smoke run in Task 6.
5. **An existing desktop profile** is found by a renamed build. Pinned by the `resolveDataDir` test in Task 5.

---

### Task 1: Brand assets

**Files:**
- Create: `packages/brand/` (`package.json` name `@nigafiy/brand`, `svg/mark.svg`, `svg/wordmark.svg`, `svg/app-icon.svg`, `svg/programs/{hub,radar,watch,guard,fleet,mind,toolbox,agent,sensor}.svg`, `tokens.ts`)
- Create: `packages/brand/scripts/make-icons.mjs` (renders each SVG to a multi-size `.ico`: 16, 20, 24, 32, 40, 48, 64, 256)
- Modify: `apps/desktop/scripts/make-icon.mjs` (use the app icon from `@nigafiy/brand`)
- Modify: `apps/web/app/icon.svg` or the favicon in `apps/web/app` (the Hub icon)

**Interfaces:**
- Produces: `PROGRAMS_BRAND: Record<ProgramId, { accent: string; accentButton?: string; glyph: string }>` and `BRAND = { blue: '#1A73FF', navy: '#0B2A7A', wordmark: '#0B1F5C', iconGround: '#0B1F5C', hub: '#1466E6' }` in `packages/brand/tokens.ts`, with `ProgramId = 'hub'|'radar'|'watch'|'guard'|'fleet'|'mind'|'toolbox'|'agent'|'sensor'`. Values are copied from `docs/design/mockups/README.md`.

- [ ] **Step 1:** Draw the final vectors from the approved D draft (`docs/design/mockups/Icons.dc.html`): a clean two-tone rounded lowercase n, the wordmark in Poppins 600 converted to paths (no font dependency), the app icon (n on a `#0B1F5C` rounded square), and the program glyphs from the mockup on their accent squares. No mascot or character.
- [ ] **Step 2:** `make-icons.mjs` writes `.ico` files with the sizes above (use `sharp` + `png-to-ico` as dev dependencies of `@nigafiy/brand` only). Test `node --test`: each `.ico` exists and its directory lists all 8 sizes.
- [ ] **Step 3:** Check the icons at 16 px in the browser pane on light and dark. Commit.

### Task 2: Environment variables with fallback

**Files:**
- Create: `apps/api/src/config/env-compat.ts` + `apps/api/tests/env-compat.test.ts`
- Modify: `apps/api/src/config/env.ts`, `apps/api/scripts/dev-db.ts`, `apps/api/tests/global-setup.ts`, `scripts/local.mjs`, `apps/desktop/src/{main.cjs,local-stack.cjs}`
- Create: `collectors/lan-collector/internal/config/envcompat.go` + test; `agents/endpoint-agent/internal/config/envcompat.go` + test
- Modify: the collector's `config.Load` and the agent's config loader

**Interfaces:**
- Produces (TS): `readEnv(name: string, env?: NodeJS.ProcessEnv): string | undefined`. `name` is the new name (`NIGAFIY_DATA_DIR`); the legacy name is derived by the table `LEGACY_ENV: Record<string, string>` (`NIGAFIY_DATA_DIR → LD_DATA_DIR`, …, every `LD_*` in the repo).
- Produces (Go): `config.Getenv(name string) string` with the same table for `NIGAFIY_SENSOR_* → LAN_COLLECTOR_*`.

- [ ] **Step 1: Test** `readEnv prefers the new name, falls back to the legacy one, and warns once`: with `{LD_DATA_DIR:'a'}` → `'a'` and one warning; with both set → the new value and no warning; with neither → `undefined`.
- [ ] **Step 2: Implement**, and replace every `process.env.LD_*` read (`git grep -n "LD_"` must show only the table, docs and tests afterwards).
- [ ] **Step 3: Go tests** `TestGetenvFallsBackToLegacy` (sensor and agent) and `TestLoadReadsLegacyCollectorEnv` (an old `LAN_COLLECTOR_SERVER_URL` still configures the server URL).
- [ ] **Step 4:** Update `.env.example` and the docs to the new names, with a line that the old names still work. Gate. Commit.

### Task 3: npm scope and root package

**Files:** every `package.json`, every import of `@lan-detective/*` (about 224 files), `apps/web/next.config.ts` (`transpilePackages`), `apps/desktop/scripts/bundle-backend.mjs` (filters and the compiled shared-types path), `pnpm-lock.yaml` (regenerated).

- [ ] **Step 1:** Rename scopes with one scripted replace (`@lan-detective/` → `@nigafiy/`) and the root name. `pnpm install`.
- [ ] **Step 2:** `git grep -n "@lan-detective"` returns nothing. Full gate, including `pnpm run pack` in `apps/desktop`. Commit on its own so the mechanical change is reviewable alone.

### Task 4: Go modules, binary names, User-Agents

**Files:** both `go.mod` files and every Go import; `cmd/lan-collector` → `cmd/nigafiy-sensor`, `cmd/endpoint-agent` → `cmd/nigafiy-agent`; root `package.json` scripts `build:collector`, `build:agent`; `.gitignore`; `apps/desktop/src/collector-manager.cjs` and `bundle-backend.mjs` (binary names); `scripts/local.mjs`; `apps/api/tests/real-windows-agent.test.ts` (binary path); the Dockerfile, systemd unit and `docker-compose.yml`; User-Agent strings (`internal/cloud/client.go`, `agents/endpoint-agent/internal/agent/agent.go:460`, `apps/api/src/modules/notifications/dispatch.ts:96`).

- [ ] **Step 1:** Rename modules and `cmd` folders, then fix imports. `go vet ./...` and `go test ./...` in both.
- [ ] **Step 2:** Update every place that builds, bundles or launches the binaries. `pnpm build:collector` produces `bin/nigafiy-sensor.exe`; `pnpm build:agent` produces `bin/nigafiy-agent.exe`. `real-windows-agent.test.ts` passes against the new binary.
- [ ] **Step 3:** Agent and sensor `--version` print `nigafiy-agent <v>` / `nigafiy-sensor <v>`. Gate. Commit.

### Task 5: Product name and logo everywhere a person looks

**Files:** `apps/web/lib/i18n/{core-strings,ui-strings}.ts` and feature `strings.ts` files (EN + AR), `apps/web/app/layout.tsx` (title, icons), the shell header (logo mark + wordmark), login/register/invite/reset pages, account emails (`modules/auth`, `modules/notifications/email.ts` templates), `apps/desktop/package.json` (`productName: "Nigafiy"`, `appId: "com.nigafiy.hub"`, NSIS names), `apps/desktop/src/main.cjs` (window titles, tray tooltip, `setAppUserModelId('com.nigafiy.hub')`, the panel and error pages), `apps/desktop/src/panel/*`, `Start LAN Detective.cmd` → `Start Nigafiy.cmd`, collector and agent log lines and on-screen notices (the remote-desktop notice must still name the operator and now says Nigafiy).
- Create: `apps/desktop/src/data-dir.cjs` + `apps/desktop/test/data-dir.test.cjs`

**Interfaces:**
- Produces: `resolveDataDir({ appData: string, exists: (p: string) => boolean }): { dir: string; legacy: boolean }` → the legacy `<appData>/LAN Detective` when it exists and `<appData>/Nigafiy` does not, else `<appData>/Nigafiy`. `main.cjs` calls `app.setPath('userData', dir)` before anything reads `userData`.

- [ ] **Step 1: Test** `resolveDataDir` for the three cases (only legacy, only new, both → new).
- [ ] **Step 2: Implement** and wire it first thing in `main.cjs`. Log once when the legacy folder is in use ("migrated in a later update").
- [ ] **Step 3:** Replace the visible product name and logo. The remote-desktop transparency notice and the audit wording keep their meaning word for word apart from the name.
- [ ] **Step 4: Verify** in the browser pane: login, dashboard and one page per feature in EN and AR, light and dark. The packaged app's window title, taskbar icon and tray. Commit.

### Task 6: Naming decision table, leftover check, gate

**Files:**
- Create: `docs/architecture/naming.md` (every identifier: old, new or kept, why, and where Milestone 5 migrates it)
- Create: `scripts/check-brand.mjs` + root script `check:brand`: fails when "LAN Detective" or `lan-detective` appears outside an allow-list (`naming.md`, `docs/roadmap/status.md` history, the legacy data-dir constant, migration SQL comments, `LEGACY_ENV` tables, this plan)
- Modify: `README.md`, `docs/**` (product name), `docs/roadmap/status.md`

- [ ] **Step 1:** Write `naming.md` from the constraints above plus anything Tasks 2–5 found.
- [ ] **Step 2:** `pnpm check:brand` passes.
- [ ] **Step 3: Full gate**, then `pnpm run pack` and the packaged local smoke with a scratch `--user-data-dir` (ports 47100/47130/47133 checked free first). Expect: signed in, Sensor enrolled under its new binary name, a sweep of 192.168.1.0/24, clean quit.
- [ ] **Step 4:** Update `status.md`. Commit.
