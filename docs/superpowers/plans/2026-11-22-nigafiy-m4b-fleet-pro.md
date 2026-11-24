# Milestone 4b: Fleet Pro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every item in `docs/features/fleet-pro.md` works for real in Nigafiy Fleet: AnyDesk / TeamViewer / RustDesk-class live sessions plus RMM tools, with transparency that no policy can switch off.

**Scope source:** `docs/features/fleet-pro.md` (the feature list is the acceptance list; nothing in it may be dropped or simplified). Mockups (approved 2026-11-21): `docs/design/mockups/Fleet.dc.html`, `FleetHome`, `FleetSession`, `FleetTools`, `FleetPolicy`, `FleetUser`. Master plan Part C rows "Fleet streaming", "Fleet Quick Support", "Fleet transparency".

**Starts after:** Milestone 4 (programs: `/fleet/...` namespace, shared device card) and Track B2 (transient remote-desktop frames, better downscaling). Both are uncommitted as of 2026-11-22; check `git status` and `docs/roadmap/status.md` first.

## What exists (do not redo)

- Agent (`agents/endpoint-agent`, Go 1.27.3, no third-party modules yet) talks to the API by HTTPS polling (`/api/v1/agent/poll`, ~600 ms) and posts command results. API wakes waiters across instances with `LISTEN/NOTIFY` (`infrastructure/pg-listen.ts`).
- Remote desktop JPEG path (`internal/remotedesktop`, `modules/endpoints/remote-desktop`), file manager, processes / services / software / logs / power / notify / allow-listed diagnostics (`internal/control`), enrollment, groups, policy, compliance, operator MFA.
- Engine (`engine/`, `nigafiy-engine.exe`) supervises PG, API, web and Sensor; it is where the TURN relay and recordings store live.

## Global constraints (in addition to the master plan's)

- **Transparency cannot be disabled by any policy, flag or role:** session bar (operator, reason, live permissions, End), privacy-screen text (never plain black), recording mark, audit, the user's "IT activity" list, Ctrl+Alt+Shift+E to end. A test pins each of these.
- No keylogging, credential capture, stealth install or covert interception. Typed text and file contents never reach the audit log (names, sizes, SHA-256 only).
- Measured numbers only (fps, RTT, bandwidth, route, codec come from WebRTC stats / the encoder, never estimated).
- The JPEG path stays as the fallback and is selected automatically when WebRTC cannot connect; the UI says which path is in use and why.
- Every feature: migration, API with validation + RBAC + audit, agent side with Go tests, Fleet UI (EN + AR, RTL), feature doc in `docs/features/`, prerequisites documented. Viewer role sees no write buttons.
- Toolchain: check whether a C compiler is available before choosing a cgo dependency. Prefer pure Go + Windows APIs through `golang.org/x/sys/windows` / COM syscalls (Media Foundation, DXGI, WASAPI). New Go modules (e.g. `github.com/pion/webrtc/v4`, `github.com/pion/turn/v4`) are allowed; pin versions and record them.
- Migrations: next free number at start (`030` notification channels and `031` transient remote-desktop frames are taken). Each builder takes its own numbers as listed below and renumbers only if taken.
- Never touch the owner's installed LAN Detective (ports 47100/47130/47133), never stop processes by image name, never scan networks, never commit. Each builder uses its own `LD_TEST_PG_PORT` (5450+).
- Real-machine checks run on this Windows PC only through test binaries and a scratch data folder; the secure-desktop / Winlogon helper needs a service running as LocalSystem, which needs the owner's OK before it is installed here.

## Waves

Wave 1 is the foundation every later task needs, so it runs alone. Wave 2 tasks are independent of each other (different packages, different migrations) and run in parallel. Wave 3 closes the milestone.

### Wave 1 — Session foundation (one builder)

**Task 1: Session model, permission profiles, access policy** (migration `032`)
- [x] `fleet_permission_profiles` (built-ins View only / Support / Full admin + custom; flags: view, control, clipboard_in, clipboard_out, files, audio, record, restart, privacy_screen, block_input, shell).
- [x] Group access policy: attended (accept + timeout) / unattended, "user may refuse within N s", allowed hours, operator roles, MFA-to-connect, second-admin approval for unattended, operator IP allow-list.
- [ ] `fleet_sessions` (+ participants for multi-operator, permissions granted, path used, end reason) and the audit events. Existing remote-desktop session rows migrate into it.
- [x] API: request → policy evaluation → (approval) → user accept → live; End from either side. Tests for every policy branch.

