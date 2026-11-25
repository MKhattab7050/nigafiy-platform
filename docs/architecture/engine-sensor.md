# One executable for the Engine and the Sensor

Owner decision, 2026-11-25: the Engine (`engine/`, module `github.com/nigafiy/engine`) and the
Sensor (`collectors/lan-collector/`, module `github.com/nigafiy/sensor`) ship as **one Go
executable, `nigafiy-engine`**. Engine mode is the default. Branch sites that run only a Sensor
use the `sensor` subcommand. The endpoint Agent (`agents/endpoint-agent`), the API, the web
console and the desktop app stay separate components; this decision does not merge them.

## Module layout

There are still **two Go modules**. The engine module imports the Sensor through a `replace`:

```
engine/go.mod
  require github.com/nigafiy/sensor v0.0.0
  replace github.com/nigafiy/sensor => ../collectors/lan-collector
```

The Sensor module has one new public package, `github.com/nigafiy/sensor/sensorcmd`. It holds
the Sensor's whole command line: flags, environment, config file, logging and signals (what
`cmd/nigafiy-sensor/main.go` used to contain). Everything else stays in `internal/`, which only
the Sensor module itself can import. The engine's `cmd/nigafiy-engine` calls `sensorcmd.Main`.

Why two modules and not one merged `go.mod`:

- The Sensor module stays buildable and testable on its own (`pnpm test:collector`,
  `go vet ./...` in `collectors/lan-collector`, its probe tools `router-probe`, `snmp-probe`,
  `identify-probe`, `snmp-sim`). Nothing in its 100+ files had to move, and every
  `github.com/nigafiy/sensor/internal/...` import path stays the same.
- One module would mean either moving the engine into `collectors/lan-collector` or moving the
  Sensor under `engine/`. Both churn every path, doc and test for no gain. naming.md already
  keeps the repository folders for that reason.
- Both modules are pure Go (`golang.org/x/sys`, `x/net`, `gosnmp`, `pro-bing`, `yaml.v3`). The
  merged binary builds with `CGO_ENABLED=0` for windows, linux and darwin, on amd64 and arm64.
  Minimal version selection puts both modules on one `x/sys` (the higher, v0.50.0).
- The Docker image builds from the **repository root** (`docker build -f
  collectors/lan-collector/Dockerfile .`), because it needs both folders. A
  `Dockerfile.dockerignore` next to the Dockerfile keeps `node_modules`, `apps/` and the rest out
  of the build context. The image builds for `linux/arm64` with `--platform` (BuildKit's
  `TARGETARCH`, `CGO_ENABLED=0`).

`cmd/nigafiy-sensor` stays in the Sensor module as a Sensor-only **development** build. It is a
three-line `main` that calls `sensorcmd.Main`. No installer, image or unit ships it.

## How engine mode runs the Sensor: a child process of the same executable

In engine mode the engine starts the Sensor as **its own child process**:
`<this nigafiy-engine> sensor -config <data>/collector/collector.yaml`. It is supervised exactly
like the database, the API and the web server: its own restart backoff, rotated log
(`logs/sensor.log`), Job Object on Windows (the Sensor dies with the engine) and status in
`/v1/status`.

An in-process goroutine was rejected because it cannot meet the owner's rule that a Sensor
panic must never stop the engine supervising db/api/web:

- `recover()` only catches a panic in the **same goroutine**. The Sensor starts dozens of its
  own goroutines (discovery workers, ICMP and ARP probes, the DNS filter server, the MNDP
  listener, router drivers, uploads). An unrecovered panic in any one of them ends the whole
  process. Wrapping every `go` statement in 100+ files is fragile, and new code would break it
  silently.
- Some failures cannot be recovered at all: `fatal error: concurrent map writes`, stack
  exhaustion, running out of memory, and a `log.Fatal` or `os.Exit` deep in a library. In
  process, any of them would take the database, API and web server down with the Sensor.
- A separate process gives the Sensor its own memory, its own descriptors and sockets (ports 53
  and 5678), and its own signal handling. The engine can kill it on Windows without stopping
  itself (the Sensor writes every batch to its on-disk spool before upload, as before).

The cost is a second process running the same file, which is what the two-executable install
already ran. The engine's process starts in milliseconds, and in engine mode it never loads the
Sensor's code paths.

