# Naming: LAN Detective → Nigafiy

Milestone 2 renamed the product. Everything a person sees says **Nigafiy**; every identifier that is
persisted or on the wire keeps working. This table is the reference for each identifier: renamed,
renamed with a fallback, or kept, and why. Milestone 5 (one installer per program, migration of
the old installation, spec §6.5) uses the "Milestone 5" column.

The brand name is written in Latin letters, "Nigafiy", in Arabic text too. Logo: option D from
`@nigafiy/brand` (mark and wordmark only, no mascot or character).

`pnpm check:brand` (`scripts/check-brand.mjs`) fails when "LAN Detective" or `lan-detective`
appears outside the allow-list below.

## Kept exactly as they are (persisted or on the wire)

| Identifier | Value | Why | Milestone 5 |
| --- | --- | --- | --- |
| Token prefixes | `lde_` (collector enrollment), `ldc_` (collector credential), `ldea_` (agent enrollment), `lda_` (agent credential) | Stored on every enrolled Sensor and Agent and as hashes in the database; changing them would log every device out | Keep |
| Session cookie | `ld_session` | Browsers stay signed in across the update (`auth-and-tenancy.test.ts` unchanged) | Keep |
| CSRF header | `X-LD-CSRF` | Sent by every open web page | Keep |
| Database role / name | `lan_app` / `lan_detective` (tests: `lan_detective_test`) | Existing databases, `.env` files and backups use them; `db:restore --confirm lan_detective` | Optional rename with a migration of `.env` and the role |
| PostgreSQL channels | `ld_command_done`, `ld_agent_wake` | Internal, in applied migrations (never edited) | Keep |
| Collector and agent HTTP paths | `/v1/collectors/*`, `/v1/agent/*` … | Enrolled devices call them | Keep |
| Sensor state files | `state/*.json`, `collector.yaml`, the desktop's `<profile>\collector` folder | Hold the Sensor's identity and credential | Keep |
| Electron session partition | `persist:dashboard` | Holds the desktop app's signed-in session | Keep |
| Browser preferences | cookie `ld_locale`; `localStorage` keys `ld_theme`, `ld_site`, `ld_sidebar` | Hold each person's language, theme, selected site and sidebar state; a rename would reset them | Keep |
| Router rule label | `LAN Detective: <description>` (`router.ProductRulePrefix`, `PORT_FORWARD_PREFIX`) | Written on customers' routers; the Sensor recognises its own port forwards by it. A new label would turn existing rules into "administrator" rules | Decide with a dual-prefix read, then rename |
| Router tags | `lan-detective:block:`, `lan-detective:limit:`, `lan-detective:schedule:` (MikroTik comments, OpenWrt names, pfSense alias details); alias `lan_detective_blocked` (pfSense, OPNsense) | Same: persisted on routers and used to find the product's own rules | Same as above |
| Ownership value | `owner: "lan-detective"` in the collector protocol and the API (`routers.*.lan-detective` string keys follow it) | Wire value between Sensor and API; old Sensors keep sending it | Keep (internal) |
| Webhook signature header | `X-LAN-Detective-Signature` | Customers' webhook receivers verify it | Send `X-Nigafiy-Signature` as well, then retire the old one after notice |
| Windows service of the Agent | `NigafiyEndpointAgent` (Linux `nigafiy-endpoint-agent`, macOS `com.nigafiy.endpoint-agent`) | Already Nigafiy; installed on endpoints, so not renamed again (the Agent's own name, "nigafiy-agent", is only the binary) | Keep |
| Agent state and settings | `%ProgramData%\Nigafiy\EndpointAgent`, `HKLM\Software\Nigafiy\EndpointAgent`, install folder `%ProgramFiles%\Nigafiy\Endpoint Agent` | Hold the endpoint credential | Keep |
| Docker volume / systemd paths | `/var/lib/lan-collector`, `/etc/lan-collector/`, unit `lan-collector.service`, user `lan-collector` | Existing Linux Sensors keep their state; only the binary inside changes (now `nigafiy-engine sensor`; `deploy/upgrade-to-engine.sh` links the old `/usr/local/bin/nigafiy-sensor` to it, docs/architecture/engine-sensor.md) | Rename with a move script |
| Folders in the repository | `collectors/lan-collector`, `agents/endpoint-agent` | Moving them churns every path and doc for no gain | Keep |
| SQL migrations | comments mention LAN Detective | Applied migrations are never edited | Keep |

## Renamed with a fallback (new name wins, the old one still works)

| Old | New | Fallback | Milestone 5 |
| --- | --- | --- | --- |
| `LD_DATA_DIR`, `LD_BUNDLE_DIR`, `LD_PG_DIR`, `LD_PG_BIN_DIR`, `LD_SETUP_EMAIL`, `LD_SETUP_PASSWORD`, `LD_DESKTOP_NO_ENGINE`, `LD_DESKTOP_AUTO_CONSENT`, `LD_TEST_PG_PORT`, `LD_TEST_REDIS_URL`, `LD_TEST_AGENT_LOGS`, `LD_LIVE_COMPLIANCE`, `LD_LIVE_UPDATES` | `NIGAFIY_*` with the same suffix | `readEnv` (`apps/api/src/config/env-compat.ts`, `LEGACY_ENV`), copies in `scripts/local.mjs` and `apps/desktop/src/env-compat.cjs`, `envCompat` in the engine, `config.Getenv` in the Agent: the old name is read and logs one deprecation line | Remove the fallback after one release |
| `LAN_COLLECTOR_*` (`CONFIG`, `SERVER_URL`, `ENROLLMENT_TOKEN`, `DNS_LISTEN`, `MNDP_LISTEN`, `STATE_DIR`, `TLS_PIN_SHA256`) | `NIGAFIY_SENSOR_*` | `config.Getenv` in the Sensor (`TestLoadReadsLegacyCollectorEnv`) | Keep the fallback (systemd units and Docker run lines in the field) |
| `LAN_ENDPOINT_*` (`SERVER_URL`, `ENROLLMENT_TOKEN`, `STATE_DIR`, `CA_FILE`, `TLS_PIN_SHA256`, `LOG_LEVEL`, `ALLOW_INSECURE_HTTP`) | `NIGAFIY_AGENT_*` | `config.Getenv` in the Agent | Keep the fallback |
| Desktop profile `%APPDATA%\LAN Detective` | `%APPDATA%\Nigafiy` | `resolveDataDir` (`apps/desktop/src/data-dir.cjs`): the legacy folder is used while it exists and the new one does not; an explicit `--user-data-dir` wins. The engine's default data folder follows the same rule (`ProfileDir`). From a source checkout: `@lan-detective/desktop` → `@nigafiy/desktop` under `%APPDATA%` | Move the folder, then drop the fallback |
| Desktop executable `LAN Detective.exe` | `Nigafiy.exe` (from `productName`) | The update helper (`update.RestartTarget`) restarts `Nigafiy.exe` when the old exe is gone after the update | — |
| Agent binary `endpoint-agent.exe` | `nigafiy-agent.exe` | The Agent installer removes the old service with the old binary on upgrade and deletes it after a successful install | — |
| Auto-start launcher `LAN Detective.vbs` (`pnpm local:autostart`) | `Nigafiy.vbs` | The old one is deleted whenever the launcher is (re)installed or removed | — |

## Desktop installer identity

| Identifier | Value | Decision |
| --- | --- | --- |
| `appId` | `com.landetective.desktop` → `com.nigafiy.hub` | Renamed (also `app.setAppUserModelId`). It names the taskbar group and Start-menu shortcuts. |
| NSIS GUID | pinned to `664f0038-fee2-574d-ae14-23d8a9c943e5` (electron-builder's UUID v5 of the old appId) | **Kept.** electron-builder derives the uninstall key and install-location key from it. Without the pin, an update (by hand or by the update helper, which runs the installer silently with `/D=<install dir>`) would leave a second "LAN Detective" entry in Apps & features over the same files. With it, the installer finds the old install, runs its uninstaller with app data kept, and installs Nigafiy in the same folder. Pinned by `apps/desktop/test/installer-identity.test.cjs`. |
| `productName` | `LAN Detective` → `Nigafiy` | Renamed: window titles, shortcuts, exe name. An existing install keeps its folder name (for example `…\Programs\LAN Detective`) until Milestone 5. |
| MSI `upgradeCode` | `6DA7D862-27E7-4AC8-809D-89B4128FB3AE` | **Never changes** (tested). |

Not verified on a real machine: an NSIS upgrade from an installed LAN Detective build to a
Nigafiy build (the owner's installation is never touched). Check on a test machine: install an
old build, put data in, run the new installer, then Apps & features shows one entry, the data is
there, and `%APPDATA%\LAN Detective` is still the profile in use.

## Renamed outright (nothing persisted depends on them)

| Old | New |
| --- | --- |
| npm scope `@lan-detective/*`, root package `lan-detective` | `@nigafiy/*`, `nigafiy` |
| Go modules `github.com/lan-detective/lan-collector`, `github.com/lan-detective/endpoint-agent` | `github.com/nigafiy/sensor`, `github.com/nigafiy/agent` (engine already `github.com/nigafiy/engine`) |
| `cmd/lan-collector`, `cmd/endpoint-agent` | `cmd/nigafiy-sensor` (now a development-only build; the shipped Sensor is `nigafiy-engine sensor`), `cmd/nigafiy-agent` |
| Binaries `lan-collector(.exe)`, `endpoint-agent(.exe)` | `nigafiy-sensor(.exe)` → since 2026-11-25 the single `nigafiy-engine(.exe)`, run as `nigafiy-engine sensor` (desktop resource `engine\nigafiy-engine.exe`; the names `nigafiy-sensor` and `lan-collector` still run the Sensor when a link or copy of the executable has them, docs/architecture/engine-sensor.md); `nigafiy-agent(.exe)` |
| `--version` output | `nigafiy-sensor <v>` (`nigafiy-engine sensor -version`), `nigafiy-agent <v>` |
| User-Agents `lan-collector/<v>`, `lan-endpoint-agent/<v>`, `LAN-Detective-Webhook/1`, banner probe, SSH client string | `nigafiy-sensor/<v>`, `nigafiy-agent/<v>`, `Nigafiy-Webhook/1`, `nigafiy-sensor banner probe`, `SSH-2.0-Nigafiy_ConfigBackup` |
| Log `service` fields | `nigafiy-api`, `nigafiy-sensor`, `nigafiy-agent` |
| `Start LAN Detective.cmd` | `Start Nigafiy.cmd` |
| Product name in UI (EN and AR), page titles, emails, notices, desktop windows, tray, panel, installer names, docs | Nigafiy. The remote-desktop and managed-endpoint notices keep their wording apart from the name. |
| Web favicon / logo | Hub icon (`apps/web/app/icon.svg`), mark and outlined wordmark from `@nigafiy/brand` |
| Docker image / container in the Sensor install snippet | `nigafiy/sensor`, `nigafiy-sensor` (the volume keeps its name, above) |

## Allow-list of `pnpm check:brand`

Whole files: `docs/superpowers/**` and `docs/roadmap/status.md` (history), this file, the check and
its test, and the compatibility code that names the legacy values (`env-compat.ts`,
`data-dir.cjs` and its test, `installer-identity.test.cjs`, the engine's `compat.go`,
`engine_test.go`, `update.go`, `update_test.go`), and the import of an install from before the
rename (`apps/desktop/installer/nigafiy.nsh`, `legacy-import.cjs` and its test,
`docs/operations/installers.md`, the owner's `docs/operations/real-hardware-checklist.md`), which must name the old folders, uninstaller and profile. Lines: the kept identifiers in the first table
(router label and tags, the ownership value and its string keys, the webhook header, the old
auto-start launcher name) and comments in SQL migrations.
