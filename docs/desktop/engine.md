# Nigafiy Engine (`engine/`)

`nigafiy-engine.exe` is a small Go supervisor for everything that runs on this computer: the
**database** (embedded PostgreSQL), the **API** and the **web console** (three separate children,
each started through `scripts/local.mjs --component=<name>`) and the local **Sensor**
(`lan-collector.exe`). It keeps them running, restarts them when they crash, writes
their logs, and answers a local control API that the Hub (desktop app) and the API use.

It runs either in the foreground (`nigafiy-engine run`, used by the Hub when no service is
installed) or as the Windows service `NigafiyEngine` (starts at boot, keeps monitoring with no
window open).

Build and test:

```bash
pnpm build:engine   # → engine/bin/nigafiy-engine.exe
pnpm test:engine    # go test ./... in engine/
```

## Commands

| Command | What it does |
| --- | --- |
| `run [flags]` | Runs in the foreground until Ctrl+C or `POST /v1/shutdown`. Exit codes: `0` clean stop, `1` error, `2` bad arguments, `3` another engine already answers on the control address (it is left alone and no second stack is started) |
| `install [flags]` | Admin. Creates the service `NigafiyEngine` ("Nigafiy Engine", start type automatic, LocalSystem) with recovery actions (restart after 10 s, then 60 s). Every path is resolved at install time and recorded in the service command line as `run --data-dir=… --node=… …`, plus `--owner-sid=<SID of the installing user>` so that user can read the control token |
| `uninstall` | Admin. Stops the service if running, then deletes it |
| `start` / `stop` | Admin. Starts / stops the service (stop waits until it has stopped) |
| `status [--control-addr=…]` | Prints the running engine's `GET /v1/status` (exit 1 if none answers) |
| `version` | Prints the version (set with `-ldflags "-X main.version=…"`, default `0.1.0-dev`) |

On non-Windows systems the service commands answer "not supported on this OS"; `run` works.

When started by the Service Control Manager (`svc.IsWindowsService()`), the binary runs the service
handler instead of parsing a subcommand: Stop and Shutdown requests stop the Sensor, the web
console, the API and the database, then report the service stopped (StopPending with checkpoints every 5 s while children stop).

### Flags of `run` / `install`

Both `--name value` and `--name=value` work. Each flag also has an environment variable.

| Flag | Env | Default |
| --- | --- | --- |
| `--data-dir` | `NIGAFIY_ENGINE_DATA_DIR` | `NIGAFIY_DATA_DIR` (legacy `LD_DATA_DIR`) if set (what `local.mjs` uses), else `<repo>/.data` in a source checkout, else `%APPDATA%\Nigafiy\data` (or the legacy `%APPDATA%\LAN Detective\data` while only that one exists) |
| `--node` | `NIGAFIY_ENGINE_NODE` | `node` from `PATH`, else `C:\Program Files\nodejs\node.exe` |
| `--stack-script` | `NIGAFIY_ENGINE_STACK_SCRIPT` | `<repo>/scripts/local.mjs` (repo = first folder above the engine exe, then above the working directory, that has `scripts/local.mjs`) |
| `--bundle-dir` | `NIGAFIY_ENGINE_BUNDLE_DIR` | none; passed to the stack as `NIGAFIY_BUNDLE_DIR` (installed app) |
| `--sensor-exe` | `NIGAFIY_ENGINE_SENSOR_EXE` | `<repo>/collectors/lan-collector/bin/lan-collector.exe` |
| `--sensor-config` | `NIGAFIY_ENGINE_SENSOR_CONFIG` | `<data-dir>/collector/collector.yaml` |
| `--no-sensor` | — | off. With it the Sensor is not supervised at all (see below) |
| `--control-addr` | `NIGAFIY_ENGINE_CONTROL_ADDR` | `127.0.0.1:47140`. Must be a loopback IP literal with a port; anything else is refused |
| `--owner-sid` | — | none; a further SID allowed to read the control token (written by `install`) |
| `--update-publisher` | `NIGAFIY_UPDATE_PUBLISHER_THUMBPRINT` | none; SHA-1 thumbprint every update installer must be Authenticode-signed with |

