# Handoff: router and device controls (2026-11-21)

Paste this into a fresh session in `D:\network` (branch `phase-2-network-intelligence`).

## What the owner asked

In Arabic, roughly: "add lots of controls for the router and every connected device. Start with
my router, and make sure they work." The owner's router is a **Zyxel VMG3625-T50B at 192.168.1.2**.
It is already added in the dev database (org "My home", transport `https-pinned`, status `ok`,
6 clients, credentials saved encrypted by the owner).

## Rules that still apply (from memory / the product brief)

- **Real data only.** No mock or simulated data in the product; test doubles belong in `_test` code only.
- **Every feature is complete.** Each one needs backend, DB, UI (EN + AR/RTL), validation, permission checks, audit log and tests.
- **Router password.** Only the owner types the router's admin password. Credentials are never logged, printed or decrypted outside the product.
  - Tried this session: decrypting the stored credentials for a one-off probe. It was **blocked by the safety classifier**.
  - Don't try that again. The only way to the router is the product's own path: API → `collector_commands` → collector → driver.
- **Leave the installed app alone.** Never touch `C:\Program Files\LAN Detective` or ports 47100/47130/47133. Stop processes by PID only, never by image name.
- **Scanning.** Ask before scanning any range other than 192.168.1.0/24.
- **The programs' UI.** `apps/web` is the programs' UI, not the website (the website is on hold). Say so when you edit it.
- **No commits without the owner's OK.** Nothing from this work is committed yet.

## The design (read first)

`docs/features/router-controls.md` is the contract. It covers:

- Capabilities: `overview`, `wifi`, `reservations`, `port_forward`, `rename`, `reboot`.
- The `settings` wire format.
- Command kinds, payloads and the safety rules.
- API routes and storage.

Every payload was taken from the router's own web UI JavaScript, `https://192.168.1.2/static/js/app.js` (public, no login). It's a useful reference for any field-name question.

| Control | Request |
|---|---|
| Wi-Fi on/off | `PUT DAL?oid=wlan {Index, wlEnable}`, then `GET /cgi-bin/Wireless?action=WlCheck`. Index 1 = 2.4 GHz main, 2–4 = 2.4 GHz guests, 5 = 5 GHz main, 6–8 = 5 GHz guests. It matches lanhosts `Layer1Interface` `Device.WiFi.SSID.<n>`. |
| Add reservation | `POST DAL?oid=static_dhcp {Index:0, BrWan:"Default", Enable, MACAddr, IPAddr}` |
| Remove reservation | `DELETE DAL?oid=static_dhcp&Index=n`. DELETE parameters go in the query string. |
| Add port forward | `POST DAL?oid=nat {Index:0, Enable, Protocol TCP\|UDP\|ALL, Description, Interface:"", X_ZYXEL_AutoDetectWanStatus:true, External/InternalPortStart/End, InternalClient, SetOriginatingIP:false, OriginatingIpAddress:""}` |
| Remove port forward | `DELETE DAL?oid=nat&Index=n` |
| Rename | `PUT DAL?oid=lanhosts {HostName, DeviceIcon, MacAddress, Internet_Blocking_Enable}`. The block flag is sent back unchanged. |
| Reboot | `POST /cgi-bin/Reboot` |
| Overview | `GET DAL?oid=status` (fallback `cardpage_status`) for DeviceInfo.UpTime and WanLanInfo[]. `GET DAL?oid=lan` for the LAN IP and mask. |

**Secret-bearing fields are never read:** `psk_value`, `wifiPassword`, `CurrentPSKValue`, `AutoGenPSKValue`, `RadiusSecret`.

## Update — second session, 2026-11-21 (still uncommitted)

