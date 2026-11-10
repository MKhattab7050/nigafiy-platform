# LAN Detective desktop app

`apps/desktop` — a Windows desktop program (Electron) that combines:

1. **The dashboard** — the same LAN Detective web app, in its own window, loaded from your server.
2. **A bundled collector** — the Go `lan-collector` program ships inside the installer. The app
   enrolls it, starts/stops it, shows its status and activity, and keeps it running from the
   system tray while the windows are closed.

It does **not** contain the server (API + database). The desktop app is a client of a LAN Detective
server, plus a collector for the network the computer is connected to.

## Using it

1. First start: the **Collector** panel opens. Enter the server address and save.
   (`https://…`; plain `http://` is accepted only for `localhost`, for development.)
2. **Open dashboard**, sign in, go to *Discovery & Collectors*, authorize your network range and
   add a collector. Copy the one-time enrollment token.
3. Back in the Collector panel: paste the token → **Enroll and start**.
4. Closing the windows leaves LAN Detective in the tray; the collector keeps monitoring.
   Tray menu → *Quit LAN Detective* stops everything.

Optional: *Networks this computer may probe* is a local allow-list — the collector refuses any
range outside it, whatever the server sends.

## Where things are stored

`%APPDATA%\LAN Detective\collector\` — `settings.json`, the generated `collector.yaml`, and
`state\` (collector identity, cached configuration, offline buffer). The enrollment token is passed
to the collector through its environment once and is never written to disk or shown in the log.

## Security design

| Concern | Handling |
| --- | --- |
| Dashboard is remote content | Sandboxed window, context isolation, no Node integration, **no preload** — it cannot reach the collector or the file system |
| Navigation | The dashboard window stays on the configured server origin; other links open in the default browser (https only) |
| Collector controls | Exposed only to the local panel page through a narrow IPC API; the main process checks the sender is that page |
| Panel page | Local file with a strict Content-Security-Policy (no network, no inline script) |
| Secrets in logs | Tokens and credentials are redacted before a log line is stored or displayed |
| Settings | Validated in the app **and** by the collector's own `-check-config` before being saved |

## Development

```bash
pnpm --filter @lan-detective/desktop test
```

Runs the real collector binary through the manager against a stand-in server (needs `pnpm build:collector` first).

```bash
pnpm --filter @lan-detective/desktop start
```

Starts the app from source, using `collectors/lan-collector/bin/lan-collector.exe`.

```bash
pnpm --filter @lan-detective/desktop dist
```

Builds the Windows installer into `apps/desktop/release/`.

## Limitations

- Windows build only so far (the code is cross-platform, macOS/Linux packaging is not configured).
- Stopping the collector on Windows terminates the process directly; at most a few seconds of
  unsent samples are lost (everything older is already in the on-disk buffer).
- The installer is not code-signed, so Windows SmartScreen will warn on first run.
- No auto-update.
- The collector runs only while the desktop app is running (as the signed-in user). For an
  always-on site, install the collector as a service on a server instead.