Note for the installed app: the desktop app keeps the collector's files in
`%APPDATA%\LAN Detective\collector\`, not under `data\`, so it must pass `--sensor-config` (or
`--no-sensor`) explicitly.

## What it supervises

Since Milestone 5 the database, the API and the web console are **three separate children**, each
with its own restart backoff, ready check, health check, log and Job Object, plus the Sensor:

| Child | Command | Ready when | Health check (every 15 s, 3 failures in a row → killed and restarted) | Stop timeout |
| --- | --- | --- | --- | --- |
| `db` | `<node> <stack-script> --component=db --engine-status-file=<data-dir>/engine/db-status.json` | status file says `ready` with the port | TCP connect to `127.0.0.1:<port>` | 30 s |
| `api` | `… --component=api …/api-status.json` | `ready` with `apiUrl` | `GET <apiUrl>/readyz` → 200 | 20 s |
| `web` | `… --component=web …/web-status.json` | `ready` with `webUrl` | `GET <webUrl>` → < 500 | 15 s |
| `sensor` | `<sensor-exe> -config <sensor-config>` | started | — | 5 s |

Start order: `db` → `api` → `web`, and `sensor` once `api` runs. Each child starts only when every
part it depends on is `running` (`waiting_for` in the status says what it waits for); a part whose
dependency stopped or failed for good is not started and waits for a manual start. Stop order is
the reverse: Sensor, web, API, database.

- `POST /v1/children/{name}/stop` stops the parts that depend on it first (stopping `api` stops
  `sensor` and `web`, then `api`).
- `POST /v1/children/{name}/start` is refused with **409** while a dependency is not running
  ("start db first").
- `POST /v1/children/{name}/restart` stops the dependants, restarts the part, and starts again (in
  order, once it runs) the dependants that were running.
- Health checks run in their own goroutine, so a slow check never delays a stop. Addresses in the
  ready reports must be on this computer (loopback or `localhost`); the engine refuses others.

Working directory = the script's folder, environment = the engine's plus `NIGAFIY_DATA_DIR=<data-dir>`
(and `NIGAFIY_BUNDLE_DIR` when given). `ELECTRON_RUN_AS_NODE=1` is added only when `--node` is not a
`node`/`node.exe` (that is, the installed desktop app's own executable), exactly as
`apps/desktop/src/local-stack.cjs` does it.

- `local.mjs --component=<name>` runs that one part, using the same code as `pnpm local` (the
  `runDatabase` / `runApi` / `runWeb` functions in the script), but it **never reuses** a part
  already running on its port: a database, API or web app that answers there was started by
  something else, so it says so and exits (the engine shows that as the part's `last_error`). A
  database left behind by a hard kill that holds the port without answering is stopped and
  restarted, as before.
- It writes the status file atomically (temporary file + rename):
  `{"state":"ready","component","port","apiUrl","webUrl","pid"}` once its part answers, or
  `{"state":"error","message","component","pid"}` on a fatal error. The engine deletes any old file
  before each start and counts the child as `running` only when the file says `ready` **and** its
  `pid` is the process it started. An `error` message becomes the child's `last_error`
  (e.g. `Port 4100 is in use by another program. (exited with code 1)`).
- If a part is not ready within 5 minutes it is killed and counted as a crash.
- Stop: the engine closes the child's stdin; `local.mjs` treats that as "stop" and stops its part
  (the database through embedded-postgres' clean shutdown). After the stop timeout the tree is killed.
- Its output goes to stdout, which the engine writes to `logs/<name>.log` (rotated, redacted); it
  does not open the log file itself in this mode.
- `pnpm local` (all parts in one process, reusing what already runs) and the IPC behaviour used by
  the desktop app's direct launcher are unchanged.

**sensor** — `<sensor-exe> -config <sensor-config>`, only when the config file exists. Otherwise
the child stays `stopped` with `last_error: "not enrolled"`. Enrollment stays in the Hub (consent,
account); afterwards the Hub calls `POST /v1/children/sensor/start`. `NIGAFIY_SENSOR_ENROLLMENT_TOKEN`
is removed from its environment. On Windows the Sensor is stopped by killing it (as the desktop app
does; every batch is already in its on-disk spool); elsewhere SIGTERM first, kill after 5 s.

**`--no-sensor`** — the Sensor child is not supervised at all: `GET /v1/status` lists it as
`state: "stopped"`, `last_error: "disabled: the desktop app runs the Sensor"`, and
`POST /v1/children/sensor/{start,stop,restart}` answers **409** with a message saying the engine
was started with `--no-sensor`.

### Restart policy

| Rule | Value |
| --- | --- |
| Restart delay after a crash | 1 s, doubling each time, capped at 60 s |
| Delay reset | after the child has been `running` for 5 minutes |
| Give up | 5 deaths within 10 minutes → `failed`; stays stopped until a manual start/restart (which also resets the budget) |
| A failed start (exe missing, cannot spawn) | counts as a death |
| Precheck refusal ("not enrolled", script/node missing) | `stopped` with that `last_error`; not a crash, not retried |

Child states: `stopped`, `starting` (process up, not ready yet), `running`, `backoff` (waiting to
restart), `failed`.

### Process trees

Every child is started suspended, placed in its own **Job Object** with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then resumed, so it cannot start anything outside the job.
Killing a child terminates the job: node, `postgres.exe`, the API and web servers all go with it.
When the child's main process exits after a stop request, its remaining processes get 5 s to exit on
their own, then the job is terminated. When it exits unexpectedly, the job is terminated at once,
so a restart never finds a half-dead database. If the engine itself dies, Windows closes the job
handle and the children die with it. Nothing is ever stopped by image name. (POSIX: a process group
per child, killed with SIGKILL.)

## Graceful shutdown

Ctrl+C / SIGTERM (foreground), service Stop/Shutdown, or `POST /v1/shutdown`: stop the Sensor, the
web console, the API and the database (in that order), close the control API, delete the control
token and the status files, exit 0.

## Control API

HTTP on `127.0.0.1:47140` only. Every request whose `Host` header is not exactly the listen address
(`127.0.0.1:47140`) is answered **403** — a DNS-rebinding guard (a page that points its own name at
127.0.0.1 still sends its own name as Host). Responses carry `Cache-Control: no-store`; request
bodies are capped at 4 KB.

`GET /v1/status` — no authentication, never contains secrets:

```json
{
  "version": "0.1.0-dev",
  "mode": "foreground",
  "data_dir": "D:\\network\\.data",
  "started_at": "2026-11-21T16:50:03.04Z",
  "children": [
    {"name": "db", "state": "running", "pid": 14836, "restarts": 0, "last_error": null, "started_at": "2026-11-23T00:54:40Z",
     "health": "ok", "health_error": null, "health_checked_at": "2026-11-23T00:55:10Z", "depends_on": [], "waiting_for": null},
    {"name": "api", "state": "running", "pid": 20192, "...": "..."},
    {"name": "web", "state": "running", "pid": 7020, "...": "..."},
    {"name": "sensor", "state": "stopped", "pid": null, "restarts": 0, "last_error": "not enrolled", "started_at": null,
     "health": null, "health_error": null, "health_checked_at": null, "depends_on": ["api"], "waiting_for": null}
  ],
  "stack": {"web_url": "http://localhost:3100", "api_url": "http://localhost:4100"},
  "update": {"state": "idle", "version": null, "last": null}
}
```

`mode` is `"service"` or `"foreground"`. `stack` is `null` until both `api` and `web` are
`running`. `health` is `"ok"` / `"failing"` for a running child once checked. `update` is described
in `docs/operations/updates.md`.
`pid`, `last_error` and `started_at` are `null` when there is none. `restarts` counts automatic
restarts since the engine started.

Authenticated (`Authorization: Bearer <token>`, compared in constant time; missing or wrong → 401):

| Request | Answer |
| --- | --- |
| `POST /v1/children/{db\|api\|web\|sensor}/start` | 200 + the child's entry. A `failed` child gets a fresh restart budget. Returns once launched (not once ready) |
| `POST /v1/children/{name}/stop` | 200 + entry, after the process tree is gone |
| `POST /v1/children/{name}/restart` | 200 + entry, after stop and relaunch |
| `POST /v1/shutdown` | 202 `{"ok":true}`, then the graceful shutdown above |
| `POST /v1/update/apply` | 202 + the update state; see `docs/operations/updates.md` |

Unknown child or action → 404; Sensor action under `--no-sensor`, or a start while a dependency
is not running → 409; any action while the engine
is shutting down → 503. Errors are `{"error":{"code","message"}}`.

### Contract used by the desktop app (child engine)

When no engine answers `GET /v1/status`, the desktop app starts one as its child with

```
nigafiy-engine run --data-dir=<dir> --node=<exe> --stack-script=<local.mjs> --no-sensor [--control-addr=127.0.0.1:<port>]
```

reads the stack URLs from `/v1/status` → `stack.web_url` / `stack.api_url` (null until ready) and
the `db` / `api` / `web` children's `state` / `last_error` (an older engine's single `stack` child is
still understood), and on Quit sends `POST /v1/shutdown` with the token from
`<data-dir>/engine/control-token` (readable by the user who started the engine).

## Files

| Path (under the data folder) | Contents |
| --- | --- |
| `engine/control-token` | 64 hex characters (32 random bytes), new on every start, deleted on clean exit. Written to a temporary file whose DACL is replaced first, then renamed into place. Windows: protected DACL (no inheritance) granting full control to `SYSTEM`, `BUILTIN\Administrators`, the user running the engine and `--owner-sid` if given — set with `SetNamedSecurityInfo` from `golang.org/x/sys/windows` (not `icacls`). Elsewhere: mode 0600 |
| `engine/{db,api,web}-status.json` | Written by `local.mjs --component` (see above); deleted on clean exit |
| `logs/engine.log` | The engine's own log (also printed to the console in foreground mode) |
| `logs/db.log`, `logs/api.log`, `logs/web.log`, `logs/sensor.log` | Each child's stdout + stderr, one timestamped line at a time, colour codes stripped |
| `logs/update.log` | The update helper's log (`docs/operations/updates.md`) |

All engine logs rotate at 5 MB, keeping three old files (`engine.log.1` … `engine.log.3`). Every
line is redacted before it is written: anything matching the desktop app's pattern
`ld(c|e|ea|a)_[A-Za-z0-9._-]{8,}` (collector credentials, enrollment tokens, endpoint-agent tokens)
becomes `[redacted]`. Redaction works on whole lines, so a token split across two writes is still
caught. The control token is never logged.

## What was verified, and what was not

Verified on the development machine (Windows 11, 2026-11-21):

- `go vet ./...` (also with `GOOS=linux`; `GOOS=darwin go build`) and `go test ./...` pass. Tests
  cover: backoff doubling to the 60 s cap, reset after 5 min healthy, `failed` after 5 deaths in
  10 min and manual restart, stop during backoff, graceful stop then kill after the timeout, ready
  check and ready timeout (fake clock, fake processes); real processes (the test binary re-executed
  as a helper): exit code recorded, hung child killed after the stop timeout, clean stop on stdin
  close, token-like output redacted in the log file, grandchild killed with the job, missing
  executable; log rotation; control API auth (none/wrong/malformed → 401, right → 200), Host guard
  (→ 403), status JSON keys, probe; token file ACL read back (protected, exactly SYSTEM +
  Administrators + current user); engine with a stand-in stack: ready → URLs in status, Sensor
  "not enrolled", Sensor started after its config appears, `--no-sensor` → 409, stack error message
  surfaced, second instance → `ErrAlreadyRunning`, shutdown via the API and via cancellation;
  flag parsing (`--a=b` and `--a b`), defaults, service command line round trip, service handler
  Stop/Shutdown/Interrogate and failure exit codes (handler called directly, no SCM).
- Real foreground runs against the source checkout (two: the second with the final binary, after
  the 5 s drain was added to the stop path; ports 47140/3100/4100/5433 checked free first): stack ready in about 16 s with `web_url` `http://localhost:3100` and `api_url`
  `http://localhost:4100`; `/login` answered 200; a second `run` exited with code 3; a wrong Host got
  403 and a token-less shutdown 401; the token file's ACL was SYSTEM, Administrators and the current
  user only; `POST /v1/shutdown` with the token stopped everything (`local.mjs` shut down db/api/web
  itself) within about 1 s, exit code 0, every process of the engine's tree gone, ports free,
  token and status file removed. That run used `--sensor-config` pointing at a non-existent file so
  the real Sensor (this checkout has an enrolled `.data/collector/collector.yaml`) did not scan the
  network.