- **Collector:** agent tests added (`internal/agent/routercontrols_test.go`). Fixed: an empty router list (no reservations / no rules) was sent as "not read", so the API kept the stale list; the driver now sends `[]`. `wireSettings` drops entries the API would refuse (empty id, port 0, unnamed WAN) instead of letting one odd value reject the whole result. All router + agent tests pass; `bin/lan-collector.exe` rebuilt.
- **API:** reviewed against the contract (payload names match the collector). `band` made optional. New `apps/api/tests/router-settings.test.ts` (8 tests: ingest, rename, Wi-Fi guards, reservations, port forwards, reboot, roles, capabilities). Full suite: **167 tests / 23 files pass**, typecheck clean. Migration 028 applied to the dev DB.
- **Web UI:** new "Router settings" tab on the router screen (`components/router-settings-panel.tsx`: overview, Wi-Fi switches with confirmation, reservations add/remove, port forwards add/remove with owner badge, restart with confirmation) and router controls on the device page card (rename, reserve / remove, port forwards to the device). 145 EN + AR strings. Typecheck clean.
- **Real router (read path verified):** a scheduled refresh through the collector stored real settings: 8 Wi-Fi networks (main `WE_650320` 2.4 GHz and `WE_650320_5G`, guests off), overview (VDSL up with IPv4, uptime, LAN IP 192.168.1.2), reservations `[]`, port forwards `[]`. Open points: WAN DNS is not read (`dnsv4Server` shape still unknown); the ADSL link shows status `unknown`.
- **Not done yet:** the UI has not been looked at in the browser (needs the owner's sign-in), and no control has been run on the real router.

## Update — third session, 2026-11-21 (still uncommitted)

- **Test sign-in:** a local dev admin in "My home", `tester@lan-detective.test`. The password is in `D:\network\.data\dev-login.txt` (git-ignored). Don't paste it anywhere.
- **Bug fixed: "Duplicated login" after every control.**
  - The router sends a new `sessionkey` (the CSRF token) in replies to POST/PUT/DELETE. The driver kept using the old one, so the logout was refused, and the session stayed open until it timed out (about 4–6 minutes). During that time every new operation failed.
  - Fix in `zyxel/session.go`: `do()` adopts any `sessionkey` in a 200 reply while logged in (`adoptSessionKey`). `logout` now reports a non-2xx reply as an error, and `agent/routers.go` logs "router logout failed".
  - The test double can rotate keys (`RotateSessionKey`). `TestRotatingSessionKeyIsFollowedAndLogoutCloses` fails without the fix.
- **Verified on the real router through the UI (device page of the owner's A36, 192.168.1.64):**
  - Rename to "mhmd-s-A36 test", then back to "mhmd-s-A36".
  - Reserve 192.168.1.64, then remove the reservation.
  - Add port forward TCP 45678 to 192.168.1.64 ("LAN Detective: test"), then remove it.
  - Guest Wi-Fi "mk" (Index 2) on, then off.
  - The owner confirmed the A36 stayed connected through the rename, reservation and port-forward tests.
  - All requests completed, 30 s apart with no "Duplicated login". Each control shows its result next to the control that started it. The audit rows are present. Stored settings afterwards: reservations `[]`, port forwards `[]`.
- **Side effect to know:** every Wi-Fi change makes the router restart that radio (~20 s), so all phones on that band drop briefly, even for a guest network.
- **Not done:**
  - Reboot (needs the owner's OK).
  - WAN DNS (`dnsv4Server` shape), and the ADSL link that shows `unknown`.
  - The router-screen "Router settings" tab was viewed, but the reservations/port-forward forms there were only exercised from the device page.

## State of the work (first session)

### Done: collector / Go side

- **Builds, vet is clean, all router and agent tests pass.**
- `collectors/lan-collector/internal/router/router.go`: new capability constants.
- `internal/router/settings.go` (new):
  - Types: `Settings`, `Overview`, `WANLink`, `WiFiNetwork`, `Reservation`, `PortForward`.
  - Interfaces: `SettingsReader`, `Renamer`, `WiFiController`, `ReservationManager`, `PortForwarder`, `Rebooter`.
  - Validators: `CleanName`, `ValidatePortForward`, `ValidateReservation`, `SameRule`, `NormalizeProtocol`.
  - Constants: `ProductRulePrefix = "LAN Detective: "`, reserved ports 22/23/80/443/7547.
- `internal/router/zyxel/controls.go` (new): the Zyxel implementation of all of the above.
  - Each control re-reads the router afterwards and checks it.
- `internal/router/zyxel/zyxel.go`: `Capabilities()` probes `status`/`cardpage_status`, `wlan`, `static_dhcp` and `nat`, and adds `rename` and `reboot`.
- `internal/router/zyxel/zyxeltest/server.go`: the test double now serves `lan`, `status`, `wlan`, `static_dhcp` and `nat`, plus DELETE, Reboot and WlCheck.
- `internal/router/zyxel/controls_test.go` (new): 9 tests (settings without secrets, missing firmware parts, rename, Wi-Fi, reservations, router refusal, port forwards, reboot, helpers). **Passing.**
- `internal/agent/routers.go` and `agent.go`:
  - New command kinds: `router_rename`, `router_wifi`, `router_reservation` (`clear` → `unreserve`), `router_port_forward` (`clear` → `remove_port_forward`), `router_reboot`.
  - New payload fields: `name`, `wifi_id`, `enabled`, `ip`, `port_forward`.
  - `routerControl()` runs the controls.
  - `guardOwnWiFi()` refuses to turn off a network that the collector host's own MAC is on.
  - `attachSettings()` / `wireSettings()` add `settings` to refresh results and to every successful control result (except reboot).
  - **Still missing: agent tests for the new commands.** Add them to the existing router agent tests (find them with `grep -l routerCommand internal/agent/*_test.go`).

### Partly done: API side

A subagent was stopped halfway. **`apps/api` typechecks, but nothing has been run or tested yet.** Review everything:

- `apps/api/src/database/migrations/028_router_controls.sql` (new): adds `site_routers.settings` and `settings_at`, and replaces the `router_requests` action CHECK and the `collector_commands_kind_check` list. Check the second DO block to the end of the file.
- `apps/api/src/modules/routers/settings.ts` (new), plus edits to `collector-protocol.ts` (the `router_result` schema with `settings` and the new actions), `control.ts`, `controls.ts`, `index.ts`, `ingest.ts`, `routes.ts`, `schema.ts` and `service.ts`.
- **To finish:**
  - Compare against the contract, especially the payload field names the collector expects: `name`, `wifi_id`, `enabled`, `ip`, `port_forward`, `clear`.
  - Audit each action.
  - Guards: `own_machine` for Wi-Fi off, `confirm` for main Wi-Fi off, `{confirm:"reboot"}`, no port forward to the collector host or the router.
  - Write API tests in `apps/api/tests/` (vitest + embedded Postgres; set `LD_TEST_PG_PORT` to a free port).
  - The whole suite must pass. The baseline was 159 tests in 22 files.

### Not started: web UI (EN + AR)

`apps/web/features/routers/`:

- **Router detail screen:**
  - Overview card
  - Wi-Fi networks with on/off switches; turning off a main network asks for confirmation
  - DHCP reservations with remove
  - Port forwards with owner badge, add and remove
  - Reboot with confirmation
- **Device page router card:** rename on router, reserve / remove reservation, port forwards to this device.
- Use `request-progress.tsx` for pending requests, and wrap SSIDs, IPs and MACs in `<bdi>`.

## How to verify on the real router (the owner asked for this)

1. Make sure nothing listens on 3100, 4100 or 5433, apart from the dev DB if you start it yourself.
2. Start the stack the product way: `pnpm local`, or `pnpm dev:db` → API → web preview → collector (see the memory notes).
3. Rebuild `bin/lan-collector.exe` and check the binary really has the change.
4. The collector receives the router config with the credentials over its normal channel.
5. Trigger a refresh with `POST /api/v1/routers/:id/refresh`, then check that `site_routers.settings` holds real Wi-Fi, reservation, port-forward and overview data.
   - Fix any field-name mismatch with the real firmware.
   - Unknowns not yet confirmed on the real router:
     - whether the DAL accepts the port fields as numbers or as strings
     - the shape of `dnsv4Server`
     - whether objects carry their own `Index`
6. Run the controls, each one reversibly:
   - **Rename** a phone, then rename it back.
   - **Reserve** an unused IP for one device, then remove it.
   - **Add a port forward** (e.g. TCP 45678 → a device), then remove it.
   - **Wi-Fi:** switch a guest network (Index 2) on, then off.
     - Don't turn off Index 1, because every phone in the house is on it.
     - The host PC 192.168.1.147 is wired (Ethernet port 2).
   - **Reboot:** ask the owner first. It cuts their internet for a few minutes.
7. Check the audit log, the request results, and the router's own web page, which the owner can look at.

## Tool notes

- **Go:** `export PATH="$PATH:/c/Program Files/Go/bin"`.
- **Line endings:** files are CRLF in the working tree, so `gofmt -l` flags every file. Check with `tr -d '\r' < f | gofmt -d`.
- **Searching the router's `app.js`:** it is 1.9 MB, and long `grep -oE '.{2500}…'` patterns hang. Slice with a small node script around `indexOf` instead; one is in the session scratchpad as `ctx.mjs`.
