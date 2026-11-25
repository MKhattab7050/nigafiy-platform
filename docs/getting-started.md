# Getting started: run, build and test

Everything here runs on one computer and listens on loopback only, unless you turn on the LAN TLS
listener ([features/lan-tls.md](features/lan-tls.md)). This page moved out of the root README; nothing
was dropped.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | 24 or later (`engines.node` in `package.json`) | API, web, desktop, scripts |
| pnpm | 10 (`packageManager` pins `pnpm@10.34.8`; `pnpm local` installs it when missing) | Workspace install and scripts |
| Go | 1.27.3 or later (the `go` line of all three `go.mod` files; CI reads it from `collectors/lan-collector/go.mod`) | Engine, Sensor, Agent |
| Windows 10/11 | — | The desktop app, installers and the engine's service mode. The Sensor and the Agent also build for Linux and macOS |

Docker, PostgreSQL and Redis are **not** required: development and tests run a real PostgreSQL from the
`embedded-postgres` npm package. Go code is pure Go (`CGO_ENABLED=0`), so no C compiler is needed.

## Option 1: the desktop app

Install **Nigafiy** (`apps/desktop`, installer built with `pnpm --filter @nigafiy/desktop dist`) and
open it. Nothing else is needed: the installer carries the database, API, web app and the engine (which
is also the Sensor), and runs them with the app's own built-in Node.js.

On first open it starts everything on this computer (loopback only, ports 47100/47130/47133, data in the
user profile), signs in with a local account it creates for you (random password, encrypted with Windows
DPAPI), finds the network you are connected to and **asks once whether to scan it**. Say yes and the
dashboard opens with your devices appearing within about a minute. Every later open goes straight to the
dashboard. Closing the window keeps monitoring in the tray; **Quit** from the tray stops everything.

Building the installer needs Node.js 24, pnpm, Go 1.27.3 and this repository:

```bash
pnpm --filter @nigafiy/desktop dist
```

Running the desktop app from the repository (`pnpm --filter @nigafiy/desktop start`) does the same
using the repository's code and your system Node.js 24, and shares `.data/` with `pnpm local`.

More: [desktop/README.md](desktop/README.md), [desktop/engine.md](desktop/engine.md),
[operations/installers.md](operations/installers.md).

## Option 2: one command (no desktop app)

On Windows, double-click **`Start Nigafiy.cmd`**. On any system:

```bash
pnpm local
```

The first time, it:

1. installs dependencies and creates `.env` with fresh secrets,
2. starts the database, API and web app on this computer,
3. finds the network this computer is connected to (for example `192.168.1.0/24`) and **asks you to
   confirm it is your network**,
4. asks for an email and password (your account lives only in the local database),
5. authorizes that one range and enrolls this computer as its Sensor, then opens http://localhost:3100.

Every later run is just `pnpm local` (or the double-click): everything starts, the Sensor resumes, and the
browser opens. Ctrl+C (or closing the window) stops it all. Data stays in `.data/` (database, Sensor
identity, logs in `.data/logs`). Options: `--no-open`, `--no-collector`, `--prod` (optimized web build),
`--token <token>` (enroll with a token created in the web app instead of the guided setup).

`pnpm local:autostart` installs a per-user auto-start launcher; `pnpm local:stop-autostart` removes it.

Notes: everything runs on this computer and listens on localhost only. Phone names come from passive DHCP
listening (UDP 67) and appear when a phone reconnects to Wi-Fi. On Linux, ICMP and port 67 need extra
privileges (`CAP_NET_RAW`, `CAP_NET_BIND_SERVICE`).

## Option 3: run the parts separately (development)

```bash
pnpm install
```

```bash
cp .env.example .env
```

Edit `.env`: set `APP_ENCRYPTION_KEY` (the file shows how to generate one) and change the `lan_app` password.
Then, in three terminals:

```bash
pnpm dev:db
```

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

| Part | Address |
| --- | --- |
| Web console | http://localhost:3100 |
| API | http://localhost:4100 |
| PostgreSQL | localhost:5433 (data in `.data/pg`) |

Open http://localhost:3100, create an account, then go to **Discovery & Collectors**:

