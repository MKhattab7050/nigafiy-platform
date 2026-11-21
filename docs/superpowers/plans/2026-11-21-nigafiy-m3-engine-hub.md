# Milestone 3: Engine service + Hub — Implementation Plan

**Created:** 2026-11-21. **Why now:** the owner asked for the desktop app first ("do the desktop app first"; "start with the desktop app, do this at the end"). The rename and brand work (Milestone 2) moves to the end; `@nigafiy/brand` assets exist but are not wired in. New components get Nigafiy names from birth; existing ones keep their names until Milestone 2.

**Spec:** `docs/superpowers/specs/2026-11-21-nigafiy-platform-design.md` §6.1, §6.2, §6.4. Master plan Global Constraints apply (never touch the installed LAN Detective, ports 47100/47130/47133; stop processes by PID only; scratch `--user-data-dir` for desktop runs).

**Goal:** the database, API, web server and local Sensor run under one small supervisor, `nigafiy-engine.exe`, that can run as a Windows service (starts at boot, keeps monitoring with no window open) or as a child of the desktop app. The desktop app becomes the Hub: it talks to the engine instead of spawning the stack itself, and its home screen launches every program and shows engine health.

## Decisions (builder's call, spec §11)

| Topic | Decision |
| --- | --- |
| Where | New Go module `engine/` (`github.com/nigafiy/engine`), binary `engine/bin/nigafiy-engine.exe`. Root scripts `build:engine`, `test:engine` |
| Modes | `nigafiy-engine run` (foreground, used by the Hub when no service is installed), `install` / `uninstall` / `start` / `stop` (admin, Windows service `NigafiyEngine` via `golang.org/x/sys/windows/svc/mgr`), and service mode detected with `svc.IsWindowsService()` |
| What it supervises | (1) the stack: `<node> local.mjs --no-open --no-collector` exactly as `apps/desktop/src/local-stack.cjs` runs it today (node = system Node 24 in a checkout, `electron.exe` with `ELECTRON_RUN_AS_NODE=1` when installed); (2) the Sensor (`lan-collector.exe -config <dataDir>/collector/collector.yaml`) only once it is enrolled (the config file exists). Enrollment stays in the Hub (consent dialog, account), which then asks the engine to start the Sensor |
| Restarts | Crashed child restarted with exponential backoff (1 s → 60 s cap, reset after 5 min healthy). A child that dies 5 times within 10 min is marked `failed` and left stopped until a manual restart, so a broken install does not spin |
| Logs | `<dataDir>/logs/engine.log` (rotated at 5 MB, 3 kept) plus each child's stdout/stderr in `<dataDir>/logs/<child>.log`. Tokens (`ldc_`, `lde_`, `ldea_`, `lda_`) are redacted the same way the desktop app redacts them |
| Control channel | HTTP on `127.0.0.1:47140` only. `GET /v1/status` (no secrets: version, mode, each child's state, pid, restarts, last error, web/api URLs). `POST /v1/children/<name>/{start,stop,restart}` and `POST /v1/shutdown` need `Authorization: Bearer <token>`; the token is 32 random bytes written to `<dataDir>/engine/control-token` with an ACL of SYSTEM, Administrators and the user who installed/started it. Host header must be `127.0.0.1:47140` (DNS-rebinding guard) |
| Data dir | The same folder the desktop app uses today (`%APPDATA%\LAN Detective\data` for the user-mode engine). The service-mode data dir (`%ProgramData%\Nigafiy`) and the move into it belong to Milestone 5's installer, which owns the upgrade path |
| Hub ↔ engine | The desktop app first asks `GET /v1/status`. Engine there (service or earlier run): use it. Not there: start `nigafiy-engine run` as a child and stop it on Quit, as the stack is stopped today. `--local-smoke` keeps working |
| Programs | `apps/web/lib/programs.ts` registry (id, EN/AR names, accent, glyph, sections, home path), mirroring spec §5. `GET /api/v1/platform/programs` lists programs with `installed` and how it is known (`bundled` until Milestone 5 ships separate installers) |
| Hub home | The existing overview dashboard gains a "Programs" strip (tile per program: Open, or Install when not installed) and an "Engine" card (each child's state, restarts, last error, from the API's view of the engine) |
| Updates | `modules/platform` update check: reads a signed release manifest (Ed25519, public key built in) from `NIGAFIY_UPDATE_MANIFEST_URL`. Unset (today: the website and download host are an open owner decision) → the Hub says "Update checks are off: no update source is configured", never pretends there is no update |

## Tasks

1. **Engine core (Go)** — supervisor, backoff, logs with redaction, control HTTP, `run` mode; unit tests with fake children (a tiny test helper binary that exits / hangs / prints on command) and a real start/stop test of the stack-free path.
2. **Windows service** — `install/uninstall/start/stop`, service handler, `IsWindowsService`; tested by `go test` for argument handling and by a manual admin run documented in `docs/desktop/engine.md` (not run against the owner's machine without asking).
3. **Platform API** — `modules/platform`: `GET /platform/programs`, `GET /platform/engine` (proxies the engine's `/v1/status`, viewer+), `GET /platform/updates` (manifest check, signature verified, honest "off" state). Integration tests.
4. **Programs registry + Hub home** — `lib/programs.ts`, Programs strip, Engine card, EN + AR, light/dark; Playwright smoke extended.
5. **Desktop as Hub** — `engine-client.cjs` (status, start child engine, control token), `main.cjs` uses it instead of `LocalStack`, `--program=<id>` opens that program's home path, tray shows engine state. Desktop tests with a stand-in engine.
6. **Gate + packaged smoke** — full gate, `pnpm run pack` with the engine bundled, `--local-smoke` with a scratch profile (ports checked free first), docs (`docs/desktop/engine.md`, `status.md`), commit.
