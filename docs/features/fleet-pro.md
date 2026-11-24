# Nigafiy Fleet Pro: scope

Owner request (2026-11-21): Fleet becomes a complete, professional remote-support and computer-management
program, with every feature of AnyDesk and the tools like it (TeamViewer, RustDesk, Splashtop,
ConnectWise Control, NinjaOne-style RMM), and more. Mockups: `docs/design/mockups/Fleet*.dc.html`.
Implementation lands in Milestone 4 (Fleet), after the engine service of Milestone 3.

Rules that win over any feature below (design §2, `docs/security/model.md`):
- **Transparent always.** No feature may hide a session from the person at the computer. Every live
  session shows the on-screen session bar (operator, reason, what is allowed, End button); recording
  shows a recording mark; the privacy screen itself says who is connected and why.
- No keylogging, credential capture, stealth install or covert interception. Typed text and file
  contents are redacted from the audit log.
- Real only: every number on a session (fps, latency, route) is measured, never estimated.
- Nothing that exists today is removed: the current JPEG frame path stays as the fallback for agents
  and networks where the streaming path is unavailable.

## What exists today (verified in code)

| Area | Where | State |
| --- | --- | --- |
| Remote desktop: JPEG frames (quality 25–95, scale), mouse/keyboard/text input | `agents/endpoint-agent/internal/remotedesktop`, `rd_capture`/`rd_input` | Built, frame-by-frame over commands (now the HTTP fallback; monitors were the primary only) |
| Session start with operator + reason, on-screen notice, audit | `apps/api/src/modules/endpoints/remote-desktop` | Built (the `prompt` consent policy was **not** built: such sessions were refused with `consent_unavailable` until Fleet Pro; see below) |
| File manager: browse, chunked SHA-256 transfers, guarded paths, delete with confirm | `internal/filemgr`, `modules/endpoints/file-manager` | Built |
| Processes, services, software (install/remove), logs, power (lock/logoff/restart/shutdown), notify user, diagnostic commands (allow-listed) | `internal/control` | Built |
| Enrollment, groups/fleet, policy, compliance | `modules/endpoints/{enrollment,fleet,policy}` | Built |
| Wake-on-LAN | `collectors/lan-collector/internal/wol` | Built (Sensor side) |
| Operator MFA, team accounts and roles | `modules/auth/mfa.ts`, migration `018` | Built |

## Built: remote desktop and agent transport (2026-11-22)

Branch `worktree-agent-a26eb689621043c25`. The owner's newer spec replaced WebRTC/H.264 (§1 above) with
WebSocket binary frames, adaptive JPEG and an HTTP fallback, so that is what was built. Migrations
`033_agent_long_poll_wake.sql` and `034_fleet_sessions.sql`.

### Transport
- **Long poll.** `GET /api/v1/agent/poll?wait_ms=` (capped at 25 s) holds an empty poll open. It is
  woken by `pg_notify('ld_agent_wake', endpoint id)`, which a trigger fires on every insert into
  `endpoint_commands`, so it works across API instances. The agent backs off when a poll fails.
- **Live stream.** The agent opens `/api/v1/agent/stream?session=S`. It uses its own RFC 6455 client
  (`internal/wsclient`, pure Go), the agent credential and the same TLS pin as for HTTPS.
  Operators open `/api/v1/endpoints/:id/remote-desktop/stream?session=S` (the `ws` package on the API).
  Each frame is one binary message: `'N', 1`, a big-endian u32 header length, a JSON header, then the
  JPEG of each changed 64-px tile. The browser draws the tiles on a canvas and sends an ack after each
  draw.
- **No frame is stored.** The hub relays in memory only. `fleet_sessions` keeps counts: frames, bytes,
  clipboard uses and transport.
- **HTTP fallback.** If the socket fails, or stays "waiting" for more than 6 s, the console switches
  to the existing `rd_capture` path: one JPEG per command, kept transient by migration 031. The badge
  shows "Live stream · direct", "· relayed" or "HTTP fallback".