**Task 2: Live control channel**
- [ ] Agent ↔ API WebSocket (agent dials out, same auth as polling, falls back to polling) carrying session signalling and small messages; multi-instance through `LISTEN/NOTIFY`.
- [ ] Agent service + per-session helper: the service launches a helper into the active console session (`WTSGetActiveConsoleSessionId`, `WTSQueryUserToken`, `CreateProcessAsUser`) and onto the Winlogon desktop for UAC / lock / sign-in screens; session switching; "nobody signed in". Helper ↔ service over a named pipe with an ACL.
- [ ] Session bar in the helper (always on top, operator, reason, live permissions, End) and Ctrl+Alt+Shift+E. Tests: the bar cannot be suppressed by any profile or policy value.

### Wave 2 — Parallel (one builder each)

**Task 3: Streaming** — DXGI Desktop Duplication capture, H.264 through Media Foundation (hardware MFT when present, software otherwise), up to 60 fps / 4K, adaptive bitrate; `pion/webrtc` in the agent; TURN relay (`pion/turn`) inside the engine with per-session credentials; Fleet viewer in Chromium; measured stats; quality modes, colour depth, remote cursor; monitor pick / all side by side / one window each; automatic fallback to JPEG.

**Task 4: Input and in-session tools** — view only / control / block local input; Secure Attention Sequence (`SendSAS`, needs the policy registry value documented); special keys and shortcut pass-through; keyboard layout mapping; privacy screen with the required text; clipboard both ways (text, images, files) per profile; drag-and-drop file transfer into the transfer manager; chat + message box; annotations + laser pointer.

**Task 5: Reaching computers** (built in migration `037`, see Progress below) — address book (groups, tags, favourites, recent, online state, filters, bulk actions); connect by name / ID / code from Fleet and Hub search; Wake-on-LAN through the site Sensor then auto-connect; restart and reconnect (normal / Safe Mode with Networking) with automatic resume; "Request help" in the agent tray → Fleet + Watch item → attended session.

**Task 6: Quick Support** (built in migration `037`, see Progress below) — `nigafiy-support.exe` (Go, no install, attended only): 9-digit code + one-time PIN, Accept dialog, session bar, exits and deletes its temp files at the end; engine-side rendezvous; rate limits and lockout on codes; audit.

**Task 7: Recording, multi-operator, audio, printing** (migration `035`) — encrypted recordings stored by the engine with retention per policy, recording mark, playback in Fleet beside the audit timeline, user-side viewing when policy allows; invite / hand over to another operator, each named on the bar; remote audio (WASAPI loopback; codec chosen per toolchain check, off unless the profile allows); remote printing to the operator's printer.

**Task 8: Remote shell, scripts and jobs** (built in migration `042`, see Progress below) — interactive PowerShell / shell, admin role only, off in the default policy, full transcript in the audit, listed in the user's IT activity; scripts library with parameters; jobs on one computer or a group, now or scheduled; results per computer; rerun failed.

**Task 9: Patches, monitoring, inventory, compliance** (built in migration `043`, see Progress below) — Windows Update status via the WUA COM API; approve and install in maintenance windows; reboot policy with user postponement; CPU / memory / disk / service / event-log rules raising Watch alerts; inventory (hardware, software, licences seen, disk health, battery); compliance (firewall, Defender, BitLocker, pending updates, local admins) with "not measured" where the agent cannot measure.

**Task 10: The user's side** (built in migration `043`, see Progress below) — tray app: IT activity list (every session and background action, by whom), Request help, past recordings when allowed; the two-pane file manager with queue / resume / SHA-256 in Fleet.

### Wave 3 — Close (lead)