Milestone 5 (2026-11-23, per-component supervision):

- Go tests: health checks (pass → `ok`; failures counted; 3 in a row kill the child, which is then
  restarted with the backoff; a recovering check resets the count; no check while stopping), the
  group's ordering with fake children (start in order only once dependencies run, `waiting_for`,
  a failed dependency stops the chain, stop takes dependants down first, restart brings running
  dependants back, close in reverse order), and the engine with stand-in components (a test helper
  that listens like a database, serves `/readyz` like the API and a page like the web server):
  three separate processes, reverse stop order in the log, `stop api` stops `web`, `start web`
  without the API → 409, `restart db` brings API and web back, an API error is reported while `web`
  waits for it.
- Real foreground run against this checkout with a scratch data folder and scratch ports (API
  47600, web 47630, database 47633, control 47640; never the owner's 3100/4100/5433 or the
  installed app's ports): `db`, `api`, `web` each ready as its own process, health `ok` for all
  three after the first checks; `POST /v1/children/db/restart` stopped web, API and database in
  that order and brought them back in order; `POST /v1/shutdown` stopped web → API → database in
  under a second, every port free afterwards.
- Packaged app: `pnpm --filter @nigafiy/desktop run pack` into a scratch output folder
  (unsigned: no certificate on the build computer), then the packaged
  `resources\engine\nigafiy-engine.exe run` with a scratch data folder and `.env`, `--node` = the
  packaged `LAN Detective.exe`, `--stack-script`/`--bundle-dir` = `resources\backend`, control
  47641, `--no-sensor`: database, API and web started from the bundle as three processes (ready in
  about 24 s, 54 s and 26 s on a first start), health `ok`, `/readyz` 200, web 200;
  `restart api` stopped web then API and brought both back in order; `POST /v1/update/apply` with a
  wrong SHA-256 → 422 and the engine kept running; shutdown web → API → database, every port free.
  The desktop app itself (Electron window) was not started.

Not verified:

- `install` / `uninstall` / `start` / `stop` and service mode were **not run** on this machine (no
  service was installed). To check by hand from an administrator prompt on a test machine:
  `nigafiy-engine install`, `sc qc NigafiyEngine`, `nigafiy-engine start`, `nigafiy-engine status`,
  reboot and `status` again, `nigafiy-engine stop`, `nigafiy-engine uninstall`.
- Running the stack as LocalSystem: embedded PostgreSQL may refuse to run with administrative
  rights, and `%APPDATA%` differs for LocalSystem. The service-mode data folder
  (`%ProgramData%\Nigafiy`) and its account belong to Milestone 5's installer.
- The real Sensor under the engine (only a stand-in Sensor was supervised in tests).
- The web console's health check against a development server under heavy first-compile load
  (it has 3 s per check and three tries, 45 s in all; the production server answers in milliseconds).
- The POSIX code paths are compiled and vetted, not run.
- The embedded database is still stopped by `embedded-postgres` itself with `taskkill /f` on
  Windows (pre-existing behaviour of `apps/api/scripts/dev-db.ts`), so `postmaster.pid` is left
  behind and PostgreSQL recovers on the next start; the engine does not change that.