### Several API instances
Each instance announces the agent sockets it holds on the channel `ld_rd_stream`:
`up|E|S|instance|peerUrl` and `down|E|S|instance`. A new instance asks with `who|E|instance`. When an
operator connects to an instance that does not hold the agent's socket, that instance opens one peer
socket to the instance that does (`/api/v1/internal/rd-peer`). Every frame then passes over that
socket; the operator is never redirected. Session changes (`state|E|…`, `end|E`) are published on
COMMIT.

Set `RD_PEER_URL` on each instance to an address the other instances can reach. The default is
`http://127.0.0.1:$PORT`, which only works when every instance runs on one host. A test covers two
instances relaying through pg_notify.

### Security model
| Socket | Authentication |
| --- | --- |
| Agent | Bearer agent credential, for an open session of that endpoint. A second socket of the same agent replaces the first (close 4001). |
| Operator | `ld_session` cookie, `Origin` equal to `WEB_ORIGIN`, technician role or above, inside the operator's organization (RLS). |
| Peer (another API instance) | `x-ld-peer`: an HMAC derived from `APP_ENCRYPTION_KEY` over endpoint, session and instance, valid for 60 s. |

- Every message an operator sends is validated with zod.
- Input goes through the same `rdInputCommandSchema` and platform guard as the HTTP path, and is
  audited as `endpoint.rd_input` with `via: live_stream`. Mouse moves are not audited; typed text is
  redacted.
- Clipboard text is capped at 16,000 characters and audited as `fleet.session_clipboard` (direction and
  length, never the text).
- Ending a session closes every socket with code 4000.
- Under the `prompt` policy the hub sends the agent zero viewers until the database records that the
  user accepted, so no frame leaves before consent.
- The web proxies the WebSocket upgrade through Next.js rewrites on the same origin, so CSP
  `connect-src 'self'` covers it (CSP 3 treats same-origin ws/wss as 'self').

### Quality
- The agent measures ack round-trip and throughput (EWMA). It steps JPEG quality and scale down a
  ladder and back up, never above what the operator chose.
- Unchanged tiles are not sent. An unchanged screen sends nothing, except one full frame every 10 s.
- At most 2 frames are in flight, with a 2 s ack timeout and a cap of 15 fps.
- **JPEG only.** Go has no pure-Go WebP *encoder* (`golang.org/x/image/webp` only decodes), and cgo is
  not available, so WebP is not offered.
- Stats shown in the console: fps, kbps, RTT, throughput, quality, scale, changed %, capture and encode
  time.

### Consent and the session banner
- **Prompt policy.** The agent shows a real consent dialog to the signed-in user:
  - Windows: a Win32 dialog.
  - Linux: zenity or kdialog.
  - macOS: osascript.

  The dialog closes after 60 s, and no answer counts as a denial. The operator sees "waiting", with a
  countdown, then accepted, declined, no answer or unavailable. This replaces the old
  `consent_unavailable` refusal. **The earlier version of this document listed the consent policy as
  built. It was not: `prompt` sessions were refused.**
- **Banner.** Every session shows an always-on-top banner with the operator's name, the reason and an
  End session button, whatever the policy. Ending from the banner closes the session
  (`POST /api/v1/agent/rd-session/end`) and is audited as ended by the endpoint user.

### Service mode and session helper
`nigafiy-agent install | uninstall | run | session-helper`. Running it with flags only, as before,
keeps everything in the agent's own process.

- **`run`** (what the service runs) sends every desktop call (capture, input, consent dialog, banner,
  clipboard) to a session helper. The helper is the same binary started inside the signed-in user's
  session. It talks to its parent only over its stdin/stdout pipes, and never sees the credential.
- **Windows.** A LocalSystem service, `NigafiyEndpointAgent`, set to delayed auto-start and restarted
  after a failure.
  - The helper is started with `WTSQueryUserToken` + `CreateProcessAsUser` on `winsta0\default`.
    Only its three pipe handles are inherited.
  - The helper is restarted on console connect, disconnect, logon and logoff events, with a 10 s poll as
    a backstop.
  - `install` spends the enrollment token first, so the token never reaches the service command line.
  - The state directory (`%ProgramData%\Nigafiy\EndpointAgent`) gets an ACL for SYSTEM and
    Administrators only.
- **Linux (systemd).** The helper is started with `runuser` into the active logind session, with that
  session's `DISPLAY`/`WAYLAND_DISPLAY` and D-Bus address.