1. Authorize the network range you own (for example `192.168.1.0/24`).
2. Add a collector: you get a one-time enrollment token.
3. Build and start the Sensor on a machine inside that network:

```bash
pnpm build:engine
```

```bash
NIGAFIY_SENSOR_ENROLLMENT_TOKEN=<token> ./engine/bin/nigafiy-engine sensor -config collectors/lan-collector/configs/collector.example.yaml
```

The engine and the Sensor are one executable, `nigafiy-engine`: `nigafiy-engine sensor` is the
Sensor alone, with the same flags and `NIGAFIY_SENSOR_*` settings the old `nigafiy-sensor` had
([architecture/engine-sensor.md](architecture/engine-sensor.md)).

(For a local test against the dev API use `server_url: http://localhost:4100` with `allow_insecure_http: true`.)

`pnpm dev:db` starts a real PostgreSQL server from npm-distributed binaries, stored in `.data/pg`.
With Docker available, `docker compose up` provides PostgreSQL (TimescaleDB image) and Redis instead;
that compose file has **not** been exercised in the environment this repository was built in.

`pnpm migrate` applies the SQL migrations (`apps/api/src/database/migrations`) on their own; the API also
applies them at start.

## Build

| Command | Output |
| --- | --- |
| `pnpm build` | Brand assets (`packages/brand`), then the web production build |
| `pnpm build:engine` | `engine/bin/nigafiy-engine(.exe)`: the engine and the Sensor |
| `pnpm build:collector` | `collectors/lan-collector/bin/`: a Sensor-only development build (`cmd/nigafiy-sensor`) |
| `pnpm build:agent` | `agents/endpoint-agent/bin/`: `nigafiy-agent` and `nigafiy-support.exe` (Quick Support) |
| `pnpm build:launchers` | One small launcher per program (`engine/cmd/nigafiy-launcher`) |
| `pnpm build:agent-installer` | The endpoint agent NSIS installer |
| `pnpm --filter @nigafiy/desktop dist` / `dist:msi` / `dist:msix` | Desktop NSIS installer / MSI / MSIX package |
| `pnpm release` | Every installer signed, plus the signed update manifest ([operations/updates.md](operations/updates.md)) |

`pnpm build` rewrites `packages/brand/svg/*` with LF line endings: run `git checkout -- packages/brand`
before committing.

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` in every workspace package |
| `pnpm lint` | Biome (`biome.json`) |
| `pnpm check:brand` | Fails when the old product name appears outside the allow-list ([architecture/naming.md](architecture/naming.md)) |
| `pnpm test` | API integration tests: real HTTP → Express → SQL → RLS against a throw-away PostgreSQL. No mocks. Port: `NIGAFIY_TEST_PG_PORT` (default 5439) |
| `pnpm test:collector` | Sensor unit and lifecycle tests (enrollment, outage buffering, reconnect, scope limits) |
| `pnpm test:agent` | Endpoint agent tests |
| `pnpm test:engine` | Engine tests |
| `pnpm --filter @nigafiy/web test:unit` | Web unit tests (subnet calculator, ADPCM, SHA-256, user guide parity) |
| `pnpm --filter @nigafiy/brand test` | Brand asset tests |
| `pnpm --filter @nigafiy/desktop test` | Desktop app tests |
| `pnpm test:web` | Playwright browser walk (production build, throw-away PostgreSQL on `E2E_PG_PORT`, default 5446, real API) in English and Arabic (RTL); uses the installed Edge (`E2E_BROWSER_CHANNEL` to change) |
| `node scripts/e2e-smoke.mjs` | End to end against a running stack with the **real Sensor binary**, using the loopback range `127.0.0.0/29` as a permitted test network (requires `ALLOW_LOOPBACK_SCOPES=true` in `.env`) |

`node scripts/seed-simulated.mjs` fills a clearly labelled *simulated* organization
("SIMULATED demo (not real data)") for looking at the UI only. It is a development script, not part of
the product.

The API suite skips the pg_dump/pg_restore tests when the PostgreSQL client tools are not installed, the
real-Redis test when no Redis answers, and the real-agent tests until `pnpm build:agent` has run.
