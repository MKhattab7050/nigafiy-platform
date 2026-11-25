# Nigafiy desktop app

`apps/desktop` — a Windows desktop program (Electron) that combines:

1. **The dashboard** — the Nigafiy web app in its own sandboxed window.
2. **A bundled collector** — the Go `lan-collector` program ships inside the installer. The app
   enrolls it, starts/stops it, shows its status and activity, and keeps it running from the
   system tray while the windows are closed.
3. **A bundled local backend** (`apps/desktop/scripts/bundle-backend.mjs`) — embedded PostgreSQL,
   the API server, and the standalone Next.js web server so the installed app can run completely
   self-contained on one computer without an external server.

## Two operating modes

### 1. Self-contained local mode (default)

When no remote server (`https://…`) is configured, opening the desktop app runs the entire
Nigafiy stack locally on `127.0.0.1` (`src/local-stack.cjs` → `scripts/local.mjs`):

1. Starts the bundled PostgreSQL database, API (running all migrations), and web server on loopback ports.
2. Creates (on first run) or signs in to a local owner account whose random password is encrypted
   with the OS keychain (Windows DPAPI via `safeStorage`) in `local-account.bin`, and sets the
   dashboard session cookie automatically.
3. Detects the computer's default-route private IPv4 subnet and asks once for confirmation to scan it.
4. Authorizes the subnet, enrolls the bundled `lan-collector`, starts discovery, and loads the live dashboard.
5. Choosing *Quit Nigafiy* from the tray (or closing during Windows shutdown) cleanly stops the
   collector and the local database/API/web process tree.

### Through the Nigafiy engine (Milestone 3)

When `nigafiy-engine.exe` is present (`engine/bin/` in a checkout, `resources/engine/` when installed),
local mode goes through it instead of starting `local.mjs` itself (`src/engine-stack.cjs`):

- An engine already answers on `127.0.0.1:47140` (the `NigafiyEngine` Windows service, or one still
  running): the app uses its stack and leaves it running when the app quits.
- None answers: the app starts `nigafiy-engine run --no-sensor` as a child, waits until `/v1/status`
  reports the stack's web and API addresses, and shuts it down through `POST /v1/shutdown` (with the
  token in `<data>/engine/control-token`) on Quit. The app keeps running the Sensor itself, as before.
- `NIGAFIY_DESKTOP_NO_ENGINE=1` forces the old direct launcher. See `docs/desktop/engine.md`.

The Hub home (the dashboard) shows each program with an Open link, the engine's health and the
update check (`GET /api/v1/platform/{programs,engine,updates}`).

### 2. Remote-server collector mode

To connect this computer's collector and dashboard to a shared Nigafiy server instead:

1. Open **Collector on this computer…** from the tray menu (or on first start when no local bundle is used).
2. Enter the server address (`https://…`; plain `http://` is accepted only for `localhost`) and save.
3. Click **Open dashboard**, sign in, go to *Discovery & Collectors*, authorize your network range,
   and add a collector to copy its one-time enrollment token.
4. Back in the Collector panel: paste the token → **Enroll and start**.
5. Closing the windows leaves Nigafiy in the tray while the collector keeps monitoring.

Optional: *Networks this computer may probe* is a local allow-list — the collector refuses any
range outside it, whatever the server sends.

## Where things are stored

- `%APPDATA%\Nigafiy\collector\` (or `.data\collector\` in a source checkout) — `settings.json`,
  the generated `collector.yaml`, and `state\` (collector identity, cached configuration, learned DHCP
  names, offline spool). The enrollment token is passed to the collector through its environment once
  and is never written to disk or shown in the log.
- `%APPDATA%\Nigafiy\local-account.bin` — OS-encrypted local owner credentials for self-contained mode.
- `%APPDATA%\Nigafiy\data\` (or `.data\` in a source checkout) — local PostgreSQL data directory
  (`pg\`), generated `.env`, and service logs (`logs\`).

## Security design

| Concern | Handling |
| --- | --- |
| Dashboard is remote/web content | Sandboxed window, context isolation, no Node integration, **no preload** — it cannot reach the collector or the file system |
| Navigation | The dashboard window stays on the configured server origin; other links open in the default browser (`https://` only, malformed URLs rejected) |
| Collector controls | Exposed only to the local panel page through a narrow IPC API; the main process checks the sender is that page |
| Panel page | Local file with a strict Content-Security-Policy (no network, no inline script) |
| Secrets in logs | Collector and agent tokens/credentials (`ldc_`, `lde_`, `ldea_`, `lda_`) are redacted before a log line is stored or displayed |
| Server switching | Changing the server URL automatically resets the stored collector identity so credentials are never sent to a different server |
| Settings | Validated in the app **and** by the collector's own `-check-config` (using an isolated per-check temp file) before being saved |

## Development

```bash
pnpm --filter @nigafiy/desktop test
```

Runs the unit and integration tests (including driving the real collector binary against a stand-in server).

```bash
pnpm --filter @nigafiy/desktop start
```

Starts the app from source, using `engine/bin/nigafiy-engine.exe` (`pnpm build:engine`) for the
engine and, as `nigafiy-engine sensor`, for the Sensor.

```bash
pnpm --filter @nigafiy/desktop dist
```

Bundles the backend (`scripts/bundle-backend.mjs`) and builds the Windows installer into `apps/desktop/release/`.

## Limitations

- Windows build only so far (the code is cross-platform, macOS/Linux packaging is not configured).
- Stopping the collector on Windows terminates the process directly; at most a few seconds of
  unsent samples are lost (everything older is already in the on-disk buffer).
- The installer is not code-signed, so Windows SmartScreen will warn on first run.
- No auto-update.
- The collector runs only while the desktop app is running (as the signed-in user). For an
  always-on site, install the collector as a service on a server instead.