- **macOS (launchd).** The helper is started with `launchctl asuser` as the console user.

To install the service on Windows, run this from an elevated prompt, with the binary in Program Files:

```
nigafiy-agent.exe install -server https://<server> -token <enrollment token>
nigafiy-agent.exe uninstall
```

### Monitors, clipboard, other platforms
- **Monitors.** Windows lists each monitor through `EnumDisplayMonitors` (primary first), plus an
  "All displays" entry covering the bounding box. The operator switches between them during a session.
- **Clipboard.** Text in both directions, started by the operator only, capped at 16,000 characters
  and audited.
- **Linux Wayland.** Frames come from `org.freedesktop.portal.Screenshot`, one PNG per frame, which is
  deleted after it is read. Input goes through `org.freedesktop.portal.RemoteDesktop` with a ScreenCast
  monitor source, so pointer moves are absolute. Both use godbus. The portal shows the user its own
  permission dialog. ScreenCast frames themselves arrive over PipeWire, which needs cgo, so frames use
  the Screenshot portal and are slow.
- **Linux X11.** Unchanged: scrot, gnome-screenshot or ImageMagick, plus xdotool.
- **macOS.**
  - Frames: `screencapture`. ScreenCaptureKit needs cgo.
  - Input: CoreGraphics events from a JXA script (`osascript -l JavaScript`). macOS sessions are no
    longer view-only.
  - Both need the Screen Recording and Accessibility permissions. The console shows each as
    granted or denied.

### Session history
- **`fleet_sessions`.** Each row records:
  - operator, reason, policy
  - consent result, banner state, transport
  - counters
  - start, end, end reason, who ended it

  It is protected by RLS, and the app role cannot delete rows. Older sessions are
  backfilled from the audit pairs.
- **Where it shows.** `GET /api/v1/fleet/sessions` (technician and above) feeds the history table on
  the endpoint's Remote desktop tab and the **Fleet → Remote sessions** page.
- **Audit actions:**
  - `fleet.session_opened`, `_consent`, `_banner`, `_ended`, `_clipboard`, `_display`
  - the existing `endpoint.remote_desktop_started` / `_stopped`

### What ran for real, and what did not
- **Ran for real on this Windows desktop:**
  - The compiled agent streamed this screen (1920x1080 → 960x540, GDI, JPEG tiles) through the
    WebSocket hub to a test viewer, then closed with 4000. This ran twice: in the foreground, and as
    `nigafiy-agent run`, where every frame and the banner went through a real
    `session-helper` process.
  - The Fleet web console through the Next.js proxy: "Live stream · direct", the banner on the
    screen, scale changes, ending the session, the history row, and Arabic RTL.
  - A real 60 s consent dialog timing out.
  - `CreateProcessAsUser` with a user token starting a helper that answered over its pipes.
- **Tests only (no real desktop use):**
  - Mouse, keyboard and clipboard on the real desktop. They were not sent, to avoid moving the mouse
    and replacing the clipboard of the person using this computer. Go tests and the API stream tests
    cover them.
  - Two API instances (in one process, over real PostgreSQL).
- **Never run here:**
  - A real Windows service install. The prompt was not elevated. `install` refuses without elevation,
    and an opt-in test (`NIGAFIY_TEST_SERVICE_INSTALL=1` in an elevated prompt) registers and removes
    `NigafiyEndpointAgentTest`.
  - The helper started from session 0 by LocalSystem.
  - Linux (X11, Wayland portal, runuser, systemd) and macOS (JXA input, launchctl, launchd). These are
    compiled with `go vet` for both platforms and unit-tested on their pure parts.
  - More than one physical monitor.

## Built: permission profiles and access policy (2026-11-24)

Migration `035_fleet_profiles_and_policy.sql`. API code is in
`apps/api/src/modules/endpoints/fleet-policy/`, agent code in `internal/rdstream`, `internal/userui` and
`internal/agent/session_commands.go`, and web code in `apps/web/features/endpoints/components/fleet-policy/` plus the
**Fleet → Access policies** and **Fleet → Approvals** pages.