**Task 11: Gate and parity**
- [ ] Walk every bullet of `docs/features/fleet-pro.md` in the running Fleet program (EN + AR) and record the result in `status.md`.
- [ ] Full gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:agent`, `pnpm test:collector`, `pnpm test:engine`, desktop tests, `pnpm test:web`.
- [ ] Not-verified list: anything that needs a second physical computer, another site through the relay, LocalSystem service install, or a real Windows Update cycle.

## Results

(Filled in at the end of the milestone.)

## Progress (2026-11-24: patches, monitoring, inventory and the user's side)

Builder F5, branch `worktree-fleet-pro`, migration `043` (Tasks 9 and 10; the plan's `037` went to
reaching computers). What was built and exactly what ran for real are in `docs/features/fleet-pro.md`,
in the sections "Built: patches, monitoring, inventory" and "Built: the user's side".

- [x] Patches: WUA COM in pure Go; apt, dnf and softwareupdate, each labelled with its source;
  approvals per update or group, and auto-approve by classification; maintenance or group window;
  reboot policy never, ask (with postponements up to a deadline) or force; install history; audit
- [x] Monitoring rules: CPU, memory, disk free, service, event log or journal; a duration before a
  breach counts; Watch events and incidents that resolve on recovery
- [x] Inventory: hardware, licences seen (never product keys), disk health, batteries
- [x] Compliance: local administrators judged against an allowed list, "not measured" when unreadable
- [x] Tray: IT activity with sessions, shells, jobs, file transfers and update installs; End current
  session; past recordings through short-lived links when the group allows them; never hidden by policy
- [x] Two-pane file manager: this browser and the computer side by side, transfer queue, pause and
  resume of interrupted chunked transfers, SHA-256 check of every transfer, existing path guards
- [ ] Not verified here: a real update install or restart (nothing is installed on this PC), apt, dnf
  and softwareupdate on real machines, the tray menu and recording link on a real desktop, and the new
  pages in a browser against a running API.

## Progress (2026-11-24: remote shell, scripts and jobs)

Builder F4, branch `worktree-fleet-pro`, migration `042` (Task 8; the plan's migration number moved
because `036` went to in-session tools). What was built and exactly what ran for real are in
`docs/features/fleet-pro.md` → "Built: shell, scripts and jobs".

- [x] Remote shell: PowerShell over ConPTY (Windows), the user's shell on a pty (Linux), pipes (macOS,
  no cgo); admins only, group switch off by default, access policy and MFA, profile flag `shell`, Quick
  Support refused; at most 3 per computer; idle timeout and transcript limit
- [x] Transcript sealed per shell (AES-256-GCM, key in `rotate-key`), linked from the audit, admins only to
  read (audited); never in the plain audit
- [x] Banner "Shell open by [operator]" with End and Ctrl+Alt+Shift+E; the tray's IT activity list
- [x] Scripts library: PowerShell / sh per OS, typed parameters checked on the server, versions,
  technician mark, archive; parameters passed as environment data, never in the script text
- [x] Jobs: one computer, a selection or a group; now, once, recurring in a time zone; maintenance
  windows; offline catch-up with expiry; results per computer with the full output downloadable; rerun
  failed, run now, pause, cancel (stops the process tree); every step audited
- [x] Web (EN + AR): Fleet → Scripts, Fleet → Jobs, job page, endpoint Remote shell tab (xterm.js),
  transcript page, group switch, address book bulk **Run job**
- [x] Real agent on this PC: PowerShell over ConPTY through the WebSocket, and a job with a hostile
  parameter value returned as data
- [ ] Not verified here: the Linux pty and macOS pipes on real machines, the new web pages in a browser
  against a running API, the scheduler firing from the module timer in a long-running server, a
  maintenance window on a real site.

## Progress (2026-11-24: permission profiles, groups and access policy)

Built on branch `worktree-fleet-pro`, migration `035`. Details, refusal codes and exactly what ran for
real are in `docs/features/fleet-pro.md` → "Built: permission profiles and access policy".

- [x] `fleet_permission_profiles`: built-ins (read-only, seeded per organization) + custom profiles with admin CRUD
- [x] `fleet_groups` + `endpoints.fleet_group_id`: CRUD, bulk assignment, organization default from `remote_desktop_consent`
- [x] Access policy: attended/unattended, refuse window, allowed hours (site time zone), operator roles,
  default/max profile, MFA step-up token, second-admin approval with expiry, operator IP allow-list
- [x] Session request flow with required reason, policy trail, approval, refuse window; `fleet.session_*`,
  `fleet.profile_*`, `fleet.group_*`, `fleet.policy_*` audit
- [x] Enforcement in the API (stream hub + commands) and in the agent; permissions on the banner (EN + AR)
- [x] Web: Fleet → Access policies, Fleet → Approvals, connect dialog, group assignment, live permissions
  on the toolbar, session history columns (EN + AR)
- [ ] Not verified here: the new web pages in a browser against a running API, an approval or refuse
  window with a real agent on a second computer, a real authenticator app.
- Still open: multi-operator participants, recording, audio, privacy screen, block input and shell
  (the flags exist and are shown; the features that use them are later tasks).

## Progress (resumed 2026-11-22: remote desktop and agent transport)

The owner resumed Fleet Pro with a newer spec: WebSocket binary frames with adaptive JPEG and an HTTP
fallback instead of WebRTC/H.264. Built on branch `worktree-agent-a26eb689621043c25`, migrations
`033` (long-poll wake) and `034` (`fleet_sessions`). What was built, the security model, the
multi-instance routing (`RD_PEER_URL`) and exactly what ran for real are in
`docs/features/fleet-pro.md` → "Built: remote desktop and agent transport".

- [x] Agent long poll woken through pg_notify
- [x] WebSocket stream (agent RFC 6455 client, `ws` hub, peer relay between instances) + HTTP fallback
- [x] Adaptive JPEG quality/scale, unchanged-tile skipping (JPEG only: no pure-Go WebP encoder)
- [x] Consent dialog under `prompt` (replaces `consent_unavailable`), always-on session banner with End
- [x] Windows service + session helper (CreateProcessAsUser); Linux runuser / macOS launchctl asuser
- [x] Multi-monitor (EnumDisplayMonitors, "All displays"), clipboard text both ways
- [x] Linux Wayland via xdg-desktop-portal (godbus), macOS input via CoreGraphics/JXA — compiled and
  unit-tested only
- [x] `fleet_sessions` history (API, endpoint tab, Fleet → Remote sessions), `fleet.session_*` audit
- [ ] Not verified here: a real LocalSystem service install (needs an elevated prompt; the owner runs
  `endpoint-agent install`), Linux and macOS on real machines, a second physical monitor, input and
  clipboard on a real desktop.
- Still open from the plan: everything after the remote-desktop core (Quick Support, recording, chat,
  permission profiles and groups, MFA to connect, PowerShell, scripts, patches, the tray app).

## Progress (paused 2026-11-22)

The owner paused Fleet Pro while the Wave 1 builder was still reading the code. **No code was written.**

**Files that exist from Wave 1:** none. No migration `032`, no new API or agent files, no `docs/features/fleet-sessions.md`. `apps/api/src/modules/endpoints/fleet/service.ts` and `apps/web/.../fleet*` show as modified, but other builders made those changes before Wave 1 started.

**Tested:** no new tests. Checks on the tree as it stands: `go build ./...` in `agents/endpoint-agent` passed, and `pnpm --filter ./apps/api typecheck` passed with exit 0. The full API suite and the Go tests were not run, and no test PostgreSQL was started on port 5450.

**What the code reading found** (to save the next builder time):
- **There is no endpoint "group" concept** (no table, no column). Task 1's "access policy per group" needs a small `fleet_groups` table plus `endpoints.fleet_group_id`, or it has to wait for Task 5's address book. When an endpoint has no group, the default can come from the existing `endpoints.policy.remote_desktop_consent`, which keeps the current remote-desktop API working.
- **How remote-desktop sessions are stored today:** as `endpoints.rd_session` jsonb with a 12-character `randomToken` id, not a table row. The commands service uses that column to gate `rd_capture`/`rd_input`. Earlier sessions exist only as `endpoint.remote_desktop_started` / `_stopped` rows in `audit_logs`, so moving them into `fleet_sessions` means pairing those audit rows.
- `tests/endpoints.test.ts` checks that the `endpoint.remote_desktop_%` audit actions are exactly [started, stopped]. New audit actions need another prefix, such as `fleet.session_*`.
- **MFA to connect:** this can be a step-up TOTP check using `modules/auth/totp.ts` (`verifyTotp`) through `systemPool`, because `lan_app` has no grants on `users`. It has to respect `mfa_last_step` and the lockout.
- **WebSocket:** the API has no WebSocket dependency, and neither the store nor node_modules has `ws`. The Go agent has no WebSocket client and uses only the standard library. Without adding packages, both sides would need a small RFC 6455 implementation for text frames, ping/pong and close.
- `golang.org/x/sys` v0.50.0 is already in the local Go module cache. There is no C compiler on PATH.
- Session signalling can use `endpoint_commands` with new internal kinds that are not in `CommandInput`. Polling then still works with no extra code. The WebSocket would push the same pending commands, woken through `pg_notify` on the endpoint id.

**Still left in Wave 1:** everything in Task 1 and Task 2 (all boxes above stay unticked). This includes the feature doc and the gate run.

## Progress (2026-11-24: reaching computers and Quick Support)

Builder F3, branch `worktree-fleet-pro`, migration `037` (Tasks 5 and 6; the plan's migration numbers
moved because `035`/`036` went to policy and in-session tools). What was built and exactly what ran for
real are in `docs/features/fleet-pro.md` → "Built: reaching computers and Quick Support".

- [x] Address book: groups, tags, search, favourites, my recent, online state, filters (site, OS,
  compliance, group, tag, signed-in user); bulk group/tags/message/power/wake/refresh with per-computer
  results
- [x] Stable 9-digit Nigafiy ID per computer (endpoint page, cards, tray, About)
- [x] Connect by name, Nigafiy ID or Quick Support code from Fleet and the Hub search
- [x] Unattended access through the `035` policy, tested end to end
- [x] Restart and reconnect, normal or Safe Mode with Networking (service only), automatic resume,
  safe boot always cleared (agent start, failure, server request, timeout)
- [x] Windows user sessions (`WTSEnumerateSessions`) and the sign-in screen through the service
- [x] Request help in the agent tray → Fleet Help requests + Watch event → attended session; audited
- [x] Quick Support: `nigafiy-support.exe` (pure Go, signed server binding, server proof, code + one-time
  PIN, rate limit, lockout, expiry, Support cap, removes itself); rendezvous in the API (not the engine)
- [ ] Not verified here: bcdedit / a real restart / safe mode, the service install, the sign-in-screen
  helper, another user's session, a real Quick Support session from a downloaded exe, the web UI in a
  browser. The exe is not Authenticode-signed.

## Progress (2026-11-24: in-session tools, recording, operators)

Builder F2, branch `worktree-fleet-pro`, migration `036`. What was built, the gating and exactly what
ran for real are in `docs/features/fleet-pro.md` → "Built: in-session tools, recording, operators".

- [x] Quality modes, colour depth, remote cursor, monitor pick and one window per monitor, measured stats
- [x] View only / control / pause local input; SAS (service + `SoftwareSASGeneration`); special keys;
  keyboard layout mapping (by position / by character); Keyboard Lock in fullscreen
- [x] Privacy screen with the required text, hidden from capture (Windows 10 2004+)
- [x] Clipboard pictures and copied files per profile; drag-and-drop transfer (SHA-256, audited)
- [x] Chat and question box the user answers; drawing and laser pointer
- [x] Encrypted recordings (group rule, retention job, sealed key in rotate-key), playback beside the
  audit timeline, recording mark
- [x] Multi-operator: invite (full or view only), join through the policy, hand over, remove, leave;
  every operator named on the banner
- [x] Remote audio: WASAPI loopback, IMA ADPCM (no pure-Go Opus encoder)
- [x] Remote printing through the operator's browser (PDF, pictures, text)
- [x] Wake-on-LAN through the site Sensor, then the normal session request
- [ ] Not verified here: SAS with the service installed, any tool end to end with a real agent and a
  browser, a recording from a real agent, a real Wake-on-LAN, Linux/macOS dialogs, a second operator.
- Still open: user-side viewing of past recordings in the tray app (Task 10; the group flag
  `user_may_view_recordings` is stored), printing of file types the browser cannot print.