Which program the engine starts as the Sensor (`--sensor-exe`, env `NIGAFIY_ENGINE_SENSOR_EXE`):

| `--sensor-exe` | The engine starts | Arguments |
| --- | --- | --- |
| not set (default) | itself (`os.Executable()`) | `sensor -config <file>` |
| the engine's own file | itself | `sensor -config <file>` |
| another existing program (an old standalone `nigafiy-sensor`, or a development build) | that program | `-config <file>` (the old interface) |
| a missing file named `nigafiy-sensor[.exe]` or `lan-collector[.exe]` | itself, and the log says so | `sensor -config <file>` |

The last row exists for service command lines recorded before the merge. `nigafiy-engine
install` writes every resolved path into the service's command line, including
`--sensor-exe=…\collector\nigafiy-sensor.exe`. After an update that file is gone, and the engine
uses itself instead of reporting the Sensor missing.

## Command line

```
nigafiy-engine run [flags]                    engine mode (unchanged)
nigafiy-engine install | uninstall | start | stop | status | install-info | version   (unchanged)
nigafiy-engine sensor [-config <file>] [-check-config] [-version]
                                              the Sensor alone, exactly like the old nigafiy-sensor
```

- `sensor` takes the old program's flags (`-config`, `-check-config`, `-version`; `--name` works
  too), environment (`NIGAFIY_SENSOR_*`, and the legacy `LAN_COLLECTOR_*` names with one
  deprecation line), config file, exit codes (`0`, `1` run error, `2` bad flags or invalid
  configuration) and output (`-version` still prints `nigafiy-sensor <version>`; JSON logs on
  stderr with `service: nigafiy-sensor`).
- **Name alias.** If the executable's file name (case-insensitive, without `.exe`) is
  `nigafiy-sensor` or `lan-collector`, **every** argument goes to the Sensor, as if `sensor` came
  first. A symbolic link, hard link or copy of `nigafiy-engine` with one of those names behaves
  exactly like the old program. Existing systemd units, Docker `--entrypoint` overrides and
  scripts that call `/usr/local/bin/nigafiy-sensor -config …` keep working once that path is a
  link to `nigafiy-engine`.
- **One version.** The executable has one version, `main.Version` (`-ldflags "-X
  main.Version=1.2.3"`, the flag `pnpm release` already passes). The Sensor reports it to the
  server and in its User-Agent (`nigafiy-sensor/<version>`). The engine used to read
  `main.version` (lower case), which the release script never set, so release builds of the
  engine reported `0.1.0-dev`. That is fixed by the rename.

## What stays compatible