### Data model
- **`fleet_permission_profiles`** holds one boolean column per flag: `view`, `control`,
  `clipboard_in` (operator → computer), `clipboard_out` (computer → operator), `files`, `audio`,
  `record`, `restart`, `privacy_screen`, `block_input`, `shell`.
  - The built-ins are `view_only` (view, record), `support` (view, control, clipboard both ways, files,
    record, restart) and `full_admin` (everything).
  - Every organization gets the built-ins. `fleet_seed_builtin_profiles(org)` seeds the existing
    organizations in the migration. New organizations are seeded lazily on first use. A trigger was
    avoided because it would collide with pg_dump restores.
  - Row-level security splits the policies: `lan_app` can read and insert, but can update or delete only
    rows where `builtin_key IS NULL`. So built-ins are read-only even for SQL that skips the API.
  - Names are unique per organization, case-insensitive.
- **`fleet_groups`** stores the access policy:
  - `access_mode` (attended / unattended) and `consent_timeout_s` (10–300)
  - `refuse_window_s` (0, or 10–300)
  - `allowed_hours`: up to 14 weekly windows in the site's time zone; an end before the start crosses
    midnight
  - `allowed_roles` (owner / admin / technician)
  - `default_profile_id` and `max_profile_id`
  - `mfa_required`, `approval_required` and `approval_ttl_minutes` (1–240)
  - `ip_allowlist` (`cidr[]`, up to 32)
- **`endpoints.fleet_group_id`** is nullable. Deleting a group sets it back to null. The groups are
  designed to become the address-book groups later.
- **No group means the organization default:**
  - attended (60 s) when the endpoint's `policy.remote_desktop_consent` is `prompt`, otherwise
    unattended without a refuse window
  - all operator roles, any time and any address
  - Support by default, Full admin at most
  - no code and no approval
- **`fleet_sessions` gains:**
  - the group, the profile (id and name), and a snapshot of the `permissions`
  - `consent_timeout_s` and `refuse_window_s`
  - `policy_trail` (each check with pass, fail or info)
  - `mfa_verified` and `request_ip`
  - `approval_state`, `approval_expires_at`, approver id and email, the decision time and the note
  - the new state `waiting_approval`, consent result `not_refused`, and end reasons `approval_denied`
    and `approval_expired`
  - Sessions that were open during the migration got Support-like permissions, named "Support (before
    profiles)".

### Flow
1. **Connect dialog.** The operator opens the dialog, which shows
   `GET /endpoints/:id/remote-desktop/policy`. This is advice only: the request checks everything again.
   The operator gives a reason (required, 3–200 characters) and picks a profile up to the maximum. If
   the policy asks for a code, the operator enters a TOTP code. `POST /fleet/step-up` exchanges it for a
   step-up token that lasts 5 minutes:
   - The token is stateless: an HMAC over the user, the organization, the sign-in session and the
     expiry time.
   - Codes are checked with `verifyTotp` through `systemPool`, and `mfa_last_step` blocks replays.
   - After 5 wrong codes the account is locked for 15 minutes (`mfa_locked`, 429).
2. **Evaluation in `POST /remote-desktop/start`,** in this order: role → IP (through the existing
   trust-proxy handling) → hours → MFA → profile → mode → approval.
   - A profile above the maximum is clamped to the maximum, and the trail records that.
   - Each refusal writes `fleet.policy_refused` in its own transaction, so the audit survives the
     rollback.
3. **Second admin (unattended + `approval_required`).** The session waits in `waiting_approval` and is
   listed on **Fleet → Approvals**.
   - Another admin approves or denies it. The requester cannot do either (`approval_self`).
   - A request nobody decides in time expires (`approval_expired`). The check runs on every status read
     and every approvals list.
   - After approval, the session goes on to the agent.
4. **The user at the computer.**
   - Attended: the consent dialog.
   - Unattended with a refuse window: a "Start now / Refuse" dialog that lists the permissions. No answer
     lets the session start (`not_refused`).
   - Unattended without a window: a notice, then the session starts.
   - The window is counted from the approval, if there was one.
5. **Live.** Two layers enforce the profile:
   - **The API.** The stream hub refuses input without `control`, `clipboard_get` without
     `clipboard_out` and `clipboard_set` without `clipboard_in`. The commands path refuses `rd_capture`
     without `view` and `rd_input` without `control`. For the session holder, it also refuses `fs_op` without `files` and
     `power_action` without `restart`. Each refusal is audited as `fleet.session_refused_action`, except
     mouse moves.
   - **The agent.** It applies the same flags to the stream and to HTTP input. It lists the flags on the
     banner in English and Arabic. The banner shows for every profile; nothing turns it off.

### Refusal codes (English and Arabic in `policy-text.ts`)
- **Policy (403):**
  - `policy_role_not_allowed`, `policy_ip_not_allowed`, `policy_outside_hours`
  - `policy_mfa_not_enrolled`, `policy_mfa_required`, `policy_mfa_invalid`
- **Profile (422):** `profile_no_view`, `profile_not_found`
- **Enforcement (403):** `profile_forbids_view`, `_control`, `_clipboard_in`, `_clipboard_out`,
  `_files`, `_restart`
- **Step-up:** `invalid_mfa_code` (401), `mfa_locked` (429)
- **Approvals:** `approval_self` (403), `approval_expired` (409), `approval_not_pending` (409)
- **Admin CRUD:** `profile_builtin`, `profile_in_use`, `profile_name_taken`,
  `profile_default_exceeds_max`, `group_name_taken`

### Audit
- **Profiles:** `fleet.profile_created`, `_updated`, `_deleted`
- **Groups:** `fleet.group_created`, `_updated`, `_deleted`, `_assigned`
- **Policy:** `fleet.policy_updated` (when policy fields change, with before and after),
  `fleet.policy_refused`, `fleet.policy_mfa_verified`, `fleet.policy_mfa_failed`
- **Sessions:** `fleet.session_requested`, `_approval_requested`, `_approved`, `_approval_denied`,
  `_approval_expired`, `_refused_action`, plus the existing `_opened`, `_consent` and so on

Typed text, clipboard text and codes are never logged.

### Roles
- **Viewers** see no Policies page, no Approvals page, no group controls and no connect button.
- **Technicians** can read profiles and groups, see the policy preview, and connect within the policy.
- **Admins** can create and change profiles and groups, assign groups (in bulk on the endpoint list,
  one at a time on the endpoint detail) and decide approvals.

### What ran for real, and what did not
- **Ran for real on this Windows desktop:** the opt-in Go test
  `NIGAFIY_UI_TEST=1 go test ./internal/userui -run TestWindowsRefuseWindowAndPermissionBanner`. It
  opened the real "Start now / Refuse" dialog and the session banner with the permission lines in
  English and Arabic.
- **Tests only:** everything else.
  - The API tests ran against embedded PostgreSQL:
    - every policy branch: role, IP (including X-Forwarded-For), hours in and out with the time zone,
      MFA (missing, wrong, replay, lockout, valid)
    - the profile clamp and the profile CRUD rules
    - groups, bulk assignment and tenant isolation
    - approvals: self-approval, approve, deny, expiry
    - enforcement in the API and in the stream hub
  - The Go tests cover agent enforcement (stream and HTTP input), the refuse window and the banner for
    every profile.
  - The web pages were type-checked and built.
- **Never run here:**
  - the new web pages and the connect dialog in a browser against a running API
  - an approval or a refuse window with a real agent on another computer
  - a real authenticator app

## Target feature set