| What | After the merge |
| --- | --- |
| Sensor state (`state/*.json`, `collector.yaml`, the desktop's `<profile>\collector`, `/var/lib/lan-collector`, `/etc/lan-collector/`) | Unchanged. The same code reads the same files. |
| Environment variables | `NIGAFIY_SENSOR_*` with the `LAN_COLLECTOR_*` fallback; the engine's `NIGAFIY_ENGINE_*` unchanged |
| Enrollment and tokens (`lde_`, `ldc_`), wire protocol (`/v1/collectors/*`), ownership value, User-Agent | Unchanged (internal packages untouched) |
| Update manifest components | `desktop-windows-x64`, `endpoint-agent-windows-x64`; there was never a separate Sensor component |
| systemd unit name, user, `StateDirectory` (`lan-collector`) | Unchanged; only `ExecStart` now names `nigafiy-engine sensor` |
| Docker image name, container name, volume (`nigafiy/sensor`, `nigafiy-sensor`, `lan-collector:/var/lib/lan-collector`) | Unchanged. `ENTRYPOINT ["/usr/local/bin/nigafiy-engine", "sensor"]`, so `docker run … nigafiy/sensor -config …` passes the same arguments |
| Firewall program path | **Changes**: `resources\engine\nigafiy-engine.exe` instead of `resources\collector\nigafiy-sensor.exe` (MSIX manifest; see the upgrade path) |
| Desktop app | Runs `resources\engine\nigafiy-engine.exe sensor -config …` for its Sensor (still with the engine started `--no-sensor`, as before) |

## Upgrade path from today's two-executable installs

| Install | What changes | What an old install sees after the update |
| --- | --- | --- |
| **NSIS** (per-user, desktop app) | `resources\collector\` is no longer in the package. electron-builder's NSIS upgrade runs the old uninstaller (app data kept) and installs into the same folder, so the old `nigafiy-sensor.exe` is removed with the rest of the old files | The Sensor keeps its identity (`%APPDATA%\Nigafiy\collector`, or the pre-rename profile) and starts again as `nigafiy-engine.exe sensor`. The first time it opens UDP 5678 (MNDP) or port 53 (DNS filter), Windows Defender Firewall may show its "allow access" prompt **for `nigafiy-engine.exe`**, because it decides per program path. A rule the person accepted earlier for `nigafiy-sensor.exe` points at a deleted file and does nothing |
| **MSI** (per-machine) | Same `upgradeCode`; the major upgrade removes the old component with `nigafiy-sensor.exe` | Same as NSIS |
| **MSIX** (Microsoft Store) | The manifest declares the inbound rules (UDP 5678, UDP 53, TCP 53, domain and private networks only) for `app\resources\engine\nigafiy-engine.exe`. Windows replaces the package as a whole, rules included | No prompt; the rules follow the new path with the package update |
| **Engine as a Windows service** (`nigafiy-engine install`, never done by an installer) | The recorded `--sensor-exe=…\nigafiy-sensor.exe` no longer exists | The engine falls back to itself (table above) and logs one line. `nigafiy-engine uninstall` then `install` records a command line without the old path |
| **Docker** (Linux branch Sensors) | Rebuild or pull the new image; run it with the same `docker run` line (same volume, same env) | Same identity from the volume. `/usr/local/bin/nigafiy-sensor` and `/usr/local/bin/lan-collector` in the image are links to `nigafiy-engine`, so an `--entrypoint` override still works |
| **systemd** (Linux branch Sensors) | `collectors/lan-collector/deploy/upgrade-to-engine.sh <path to new nigafiy-engine>` installs `/usr/local/bin/nigafiy-engine` and points `/usr/local/bin/nigafiy-sensor` at it (a link), then restarts the unit | The **old** unit file (`ExecStart=/usr/local/bin/nigafiy-sensor -config …`) keeps working unchanged through the name alias. The new unit file in the repository says `nigafiy-engine sensor -config …`; copying it in is optional |

## What ran here, what is tested only, what never ran

Ran on the development PC (2026-11-25, scratch ports and a scratch data folder, loopback only):

- `nigafiy-engine.exe run --data-dir=<scratch> --control-addr=127.0.0.1:47171` from a source
  checkout with a scratch `.env` (API 4471, web 3471, database 5471): db, api and web became
  ready and healthy; the Sensor waited as "not enrolled".
- `nigafiy-engine.exe sensor -config <scratch>/collector/collector.yaml` with an enrollment token
  from the scratch API (`http://localhost:4471`): logged `enrolled`, and the API listed the
  collector `online`, version `0.1.0-dev`, os `windows`. No network range was authorized, so
  nothing was probed (the smart checks found no authorized interface); the token never appeared
  in the Sensor's log.
- With that configuration in place, `POST /v1/children/sensor/start` made the engine start
  `nigafiy-engine.exe sensor -config …` as its child (process list: parent = the engine). Killing
  that child by its PID: the engine restarted it (restarts 1), db/api/web kept the same PIDs and
  zero restarts. `POST /v1/shutdown` stopped sensor, web, api, db in that order.
- The desktop's real-Sensor test (`collector-manager.test.cjs`) enrolls, runs, stops and restarts
  `nigafiy-engine.exe sensor` against a stand-in server.

Tested only (Go and Node tests): mode selection and the name alias; the old command line and the
legacy `LAN_COLLECTOR_*` variables behind `sensor`; `--sensor-exe` resolution including the
missing-old-path fallback; a Sensor that panics over and over is restarted while db/api/web keep
running; a CGO-off build of the executable answers to the names `nigafiy-sensor` and
`lan-collector`; cross-builds for windows, linux and darwin on amd64 and arm64; the packaging
config (no `collector` resource, MSIX firewall rules for the engine exe).

Never ran: the upgrade over a real old install (NSIS, MSI, MSIX; the owner's installation is
never touched), the merged NSIS/MSI/MSIX packages (not rebuilt here), the Docker image (no
Docker), the systemd unit and `deploy/upgrade-to-engine.sh` (no Linux machine), the Windows
service path (no service is installed here).