### 1. Live session (the AnyDesk core)
- **Streaming:** DXGI Desktop Duplication capture, H.264 encode through Windows Media Foundation
  (hardware encoder when present, Microsoft's software encoder otherwise), up to 60 fps and 4K,
  adaptive bitrate. Transport **WebRTC** (pion in the Go agent; Chromium in the Fleet app decodes it):
  direct peer-to-peer on the LAN, through the engine's own TURN relay between sites. DTLS-SRTP
  encryption end to end; the relay never sees the picture. Fallback: today's JPEG path.
- Measured stats on the toolbar: fps, round-trip latency, bandwidth, route (direct LAN / relay), codec.
- Quality modes: Best picture, Balanced, Fast response; colour depth; show/hide remote cursor.
- Monitors: pick one, all monitors side by side, or each monitor in its own window.
- View only, mouse and keyboard, block the local user's input (session bar still visible), Ctrl+Alt+Del
  (Secure Attention Sequence), special keys and shortcut pass-through, keyboard layout mapping.
- **Secure desktop and login screen:** the agent service runs a helper on the active console session
  and on the Winlogon desktop, so UAC prompts, the lock screen and the sign-in screen can be used.
- Switch between Windows user sessions; connect to a computer nobody is signed in to.
- **Restart and reconnect** (normal or Safe Mode with Networking); the session resumes on its own.
- **Privacy screen:** blanks the physical monitor while working, and shows on it
  "IT support session in progress: [operator], reason: [reason]". Never a plain black screen. The user
  can always end the session from it with Ctrl+Alt+Shift+E.
- Clipboard sync both ways (text, images, files), each direction allowed by the permission profile.
- File transfer inside the session: drag and drop either way, plus the transfer manager (§3).
- Chat panel, and a message box the user can answer.
- Remote audio (WASAPI loopback → Opus), off unless the profile allows it.
- Draw on the remote screen (annotations the user sees), laser pointer.
- **Session recording** to the engine (encrypted, retention per policy), with the recording mark on the
  user's screen while it runs; playback inside Fleet with the audit timeline beside it.
- Several operators in one session (invite a colleague, hand the session over), each named on the bar.
- Wake-on-LAN through the site's Sensor, then connect when the computer comes up.
- Remote printing: print a remote document on the operator's printer.

### 2. Reaching computers
- **Address book:** groups, tags, search, favourites, recent sessions, online state, filters by site,
  OS, compliance and user; bulk actions on a selection.
- **Unattended access** to enrolled computers, governed by policy (§4).
- **Quick Support** for a computer that is not enrolled: the user runs the small `nigafiy-support.exe`
  (no install, nothing left behind), reads a 9-digit code and a one-time PIN to the operator and clicks
  Accept. Attended only; it closes and removes itself when the session ends.
- Connect by computer name, ID or code from the Fleet app or the Hub's search.
- **Request help** in the agent's tray menu: the user asks for support with a note; the request appears
  in Fleet (and as a Watch item), and the operator starts an attended session from it.

### 3. Work without interrupting the user
- File manager with two panes (this computer / remote), queue, resume, SHA-256 check, guarded paths.
- **Remote PowerShell / terminal:** interactive shell, admin role only, off in the default policy, full
  transcript in the audit log, listed in the user's tray under "IT activity".
- **Scripts library and jobs:** saved PowerShell/shell scripts with parameters, run on one computer or a
  group now or on a schedule, results per computer, rerun failed ones.
- Processes, services, software (winget), event logs, power, notify user: as today.
- **Patches:** Windows Update status per computer, approve and install in maintenance windows, reboot
  policy with user postponement.
- **Monitoring:** CPU, memory, disk, services and event-log rules raise alerts in Nigafiy Watch.
- Inventory: hardware, software, licences seen, disks and their health, battery.
- Compliance: firewall, Defender, BitLocker, pending updates, local admins; an item the agent cannot
  measure says "not measured".

### 4. Control and trust (beyond AnyDesk)
- **Permission profiles:** View only, Support, Full admin, or custom: view, control, clipboard each way,
  files, audio, record, restart, privacy screen, block input, shell.
- **Access policy per group:** attended (user must accept, with a timeout) or unattended; "user may
  refuse within N seconds"; allowed hours; operator roles; MFA required to connect; a second admin
  approves unattended sessions when the policy asks for it; IP allow-list for operators.
- **The user's side:** the session bar (who, why, permissions shown live, End session always available),
  the "IT activity" list in the tray (every session and background action on this computer, by whom),
  and a setting to see past session recordings of their computer when policy allows.
- Audit for every session: operator, reason, start/end, permissions used, files moved (names, sizes,
  hashes), recording link. Typed text and file contents are never stored.
- Self-hosted: sessions, relay and recordings run on the company's own Nigafiy engine. No third-party
  cloud is needed.

## Out of scope
- Mobile viewer apps and mobile device management (removed in migration `015`; design §2).
- Any mode that hides the session bar or the privacy-screen text.
