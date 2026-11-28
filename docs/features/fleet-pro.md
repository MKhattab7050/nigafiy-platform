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
| File manager: browse, chunked SHA-256 transfers, guarded paths, delete with confirm; whole folders down (to a folder or ZIP) and up, device → device copies, resumable very large transfers (`docs/roadmap/2026-11-28-file-manager-pro.md`); PC and Android agents from 1.0.10 move the bytes through a binary side channel, ~24 MB/s on one PC (`docs/roadmap/2026-11-28-file-transfer-speed.md`) | `internal/filemgr`, `modules/endpoints/file-manager`, web `remote-files/transfer-engine.ts` | Built |
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
socket; the operator is never redirected. Session changes (`state|E|state|S`, `end|E|S`) are published on
COMMIT and name the session: a late notification about an earlier session never touches a newer
session of the same endpoint.

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
- **Banner (configurable per group, built 2026-11-26, migrations 051 and 052).** The session banner
  is set by the group's `banner_mode`. **Silent by default** (owner decision 2026-11-26, "everything
  silent"): a new group is `unattended` with `banner_mode: off` unless the admin picks otherwise,
  existing unattended groups were switched to `off` (052), and a computer in no group that is
  unattended gets `off` too (`prompt` computers keep the full banner). Remote shells follow the same
  setting: with `off` the shell is not named on the banner (`shell_open.banner_mode`); its transcript
  and audit are kept.
  - `shown` (default): an always-on-top banner with the operator's name, the reason and an End session
    button. Ending from the banner closes the session (`POST /api/v1/agent/rd-session/end`), audited as
    ended by the endpoint user.
  - `minimized`: a small box in the bottom-right corner of the screen (Windows; Linux and macOS show
    the same short text in their dialog): who is connected, view only or not, the recording mark,
    and End session / Ctrl+Alt+Shift+E. Open remote shells still get their full lines. The person
    still gets the "session started" notice.
  - `off`: **no on-screen banner** — the operator connects, views and controls without the signed-in user
    being interrupted, matching how an internal IT tool (SCCM-style) works on company machines. Allowed
    **only** on a managed endpoint whose group is `unattended`; refused for `attended`, for Quick Support
    and for help-request sessions (those stay `shown`). The one-time consent is the enrollment / company
    monitoring policy, not a per-session prompt. With `off` the server also skips the "session
    started" and "session ended" notices. The person can still end the session from the Nigafiy tray
    menu, and Fleet ends it as always (`rd_session_close`). With no banner there is no on-screen
    recording mark either: a recorded session still shows in the session history and the audit log.
  - Where it is enforced: the API refuses `minimized`/`off` unless the group is `unattended`
    (`422 banner_mode_needs_unattended`, also a database check), and changing such a group to
    `attended` needs `banner_mode: shown` in the same change. Each session takes a snapshot
    (`fleet_sessions.banner_mode`), forced to `shown` for attended, refuse-window, help-request, Quick
    Support and phone sessions; the connect dialog and the session view say which mode applies, and
    the policy trail carries a `banner` line. The agent applies the same rule again
    (`rdstream.OpenRequest.Banner`): consent or a refuse window in the payload always draws the full
    banner, and an unknown value is treated as `shown`. An older agent ignores the field and shows
    the full banner.
  - Tests: `apps/api/tests/fleet-banner-mode.test.ts` (refusal matrix, payload, notices, audit,
    forced cases) and `agents/endpoint-agent/internal/rdstream/banner_mode_test.go` (off draws
    nothing and still closes from Fleet, minimized draws the corner box, consent/refuse window
    override). **Not yet seen on a real screen**: the corner box was built for Windows but only the
    text and the decision are tested; check it on the installed agent.
  - **The server-side audit log is written in every mode**, including `off` (operator, reason, start/end,
    permissions used, files moved). `banner_mode` is recorded on the session and in `fleet.session_banner`.
    The point of `off` is "the user is not interrupted each time," not hiding the fact of management — the
    endpoint still carries the agent and the IT-activity record the organization configures.

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
  - `banner_mode` (`shown` / `minimized` / `off`). The column default is `shown`, but the API creates
    an unattended group with `off` and an attended one with `shown` when none is given (052). `off` is accepted only with
    `access_mode = unattended` on a managed endpoint — see "Consent and the session banner"
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
  - `banner_mode = off` when unattended, `shown` when `prompt` (silent by default, migration 052;
    put the computer in a group to choose otherwise)
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
   - Unattended without a window: a notice, then the session starts (with `banner_mode: off`, no
     notice and no banner; the default since 052).
   - The window is counted from the approval, if there was one.
5. **Live.** Two layers enforce the profile:
   - **The API.** The stream hub refuses input without `control`, `clipboard_get` without
     `clipboard_out` and `clipboard_set` without `clipboard_in`. The commands path refuses `rd_capture`
     without `view` and `rd_input` without `control`. For the session holder, it also refuses `fs_op` without `files` and
     `power_action` without `restart`. Each refusal is audited as `fleet.session_refused_action`, except
     mouse moves.
   - **The agent.** It applies the same flags to the stream and to HTTP input. It lists the flags on the
     banner in English and Arabic. The banner shows for every profile unless the group's `banner_mode` is
     `off` (unattended groups only; see "Consent and the session banner"); the audit log is kept either way.

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

## Built: in-session tools, recording, operators (2026-11-24)

Builder F2, branch `worktree-fleet-pro`, migration `036_fleet_session_tools.sql`. This wires up the
profile flags `audio`, `record`, `privacy_screen` and `block_input` that F1 only showed.

### Gating
Every tool is checked in two places:
- **In the API.** The stream hub checks each socket message against the session's permissions,
  intersected with the participant's own permissions. The REST routes check role and session holder.
  The commands route refuses `rd_capture` and `rd_input` from anyone who is not a participant
  (`not_a_participant`, audited).
- **In the agent.** `rdstream/tools.go` checks against the profile the session was opened with.
  Refusals come back as `tool_error` with `profile_forbids_<tool>` or `unsupported_here`.

The agent's `hello` lists the tools it supports (`features`). The web UI only shows a button when the
profile allows the tool and the agent supports it. Viewers get no write buttons.

### Tools
- **Picture modes.** Best is quality 85, scale 1, adaptive off. Balanced is 68, 0.75, adaptive.
  Fast is 45, 0.5, adaptive.
- **Colours.** Full colour, 16-bit, or 8-bit greyscale (`settings.depth`). Remote pointer on or off
  (`settings.cursor`). Measured stats stay as before: frames, kb/s, round trip, changed %, viewers.
- **One window per monitor.** The stream switches to "All displays" and each popup draws its own
  crop of that one picture. It is not a separate stream per monitor.
- **Keyboard.**
  - "By position" sends `key_down` and `key_up` with the physical `KeyboardEvent.code`, so the remote
    keyboard layout decides the character. "By character" keeps the old character mode.
  - The special-keys menu sends key combinations (Alt+Tab, Win+R, Ctrl+Shift+Esc and others).
  - Fullscreen asks for Keyboard Lock where the browser supports it.
  - Typed keys are never written to the audit: `code` and `keys` are redacted.
- **Ctrl+Alt+Del (SAS).** The agent service calls `SendSAS`. This needs the service and
  `SoftwareSASGeneration` = 1 or 3 under
  `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`. Without them the agent replies
  with the exact reason. Windows only.
- **Pause their input.** Low-level keyboard and mouse hooks drop the person's own input and let the
  agent's injected input through. Ctrl+Alt+Shift+E always passes and ends the session. Limits:
  - hooks cannot block input to elevated windows or the secure desktop
  - a helper restart loses the block
- **Privacy screen.**
  - One topmost window per monitor shows "IT support session in progress" with the operator and the
    reason. It is never plain black.
  - `WDA_EXCLUDEFROMCAPTURE` keeps it out of the capture, so the operator still sees the desktop.
    This needs Windows 10 2004 or later. On older builds the UI says the operator would see it too.
  - A helper restart drops the privacy screen until it is turned on again.
  - Not available on Linux or macOS.
- **Clipboard pictures and copied files.**
  - Pictures are PNG, at most 4 MB.
  - Copied files are a list of paths (`CF_HDROP`). Files are fetched through the chunked transfer
    with SHA-256.
  - Text is unchanged.
- **Drag and drop.**
  - Drop files on the screen or on the drop zone. They go to a destination folder (the user's home
    by default) through `fs_op upload` in 256 KB chunks, checked with SHA-256.
  - The agent refuses to overwrite an existing file.
  - The transfer can also put the sent files on the person's clipboard.
  - `POST …/transfer` audits the name, size and SHA-256, never the contents.
- **Chat and questions.**
  - Chat opens a chat window on the person's screen, and they can reply there.
  - Questions are Yes/No, OK, or free text, with a 5-minute timeout. The answer comes back as
    `answer`.
  - Counts go in `fleet_sessions.chat_messages`. The text is not audited.
  - On Linux and macOS, chat and questions use zenity, kdialog or osascript.
- **Drawing and laser pointer.** Strokes and the pointer are sent in 0–1 coordinates of the shown
  display. The agent draws them on a click-through layer, which is cleared when the session ends.
  Windows only.
- **Sound.**
  - WASAPI loopback, encoded as IMA ADPCM. Each 40 ms packet carries its own decoder state.
  - Bandwidth: 48 kHz stereo is 384 kbit/s, mono is 192 kbit/s. The viewer shows the measured kb/s.
  - Opus is not used because there is no maintained pure-Go Opus encoder and cgo is not available.
  - Windows only.
- **Remote printing.**
  - The file comes to the operator's browser through the file transfer, and the browser's print
    dialog prints it on the operator's printer. Nothing is installed on the computer.
  - Only PDF, PNG, JPEG, GIF, WebP and text files can be printed. Other types are refused with a
    message.
  - `POST …/print` audits the name, size, SHA-256 and type.

### Recording
- **Rule per group.** `fleet_groups.recording_mode` is `off`, `optional` (the operator chooses, and
  the profile must allow `record`) or `required` (every session; profiles without `record` are
  refused with `recording_required_profile_cannot_record`). It also sets the retention in days and
  whether the person may see past recordings (stored; the tray app does not show them yet, Task 10).
  Endpoints in no group default to `optional`,
  kept 30 days.
- **Turning it on.** The connect dialog shows the rule. The holder can switch recording on or off
  during the session (`POST …/recording`).
- **What is recorded.** Frames, plus input timing (`{k,d,x,y}`; keys only as "a key", never which one)
  and tool events.
- **Storage.**
  - Files are AES-256-GCM, at `<data>/recordings/<org>/<id>/seg-<ms>.nrec`. Each record is
    `[len][nonce][ciphertext+tag]` with AAD `"<id>|<segment>"`.
  - The file key is sealed with `APP_ENCRYPTION_KEY` in `fleet_recordings.key_sealed` and covered by
    `rotate-key`.
  - The API instance that holds the agent's socket writes the file.
- **Retention.** The job `fleet-recording-retention` deletes expired files and marks the rows
  `deleted`.
- **Playback.** Fleet → Remote sessions → "Play recording" opens `/fleet/recordings/:id`.
  - The API decrypts one part at a time. Opening a recording is audited (`fleet.recording_viewed`).
  - The page shows the session's audit timeline beside the picture.
  - Admins can delete a recording (`fleet.recording_deleted`).
  - Playback starts at the beginning of a part, so the picture may build up tile by tile until the
    next full frame.
- **Recording mark.** The person's session bar shows the recording mark for as long as recording
  runs, and nothing can turn it off.

### Several operators
- **Inviting.** The holder invites a colleague, either with the session's permissions or as view only
  (`fleet_session_participants`). The invitation lasts 15 minutes.
- **Joining.** Joining re-runs the access policy for the colleague: role, address, hours, and MFA,
  where the UI asks for the 6-digit code.
- **Managing.** The holder can hand over the session or remove a colleague. A removed colleague's
  socket is closed with code 4003. Colleagues can leave.
- **Banner.** The person's banner names every operator (`rd_session_update`).
- **Limit.** `fs_op` file commands from a joined colleague follow the colleague's role, not the
  participant permissions. Only `rd_*` is limited per participant.

### Wake-on-LAN, then connect
For an offline computer, "Wake and connect" asks for a reason and a profile through the usual dialog.
1. `POST …/wake` queues Wake-on-LAN through the site's Sensor, on the scope-checked path only.
2. The console polls until the agent is online, then sends the normal session request with
   `wake_request_id`, so the access policy decides again.
3. It times out after 5 minutes.

A step-up token from the dialog can expire during a long wake. In that case the request is refused
and the operator connects again.

### Transparency (cannot be turned off)
The session bar, the recording mark, the privacy-screen text, Ctrl+Alt+Shift+E and the audit rows
(`fleet.session_privacy_screen`, `…_block_input`, `…_sas`, `…_chat`, `…_question`, `…_annotation`,
`…_audio`, `…_clipboard`, `fleet.recording_*`, `fleet.participant_*`, `fleet.wake_*`) have no off
switch in any profile or policy. Pinned by `internal/userui/tools_test.go` (banner names every
operator and shows the recording mark, privacy text never empty and says how to end) and
`internal/rdstream/tools_test.go` (end of session turns every tool off).

### What ran for real, and what did not
- **Ran for real on this Windows desktop** (opt-in Go tests, `NIGAFIY_UI_TEST=1`):
  - WASAPI loopback capture (48 kHz stereo float)
  - the privacy-screen window excluded from capture
  - the chat, question and drawing windows
  - registering and releasing the end hotkey
  - installing and releasing the low-level input hooks (input blocked for 1 s)
- **Tests only:**
  - API tests against embedded PostgreSQL: recording rule and toggle, sealed key, segment
    encrypt/decrypt and playback, retention, participants (invite, join through the policy, handover,
    remove), wake requests, print and transfer audits, tool messages through the hub
  - Go tests for tool gating in the agent
  - the browser ADPCM decoder against the agent's encoder (bit-exact)
  - web type-check and build
- **Never run here:**
  - SAS (needs the service install and the policy value)
  - any tool end to end from a real agent through a running API to a browser
  - a recording made by a real agent
  - the new web UI in a browser
  - a real Wake-on-LAN through a Sensor
  - Linux and macOS dialogs
  - a second operator on another machine

## Built: reaching computers and Quick Support (2026-11-24)

Builder F3, branch `worktree-fleet-pro`, migration `037_fleet_reach.sql`. API in
`apps/api/src/modules/endpoints/fleet-reach/`; agent in `internal/reboot`, `internal/tray`,
`internal/quicksupport`, `internal/sysinfo/usersessions*.go`, `cmd/nigafiy-support`; web in
`apps/web/features/endpoints/components/reach/` and the new page **Fleet → Help requests**
(`/fleet/requests`).

### Address book
- Every computer has a stable **Nigafiy ID** (9 digits, never starting with 0, unique per organization,
  given by a database trigger at enrollment and back-filled for existing computers). It shows on the
  computer card, on the endpoint page, in the agent's tray tooltip and menu, and in its About box.
- **Tags** (up to 20 per computer, lower case; admins add or remove them on a selection),
  **favourites** per operator (technicians), **my recent** (the operator's own last session per
  computer, newest first), live online state, and filters by site, OS, compliance, group, tag and
  signed-in user (from the heartbeat's logged-in users and Windows sessions). `GET /endpoints` also
  takes `q`, `tag`, `favourites`, `user` for API clients.
- **Bulk actions** on a selection: group and tags (admins), a message, a power action, Wake-on-LAN,
  refresh inventory (`POST /fleet/bulk`). Each computer goes through the single action's own role check,
  platform guard and audit row, and gets its own result (restart and shut down still need an admin).

### Connect by name, Nigafiy ID or code
`GET /fleet/connect/resolve?q=` (technicians): 9 digits find a Nigafiy ID first, then a waiting Quick
Support code; anything else matches the name or host name exactly, then by prefix. The box on
**Fleet → Endpoints** opens the computer with the connect dialog (`?connect=1`), lists several matches,
or asks for the Quick Support PIN. The Hub search (`overview/search.ts`) matches Nigafiy IDs too and
links straight to `?connect=1`. Quick Support computers never appear in the address book, the Hub search,
reports or portfolios.

### Unattended access
Unchanged rules from the access policy (`035`): unattended only where the group's policy says so,
with its refuse window, hours, IP list, MFA and approval. The new test walks an unattended session end
to end through the policy (no consent dialog, the notice first, then live), and the same computer
waits for Accept once its group is attended again. A session from a help request or Quick Support is
always attended whatever the policy says.

### Restart and reconnect
- Only the operator holding the session, with a profile that has **restart**, from the session's
  **Restart and reconnect** panel: normal, or **Safe Mode with Networking**.
- The agent gets `fleet_restart`. Safe mode needs Windows and the agent running as the LocalSystem
  **service**; otherwise the API (`safe_mode_needs_service`, `safe_mode_windows_only`) and the agent
  (`ErrNeedsService`) refuse honestly. The agent writes a marker file first, registers its service under
  `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Network\<service>`, runs
  `bcdedit /set {current} safeboot network`, and restarts with a message naming the operator and reason
  (`shutdown /r /t 15 /c …`).
- **Safe boot is always cleared**: by the agent first thing when it starts again (before anything
  else), when setting it or the restart fails (rolled back), and by the server
  (`fleet_safe_boot_clear`) whenever the heartbeat still reports the marker, the restart fails or it
  times out. The marker is removed only when `bcdedit /deletevalue {current} safeboot` succeeded or
  reported that the value is not set.
- The session ends with the reason **restart**; the API sees the agent back (uptime after the restart)
  and, when the operator's console polls `GET …/remote-desktop/restart`, opens the resumed session with
  the same reason, profile, Windows session and recording rule (`resumed_from_id`). Timeout 10 minutes
  by default (120–3600 s). Quick Support computers cannot be restarted (`quick_support_no_restart`).

### Windows user sessions and the sign-in screen
- The heartbeat lists Windows sessions (`WTSEnumerateSessions`, user and domain per session) and the
  boot state (safe mode now, safe-boot marker, running as service).
- The connect dialog offers the console session (default), any listed session, or **Sign-in screen
  (nobody signed in)**. The API checks Windows, the service and that the session is listed
  (`user_session_windows_only`, `user_session_needs_service`, `user_session_unknown`).
- The service starts the session helper in that session (`WTSQueryUserToken` + `CreateProcessAsUser`),
  or for the sign-in screen with its own LocalSystem token moved to the console session
  (`SetTokenInformation(TokenSessionId)`) on `winsta0\winlogon`. After the session the helper goes back
  to the console session.
- **Needs LocalSystem** (the service): another user's session, the sign-in screen, Safe Mode with
  Networking, SAS. The foreground agent refuses all four with the codes above.

### Request help
- The agent shows a tray icon (Nigafiy ID in the tooltip and menu) with **Request help** and
  **About** (server, Nigafiy ID, the transparency text, EN and AR). Request help asks for a note and sends
  it with the signed-in user (`POST /api/v1/agent/help-request`, at most 5 open per computer).
- The request appears in **Fleet → Help requests** (with a count on the menu entry), as a badge on the
  computer's card, and as a Watch event (warning). The note is shown to operators; the audit row keeps
  only its length.
- **Start attended session** opens the connect dialog; the session is always attended (consent), and the
  request moves to "in session". **Close** takes an optional note.

### Quick Support
- **Download** (technicians): Fleet → Help requests → Quick Support, per site. The API appends a signed
  binding to `nigafiy-support.exe`: server URL, TLS pin, a 7-day organization/site link (HMAC), the issuer
  and the server's Ed25519 public key, signed with that key. The key is derived from
  `APP_ENCRYPTION_KEY` (HKDF; nothing stored), so rotating the key retires earlier downloads. Its
  fingerprint shows beside the download and on the person's screen.
- **The program** (pure Go, no install, no admin rights): checks the binding signature (a changed URL
  breaks it), registers with a random nonce, and checks the server's proof (nonce + code signed with the
  key) so only the server that made the download can answer. It shows a 9-digit code and a one-time PIN,
  runs the agent's stream and input with a Quick Support profile (no tray, no inventory, no restart, only
  screen, input, files and a message), and when the session ends, the code expires or is locked, or the
  person closes the window, it deletes its temporary folder and itself (`-keep` keeps the file) and exits.
- **Connect**: code + PIN + reason (`POST /fleet/quick-support/connect`, 15 attempts per operator per
  10 minutes). Only the PIN's hash is stored; 5 wrong PINs lock the code; a code expires after 10
  minutes; the PIN works once. The session is attended and at most the **Support** profile, with the
  banner and End session as always. Commands to a Quick Support computer are limited
  (`quick_support_limited`); its credential is revoked when the session ends.
- Prerequisite: `pnpm build:agent` builds `agents/endpoint-agent/bin/nigafiy-support.exe` (on a non-Windows
  server build it with `GOOS=windows`, or point `QUICK_SUPPORT_EXE` at a built copy); without it the
  download answers `quick_support_not_built`. The exe is **not Authenticode-signed** (the binding is
  signed, the file is not), so SmartScreen may warn; the page says so.
- **Microsoft Store version** (2026-11-25, `docs/operations/microsoft-store.md`): a Store package is the
  same file for everybody and cannot carry a trailer, so **Copy Microsoft Store link** (technicians,
  `GET /fleet/quick-support/link?site_id=`, `Cache-Control: no-store`, audited
  `fleet.quick_support_link_issued`) gives the same signed binding as
  `nigafiy-support:qs1/<base64url of the trailer JSON>`. The package registers that scheme; opening the
  link starts Quick Support, which checks the signature exactly as for the trailer
  (`internal/quicksupport/link.go`). Started from the Start menu without a link, it says where to get one.
  The packaged program never deletes itself (the package owns the file); its screen says to remove it
  in Settings > Apps. Everything else (code, PIN, Support profile, consent) is unchanged.

### Refusal codes (English and Arabic in `policy-text.ts`)
`not_session_holder`, `profile_forbids_restart`, `restart_in_progress`, `safe_mode_needs_service`,
`safe_mode_windows_only`, `user_session_windows_only`, `user_session_needs_service`,
`user_session_unknown`, `quick_support_needs_code`, `quick_support_no_restart`, `quick_support_limited`,
`quick_support_code_unknown`, `quick_support_wrong_pin`, `quick_support_locked`, `quick_support_expired`,
`quick_support_link_invalid`, `quick_support_not_built`, `quick_support_busy`, `help_request_closed`,
`too_many_help_requests`, `too_many_tags`.

### Audit
`fleet.tags_changed`, `fleet.bulk_action`, `fleet.help_requested`, `fleet.help_session_started`,
`fleet.help_closed`, `fleet.restart_requested`, `fleet.restarting`, `fleet.restart_failed`,
`fleet.restart_agent_back`, `fleet.restart_timeout`, `fleet.session_resumed`, `fleet.safe_boot_cleared`,
`fleet.safe_boot_clear_failed`, `fleet.quick_support_downloaded`, `fleet.quick_support_registered`,
`fleet.quick_support_connected`, `fleet.quick_support_failed`, `fleet.quick_support_link_issued`. Notes, typed text and PINs are never in
the audit.

### What ran for real, and what did not
- **Ran for real on this Windows desktop:** the tray icon (opt-in Go test `NIGAFIY_UI_TEST=1`: add,
  update, balloon, remove) and `WTSEnumerateSessions` (listed the one signed-in session).
- **Tests only:**
  - API tests against embedded PostgreSQL (`fleet-reach.test.ts`): Nigafiy IDs, resolve and Hub search,
    tags, favourites, filters, bulk results, unattended end to end, help requests, user-session checks,
    restart (safe mode resume, clear, timeout, failure), Quick Support (binding signature, link tamper,
    register, PIN lockout, Support cap, limited commands, one-time PIN, end and revoke, expiry, close,
    download 200/503)
  - Go tests with fakes: safe boot set/clear/rollback (a fake runner: **no bcdedit, reg or restart ran**),
    restart commands, help request from the tray, session targeting, the Quick Support binding, proof,
    status and its command list
  - web type-check and build
- **Never run here:** `bcdedit`, a restart, the service install, the sign-in-screen helper, another
  user's session, a real Quick Support session from a downloaded exe, the new web UI in a browser.

## Built: shell, scripts and jobs (2026-11-24)

Builder F4, branch `worktree-fleet-pro`, migration `042_fleet_shell_scripts_jobs.sql`. API in
`apps/api/src/modules/endpoints/fleet-shell/` and `fleet-jobs/`; agent in `internal/shell`,
`internal/scripts`, `internal/agent/{shell,jobs}.go`, `internal/desktop/bannermux.go`, `internal/tray`;
web in `apps/web/features/endpoints/components/fleet-shell/`, `components/fleet-jobs/` and the new pages
**Fleet → Scripts** (`/fleet/scripts`), **Fleet → Jobs** (`/fleet/jobs`), the job page
(`/fleet/jobs/<id>`), the **Remote shell** tab on the endpoint page and the transcript page
(`/fleet/endpoints/<id>/shell/<shellId>`).

New web dependencies: `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 (the terminal, loaded only on
the shell tab and the transcript page). No new Go module.

### Remote shell
- **Who and when.** Admins and owners only (`shell_admin_only`; technicians get the refusal audited,
  viewers are stopped at the door). The computer's **group** must switch it on (`shell_enabled`, off by
  default; with no group the organization default has no shell: `shell_disabled_by_policy`). Then the
  group's access policy runs exactly as for a session (hours, IP list, operator roles, MFA step-up,
  approval), and the chosen permission profile, clamped by the group's maximum, must have the
  **shell** flag (`profile_forbids_shell`). Quick Support computers never allow it
  (`quick_support_limited`). At most 3 open shells per computer (`too_many_shells`); the computer must
  be online (`endpoint_offline`). A reason is required.
- **The terminal.** Windows: Windows PowerShell in a **pseudo console** (ConPTY through
  `golang.org/x/sys`, Windows 10 1809+): colours, line editing, tab completion and full-screen programs
  work; the shell and everything it starts sit in a job object killed with it. Linux: the user's
  `$SHELL` (else `/bin/sh`) on a pseudo terminal from `/dev/ptmx` as its own session (job control,
  Ctrl+C). macOS: **pipes** (commands and output work; no line editing, job control, resize or full-screen
  programs), because opening a pty on macOS needs `grantpt`/`unlockpt` from libc, which pure Go without
  cgo cannot call. The operator's terminal is xterm.js; keystrokes go out as binary WebSocket messages,
  output comes back the same way, resizes as JSON.
- **Transport.** `shell_open` reaches the agent over the existing command channel; the agent dials
  `/api/v1/agent/shell?shell=<id>` and the operator's browser `/api/v1/endpoints/<id>/shell/stream`
  (cookie, same origin, the operator who opened it only). Several API instances relay through
  `pg_notify`, as the session stream does.
- **Transcript.** Every chunk of input, output and event (opened by, resized, ended) is sealed with
  AES-256-GCM under the shell's own key; the AAD binds the chunk to its shell, position and direction,
  so chunks cannot be moved or swapped. The key is sealed with `APP_ENCRYPTION_KEY` in
  `fleet_shell_sessions.transcript_key_sealed` (listed in `ops/sealed-columns.ts`, re-sealed by
  `rotate-key`) and never returned by any API. The audit rows `fleet.shell_opened`/`fleet.shell_closed`
  link to the transcript page; reading it is admins only and audited (`fleet.shell_transcript_viewed`).
  **The plain audit never holds a keystroke or a line of output**; only byte counts.
- **Limits.** Idle timeout per group (`shell_idle_timeout_minutes`, default 15, 1–240): no input and no
  output ends it (agent watch, and the API sweep if no instance is watching). Transcript limit 32 MiB:
  the shell ends rather than run unrecorded (`limit`). An agent that never connects ends as `open_failed`.
- **Transparency (follows the group's banner).** With `banner_mode` `shown` or `minimized` (and always
  in an attended group), while a shell is open, the agent's banner says
  **"Shell open by [operator]"** with the reason (one banner names every open shell and session), with
  **End** and Ctrl+Alt+Shift+E; ending it tells the API first so the reason is `user`. The tray's
  **IT activity** list shows the shell (operator, reason, start, end) for 30 days, beside sessions and jobs.
  With `banner_mode: off` the shell is not named on screen; its transcript and audit rows are kept.
- **End reasons:** `operator`, `user`, `idle`, `limit`, `exited` (with the exit code), `open_failed`,
  `agent_gone`, `revoked`.

### Scripts library
- PowerShell (Windows) or `/bin/sh` (Linux, macOS) scripts, one OS per script. Admins create, edit,
  archive and restore (`fleet.script_created|updated|archived|restored`); the audit keeps the body's
  SHA-256 and the parameter names and types, never the body.
- **Versions:** a new body, parameters or timeout makes a new version (with an optional note); name,
  description and the technician mark keep it. Every version stays readable; a job records the version
  it runs.
- **Typed parameters** (up to 20): `string` (max length), `int` (min/max), `bool`, `choice` (listed
  values), required or with a default, names `^[A-Za-z][A-Za-z0-9_]{0,39}$`, unique without case. The
  server checks every value against the declaration and lists every problem (`invalid_parameters`).
- **Passed as data, never pasted into the script.** Each value goes into an environment variable
  `NIGAFIY_PARAM_<NAME>` of the script's process only. On Windows a generated launcher (which holds only
  parameter names and the file path) converts each by its declared type and splats them onto the saved
  script file, so the script's own `param()` block binds them; `sh` scripts read `"$NIGAFIY_PARAM_<NAME>"`.
  Quotes, `$(...)`, backticks, `;` or newlines in a value are just characters (Go test and the real-agent
  test with a hostile value).
- **Technicians** see and run only scripts an admin marked **Technicians may run it**
  (`script_not_runnable_by_technicians`); viewers have no access to scripts or jobs.

### Jobs
- **Target:** one computer, a selection (the address book's bulk bar **Run job**, or computers chosen in
  the dialog) or a group (resolved at each run). Computers of another OS are listed as skipped.
- **When:** now; once at a time (not in the past, at most a year ahead); or recurring hourly (at a
  minute), daily, weekly (chosen days) or monthly (day 1–28) at a wall-clock time in a **time zone**
  (default: the site's zone of the first computer; daylight-saving gaps move forward, repeated times
  take the first). Missed occurrences while the server was down give **one** run, then the next time
  after now.
- **Maintenance windows (optional):** a computer outside its site's window waits for it, until the run
  expires.
- **Offline computers** wait (`waiting for the computer to come online`) and run when they return,
  until the run's **expiry** (5 minutes to 30 days, default 1 day); then they are `expired`.
- **Results per computer:** state, exit code, duration, stdout and stderr previews (8 KiB shown, the
  full copy downloadable as a text file, `fleet.job_output_downloaded`), with a note when the agent
  capped a stream at 1 MiB. The script stops at its timeout or on cancel together with every process it
  started (a Windows job object; a process group elsewhere). A queued script whose agent never answers
  fails after its timeout.
- **Rerun failed** (failed, expired or cancelled computers of a run), **Run now** on a scheduled job,
  **Pause/Resume** a recurring job, **Cancel** (waiting computers are cancelled, an undelivered command is
  withdrawn, a running script gets `script_cancel`). Admins manage every job; a technician manages only
  the jobs they created, and only while the script is still marked for technicians (`job_not_yours`).
- **Audit:** `fleet.job_created`, `fleet.job_run_started`, `fleet.job_dispatched`, `fleet.job_result`,
  `fleet.job_run_now`, `fleet.job_rerun`, `fleet.job_paused`, `fleet.job_resumed`, `fleet.job_cancelled`,
  `fleet.job_output_downloaded`. Parameter values and output are never in the audit; output is not kept
  on the command row either.

### Refusal codes (English and Arabic in `jobs-text.ts`)
`shell_admin_only`, `shell_disabled_by_policy`, `profile_forbids_shell`, `quick_support_limited`,
`endpoint_offline`, `too_many_shells`, `shell_closed`, `not_shell_operator`, `invalid_parameters`,
`script_name_taken`, `script_archived`, `script_not_runnable_by_technicians`, `run_at_in_past`,
`run_at_too_far`, `nothing_to_rerun`, `job_cancelled`, `job_not_yours`, `job_state`; the access-policy
codes come from `policy-text.ts`.

### What ran for real, and what did not
- **Ran for real on this Windows desktop** (`real-agent-shell-jobs.test.ts`, the compiled agent against
  the API on 127.0.0.1): Windows PowerShell opened over a real **ConPTY**, a command typed through the
  WebSocket ran and its output came back, `exit 4` ended the shell with exit code 4, the transcript had
  the command and the audit did not, and the real banner showed for those seconds. Then a script job ran
  through the agent with a hostile parameter value
  (`'; Remove-Item …; $(whoami) … & echo pwned`) which came back as data, never as code. The Go tests
  `TestRealTerminal` (ConPTY) and the scripts package's real PowerShell runs (hostile values, timeout
  and cancel stopping the process tree) ran here too.
- **Tests only:** API tests against embedded PostgreSQL (`fleet-shell.test.ts`, `fleet-jobs.test.ts`):
  every refusal (role, group switch, profile, policy MFA, Quick Support, three shells), relay across two
  API instances, sealed transcript and plain audit, every end reason, IT activity; script versions and
  roles, parameter validation and order, run now, results and full output, offline catch-up and expiry,
  missed recurring occurrences, maintenance windows, rerun, cancel, pause, technician ownership,
  organization isolation; schedule maths across daylight saving. Go tests with fakes for the shell
  manager, the banner and the tray's IT activity. Web type-check and build.
- **Never run here:** the Linux pty and the macOS pipes on real machines (compiled and vetted for
  `linux` and `darwin` only), the web pages in a browser against a running API (shell tab, Scripts, Jobs,
  job page, transcript replay), a scheduled job firing from the module timer in a long-running server
  (the scheduler function is tested directly), and a maintenance window on a real site.

## Built: patches, monitoring, inventory (2026-11-24)

Builder F5, branch `worktree-fleet-pro`, migration `043_fleet_patches_monitoring.sql`. One migration
covers this whole wave: inventory columns, patch status, catalog, approvals, policies and installs,
monitoring rules and states, and the tray's recording links.

Where the code is:
- API: `apps/api/src/modules/endpoints/fleet-patches/`, `fleet-monitoring/` and `fleet-inventory/`.
- Agent: `internal/patch`, `internal/monitor`, `internal/sysinfo/{hardware,localadmins}.go` and
  `internal/agent/{patch,hardware}.go`.
- Web: the pages **Fleet → Patches** (`/fleet/patches`) and **Fleet → Monitoring** (`/fleet/monitoring`),
  and the endpoint tabs **Patches** and **Hardware & licences**.

No new Go module and no new web dependency.

### Patches
- **What the agent reads.**
  - Windows: the Windows Update Agent COM API (`Microsoft.Update.Session`), driven from pure Go over raw
    `IDispatch` (ole32 and oleaut32, no cgo). It searches `IsInstalled=0 and IsHidden=0`. It reads the
    classification from the WUA category IDs (security, critical, definition, update rollup, feature
    pack, driver, other), plus the KB, size, severity and reboot behaviour.
  - Linux: `apt` (a simulated upgrade, with the security pocket labelled), or `dnf check-update` and
    `updateinfo`.
  - macOS: `softwareupdate --list`.
  - Every update carries its **source** label (`wua`, `apt`, `dnf`, `softwareupdate`) in the API and on
    screen.
  - The scan runs 90 s after start, then every 6 hours, and whenever IT presses **Scan now**
    (technician).
- **Approvals.** Nothing installs unless it is approved, in one of two ways:
  - An admin approves each update, for the whole organization or for one group.
  - The policy's auto-approve classifications cover it.

  Approval details come from what the agents reported, never from the request.
- **Windows.**
  - Each group has a policy. A computer without one uses the organization default; with neither,
    patching is disabled.
  - The window is either the site's maintenance window (an occurrence from migration 019) or the
    group's own weekly window (weekdays, start time, length, time zone).
  - The scheduler runs as a job every 30 s (lock `727173`). Inside the window it sends one
    `patch_install` to each computer, carrying only the approved updates. A computer runs one install at
    a time.
- **Reboot policy.**
  - `never`: the restart is marked pending and the computer is never restarted.
  - `ask`: the person chooses Restart now or Later. They can postpone up to `max_postponements` times,
    `postpone_minutes` each; at `reboot_deadline_hours` the restart is forced. When nobody is signed in,
    or nobody answers, the restart happens at the deadline only.
  - `force`: the computer restarts at the end of the window, with a visible notice.

  The restart questions go through the desktop helper. The restart itself is
  `shutdown /r /t <notice>` with a message.
- **History.**
  - Each install keeps the updates as they were approved, the result and HRESULT of each update, the
    window, the reboot state and the postponements.
  - Installs appear in Fleet → Patches → Installs, on the endpoint's Patches tab and in the person's IT
    activity.
  - Approvals, policy changes, scans, cancels and every install are audited.
- Delivered `patch_install`, `patch_reboot_prompt` and `script_run` commands are no longer expired by
  the 10-minute stale-command sweep. Their own jobs time them out.

### Monitoring rules
- **Kinds.**
  - `cpu` and `memory`: percent, breaching above the threshold.
  - `disk_free`: percent or GB, breaching below the threshold, for one volume or all of them.
  - `service`: the service is not running.
  - `event_log`: at least N matching Windows event log or journal entries within a time window. Entries
    match by log, source, IDs, level and text.
- **Breach and recovery.**
  - Each rule has a duration. A breach that lasts that long raises a Watch event and an `endpoint`
    incident, correlated per rule and computer.
  - The first healthy measurement resolves it.
  - "Not measured" never raises or resolves anything.
- **Who can do what.** A rule applies to one group or to the whole organization. Admins write;
  technicians and viewers read. Every change is audited.

### Inventory
- The agent collects every 6 hours, and on refresh:
  - CPUs and memory modules
  - system, board and BIOS details, with serials
  - licences seen: the Windows activation state and edition, and Office when its licensing service
    reports it
  - physical disks, with health and reliability counters
  - batteries: design capacity against full-charge capacity, and cycle count
- Anything it could not measure is listed with the reason.
- **Product keys are never read.** The licensing query asks only for the name, description and status.

### Compliance: local administrators
- The agent lists the members of the administrators group, by name only:
  - Windows: the well-known SID S-1-5-32-544, with an ADSI fallback.
  - Linux: the `sudo`, `wheel` and `admin` groups.
  - macOS: the `admin` group.
- The API judges them against the policy's `allowed_local_admins`. Without that list they are shown as
  information.
- If the agent cannot read the list, the result is "not measured" with the reason, never "pass".

### What ran for real, and what did not
- **Ran for real on this Windows desktop:**
  - A read-only WUA search. It found 3 updates (a definition and two drivers) and reported
    `install_supported=false` because the test was not elevated. Nothing was installed.
  - The live hardware read: CPU, memory modules, disks, and licences without keys.
- **Tests only:**
  - API tests against embedded PostgreSQL: `fleet-patches.test.ts`, `fleet-monitoring.test.ts` and
    `fleet-inventory.test.ts`.
  - Go tests with parsers and fakes for apt, dnf, softwareupdate, the WUA results, the reboot prompt and
    the monitor probes.
- **Never run here:**
  - A real update install or restart. This is on purpose: nothing is installed on this PC.
  - apt, dnf and softwareupdate on real machines.
  - The new pages in a browser against a running API.
  - The scheduler inside a real maintenance window.

## Built: the user's side (2026-11-24)

Builder F5, same branch and migration `043`.

Where the code is:
- Agent: `internal/tray`, `internal/desktop/{tray,openurl}.go`, `internal/agent/usertray.go`,
  `internal/rdstream` and `internal/filemgr`.
- API: `apps/api/src/modules/endpoints/fleet-user/`, and `fleet-shell/shells.ts` for IT activity.
- Web: `apps/web/app/recording-view/[token]` and `components/remote-files/`.

### Tray
- **Always present.** Request help, IT activity…, End current session, the Nigafiy ID and About. No
  policy or group setting can hide the tray: the group schema refuses unknown fields such as
  `tray_hidden`, and a test pins that.
- **IT activity** lists the last 30 days, each entry with who and when:
  - remote sessions
  - shells
  - script jobs
  - **file transfers**: file manager uploads and downloads (one line per file per hour), and files sent
    or received during a session
  - **update installs**: which KBs, and in which window
- **End current session** ends the remote session exactly as the banner's End button (or
  Ctrl+Alt+Shift+E) does, then ends every remote shell. It is grayed out when nothing is open.
- **Past recordings…** appears only when the computer's group has `user_may_view_recordings`:
  - The agent lists this computer's recordings, and the person types the number of the one to watch.
  - The API creates a link. Its token is stored only as a SHA-256 hash. The link must be opened within
    15 minutes, and plays for 4 hours once opened.
  - The API re-checks the group on every request: 403 when the permission was withdrawn, 410 when the
    link expired.
  - The link and its first opening are audited (`fleet.recording_user_link`,
    `fleet.recording_viewed_by_user`).
  - The agent opens only an http(s) page on its own server whose path starts with `/recording-view/`.
  - The player page (EN and AR) needs no sign-in and can reach only that one recording.

### Two-pane file manager
- **Layout.**
  - **This browser** on one side: pick or drop files to send. Files copied from the computer are listed
    here too, with Save again.
  - **The computer** on the other side: the full existing manager (volumes, search, new folder or file,
    rename, copy, cut and paste, delete).
  - A **transfer queue** below.
- **Nothing about access changed.** Transfers run one at a time, in 256 KiB chunks, through the same
  `fs_op` commands, so the existing controls all still apply:
  - the agent's allowed roots and its protected and credential path guards
  - the roles: uploading needs admin, copying needs technician, viewers can only browse
  - the overwrite confirmation dialog
  - the per-chunk audit, which records path and size, never contents
- **Pause and resume.**
  - A lost connection, a timeout or an offline agent leaves the transfer *interrupted* at the last chunk
    that arrived.
  - A download resumes from its offset.
  - An upload asks the agent where its own upload stopped, using the new read-only `fs_op` `hash`, and
    continues from there. If the agent cannot continue (it restarted, or the file changed), the upload
    starts again from the beginning, but only after the operator confirms replacing the partial file.
- **Links swapped in after the check (EXT-8, R-7).** The agent runs as LocalSystem / root, so a local
  user could swap a folder for a junction or symbolic link between the path check and the action.
  - Reads, writes, creates and hashes go through a file handle whose real location is checked.
  - New folder, rename, move and delete (recursive too), listing, search and copying folders open
    the folder without following links, check its real location against the allowed roots and the
    protected locations, and act relative to that handle. A rename or move never replaces an
    existing name. A delete removes a link itself, never what it points at.
  - A swap is refused with an error; nothing outside the allowed roots is shown, changed or deleted.
  - Windows race tests ran here (with junctions); Linux tests run in CI; macOS tests never ran.
- **SHA-256 check.**
  - Uploads: the browser hashes the file and the agent checks the whole file on the last chunk. The
    browser's hash is incremental, in pure TypeScript, so it also works on plain-HTTP origins.
  - Downloads: the browser hashes what arrived and compares it with the agent's `hash` of the file. A
    file that does not match is never saved.

### What ran for real, and what did not
- **Tests only:**
  - `fleet-user.test.ts`, covering:
    - the tray flag
    - refusal when the group does not allow recordings
    - the hashed token
    - 409 before the link is opened, 410 after it expires, 403 once the permission is withdrawn
    - refusal of another computer's recording
    - the audit
    - the IT activity lines
    - the `hash` op's roles and audit
  - Go tests for:
    - the tray menu (the transparency items are always there) and the IT activity text
    - ending a session from the tray
    - the rules for opening URLs
    - upload resume and hashing
  - Web unit tests for the SHA-256 hash (compared against `node:crypto`) and the resume rules.
- **Never run here:**
  - The tray menu clicked on a real desktop.
  - A browser opening a recording link.
  - The player page and the two-pane manager in a browser against a running API and agent.

## WebRTC video (2026-11-25)

Owner decision (2026-11-25): the picture becomes smooth video (H.264 over WebRTC) instead of JPEG
tiles over the WebSocket. Builder W1, branch `worktree-webrtc`. The WebSocket + JPEG path stays, and
it is the automatic fallback: nothing in it was removed.

### Design
- **LAN first, no relay.** The browser and the agent form one direct peer connection on the LAN with
  host candidates only. There is no TURN relay, and no public STUN server is used by default. An
  administrator may set one or more STUN URLs (`RD_WEBRTC_STUN_URLS`, `stun:`/`stuns:` only, empty by
  default). TURN is deliberately not offered: a relay would carry the picture through a third
  machine, and the product rule is LAN-first. Where no direct path exists, the session uses the
  JPEG path, which already works through the API.
- **Signalling over what exists.** No new socket and no new port on the API. The operator's browser
  sends `rtc_offer` (SDP), `rtc_ice`, `rtc_active`, `rtc_fallback` and `rtc_close` on its existing
  stream socket. The hub checks them and relays them to the agent's existing stream socket (or over
  the peer link to the instance that holds it). The agent answers with `rtc_answer`, `rtc_ice` and
  `rtc_state`. Each message carries the viewer's routing id the way clipboard requests do
  (`req = "<viewer sink>.rtc"`), so an answer reaches only the browser that asked. SDP and ICE
  candidates are validated with zod (size caps, `v=0` SDP, candidate grammar) and are not audited
  themselves (they hold LAN addresses only); every decision about them is.
- **Who offers.** The browser makes the offer: one receive-only video transceiver (H.264) and one
  ordered, reliable data channel `input`. The agent answers with one send-only H.264 track.
- **Checked before any offer is relayed** (hub, then again on the instance holding the agent):
  the session is `active` (consent, refuse window and approval are behind it); the viewer is still a
  participant with `view`; the agent's hello says `webrtc.supported`; WebRTC is not switched off on
  the API (`RD_WEBRTC=off`); and the session is not being recorded (see Recording). A refusal goes back
  as `rtc_refused` with a code and is audited as `fleet.session_transport` (`event: refused`).
- **Input on the data channel** uses the same rules as the socket path. The agent accepts an event
  only when the session's profile has `control`, the session was opened with control, and the
  permissions the hub attached to that viewer's offer (the participant's own, narrower for a
  view-only colleague) have `control`. The hub sends `rtc_perms` whenever a participant's permissions
  change (hand-over, invitation change), and `rtc_close` when the viewer leaves or is removed, so the
  agent drops that peer. Events are validated by the agent with the same kinds, ranges and key
  allow-list as before (`remotedesktop.ValidateInput`). Because the API does not see these events,
  the agent reports every event except pointer moves on the socket as `rtc_input` (kind, button,
  display; never a key, a code or text), and the hub writes `endpoint.rd_input` with `via: webrtc`
  exactly as it does for the socket path. Clipboard, chat, tools and settings stay on the socket.
- **Fallback rules.** The viewer stays on (or goes back to) JPEG when: the agent does not offer
  WebRTC (Linux, macOS, an agent older than this, `RD_WEBRTC=off`), the browser has no
  `RTCPeerConnection` or cannot decode H.264, the offer is refused, no answer comes within 8 s, no
  video frame is decoded within 10 s, ICE reaches `failed` or `disconnected` for 5 s, the agent's
  encoder fails (`rtc_state failed`, with the reason), or recording is switched on. The browser sends
  `rtc_fallback` with the reason; the hub audits it (`fleet.session_transport`, `mode: jpeg`) and
  counts the viewer as a JPEG viewer again, so the agent sends it frames (a full frame first). The
  JPEG path keeps its own fallback to HTTP frames.
- **Counting viewers.** Once a viewer sends `rtc_active` (the first video frame was decoded), the hub
  stops counting it in `viewers`, so the agent does not encode JPEG for it. When every viewer is on
  WebRTC the JPEG encoder idles.
- **Agent encoder.** H.264 through Windows Media Foundation's built-in encoder MFT, called through
  COM with `golang.org/x/sys/windows` and `syscall` (pure Go, no cgo). A hardware encoder is tried
  first; the Microsoft software encoder is next. Windows N editions without the Media Feature Pack
  have no encoder: the agent then says `webrtc.supported: false` with the reason, and the viewer
  uses JPEG. An encoder that fails during a session ends that peer with `rtc_state failed`. The
  picture is converted to NV12 in Go. One encoder per session feeds every WebRTC viewer of that
  session; a new viewer or a picture-loss report (PLI) asks for a key frame.
- **Capture (since 1.0.8).** DXGI Desktop Duplication: the desktop the compositor already drew,
  one GPU copy into a CPU-readable texture, about 3 ms for 1080p instead of GDI's 27 ms (23 of them
  BitBlt reading the screen back). Same pixels as GDI (checked byte for byte). The next screen is
  read while the current one is scaled and encoded, and row work (colour swap, scaling, NV12) is
  split across the cores. GDI takes over for a picture DXGI cannot give (a rotated screen, the UAC
  desktop, a mode change, Windows 7) and DXGI is tried again 5 s later; `NIGAFIY_RD_GDI=1` turns
  DXGI off. Measured on a 1080p PC with Quick Sync: a changing screen took 76 ms a picture before
  (13 fps), about 4 ms after.
- **Caps and quality.** Frame rate up to 60 fps (`MaxFPS`, the operator may ask for less; an
  unchanged screen is not encoded), a longest edge of 1920 px. The video is full size while the
  bitrate is at least 2 Mbit/s, 75 % below that and 50 % below 0.9 Mbit/s; the console's 75 % scale
  default is for JPEG and does not shrink video, but a chosen 50 % is kept. The bitrate starts at
  2.5 Mbit/s and follows the RTCP receiver reports and the round trip of every viewer: more than 10 %
  loss (or a slow round trip, high jitter, a burst of picture-loss reports) steps it down by a fifth,
  less than 2 % loss on a quick link lets it climb by a tenth, between 300 kbit/s and 12 Mbit/s; a
  round trip over 80 ms caps it lower (5, 2.5 and 1.2 Mbit/s at 80, 140 and 220 ms).
- **Several monitors.** The display choice (`settings`) is the same as for JPEG. A different display
  or size restarts the encoder at a key frame; the browser's video element follows the new size.
- **Linux and macOS** keep the JPEG path. A pure-Go H.264 encoder does not exist, and the platform
  encoders (VA-API, VideoToolbox) are C APIs that need cgo, which this build does not have.

### How every existing guarantee survives
| Guarantee | With WebRTC |
| --- | --- |
| Consent dialog, refuse window, second-admin approval | Unchanged. An offer is relayed only while the session is `active`, which happens only after them. |
| Access policy, MFA step-up, IP allow-list, hours | Unchanged at session start and at join. The offer check re-reads participation and `view`. |
| Operator banner, recording mark | Unchanged: shown by the agent for the session, whatever the transport. |
| Privacy screen | Unchanged: the video encoder reads the same capture as JPEG, and the privacy window is excluded from capture the same way. |
| View-only colleagues | Their offer carries `control: false`; the agent drops their data-channel input. |
| End hotkey (Ctrl+Alt+Shift+E), End on the banner, session end | Closing the session closes every peer connection on the agent before the banner goes. |
| Removed colleague | Their socket closes (4003) and the hub sends `rtc_close`, so their peer is closed. |
| Audit | `fleet.session_transport` for offer refused, WebRTC started (encoder), fallback (reason) and WebRTC stopped; `endpoint.rd_input` (`via: webrtc`) for every input except pointer moves; `fleet_sessions.transport` becomes `webrtc` and keeps the encoder and the last fallback reason (migration `044`). |

### Recording
The API cannot see a direct peer stream. **Choice: the server path stays for recorded sessions.**
While a session is being recorded (rule `required`, or the holder switched recording on), the hub
refuses every offer with `webrtc_recording_active`. When recording is switched on during a WebRTC
session, the hub sends `rtc_close` to the agent and `rtc_closed` (reason `recording`) to every
WebRTC viewer, counts them as JPEG viewers again and asks for a full frame, so the recording gets
the picture. A required recording is never dropped. Recording on the agent was not chosen: it would
need a second encrypted writer and upload path, and a recording that fails on the agent would be
noticed only after the session.

### Built: WebRTC video (2026-11-25, builder W1)
What exists now, against the design above.

- **Agent** (`internal/videoenc`, `internal/remotedesktop/video.go`, `validate.go`,
  `internal/desktop/video.go`, `internal/rdstream/webrtc.go`). New pure-Go modules, pinned in
  `go.mod`: `github.com/pion/webrtc/v4 v4.2.26` with `pion/interceptor v0.1.51`, `pion/rtcp v1.2.20`,
  `pion/rtp v1.10.6` and their pion dependencies (datachannel, dtls/v3, ice/v4, logging, mdns/v2,
  randutil, sctp, sdp/v3, srtp/v3, stun/v4, transport/v5, turn/v5), `google/uuid`, `wlynxg/anet`,
  `golang.org/x/{crypto,net,time}`. No cgo. The H.264 encoder is the Media Foundation encoder MFT
  through COM vtables (`mf_windows.go`, calling conventions for amd64, 386 and arm64): hardware MFT
  first (asynchronous MFTs through their event generator), the Microsoft software MFT next, a
  hardware encoder that fails mid-stream is replaced by the software one (`encoder_changed`), and
  three failed grabs in a row end every peer with `rtc_state failed encoder_failed` so the browsers
  go back to JPEG. Encoder sizes follow the operator's scale and a 1920 px longest edge; the bitrate
  follows RTCP loss (`NextBitrate`); an unchanged screen is encoded again once a second; PLI/FIR and
  a new viewer ask for a key frame (SPS/PPS in front). The encoder runs where the capture runs (in
  the user-session helper for the service; only H.264 crosses the helper pipe). The hello says
  `webrtc: {supported, encoder | reason}`; `NIGAFIY_AGENT_RD_WEBRTC=off` switches it off on one
  computer. Data-channel input passes the same checks as the socket path (session control, profile
  control, the viewer's own control from the API, `remotedesktop.ValidateInput` = the API's rd_input
  schema) and is reported as `rtc_input` without keys or text. Review fixes over the first draft:
  the real agent wraps its desktop in `BannerMux`, which hid the video source, so WebRTC would never
  have been offered (`BannerMux` now passes it through); candidates the browser trickles before its
  offer is answered are kept and applied.
- **API** (`stream-hub.ts`, migration `044_fleet_session_webrtc.sql`). Signalling messages on the
  existing sockets and over the peer link between instances; offers checked on the operator's
  instance (`RD_WEBRTC`, session active, the viewer's `view`, recording, the agent's hello) and again
  on the instance holding the agent; refusals as `rtc_refused`. The browser cannot choose its
  routing id, its control or the STUN list. A WebRTC viewer is not counted for JPEG and gets no JPEG
  frames; a fallback counts it again with a full frame. Recording switched on moves every WebRTC
  viewer back (`rtc_closed`, reason `recording`); a hand-over or narrower invitation sends
  `rtc_perms`; a viewer leaving sends `rtc_close`. Audit: `fleet.session_transport` (refused,
  started with the encoder, fallback with the reason, stopped), `endpoint.rd_input` with
  `via: webrtc`, `fleet.session_refused_action` with `via: webrtc`. `fleet_sessions.transport` becomes
  `webrtc` (an agent reconnecting no longer rewrites it), with `rtc_encoder`, `rtc_started_at`,
  `rtc_fallback_reason`. Offers, answers and candidates are never stored or audited.
  `RD_WEBRTC_STUN_URLS` accepts `stun:`/`stuns:` only (at most 4). The capability is per endpoint
  and per session: it comes in each agent hello, not from a stored flag.
- **Web** (`use-webrtc-video.ts`, console). `RTCPeerConnection` with a receive-only H.264
  transceiver and the `input` data channel; decoded frames are drawn on the console canvas, so the
  drawing layer, monitor windows and pointer handlers are unchanged. Every fallback rule of the
  design is implemented (no `RTCPeerConnection`, no H.264 decoder, refused, 8 s answer, 10 s video,
  ICE failed or disconnected 5 s, encoder failed, recording). The bar shows "WebRTC video" or
  "Compatibility mode (JPEG)", the reason after a fallback with "Try WebRTC again", a "Smooth video"
  switch, and fps / kb/s measured by the browser (`getStats`) with the agent's target bitrate, loss
  and encoder. EN + AR; light and dark use the existing tokens.

**What ran for real on this PC (no elevation):** the Media Foundation encoder, hardware (Intel Quick
Sync Video H.264 Encoder MFT) and software (H264 Encoder MFT), encoding synthetic pictures
(`NIGAFIY_MF_TEST=1 go test ./internal/videoenc`) and one real DXGI capture of this 1920x1080
screen (`TestVideoGrabRealScreen`: key frame with SPS/PPS/IDR, about 130 KB; the first hardware
encode took about 1.1 s while the MFT warmed up). A pion browser stand-in and the agent's answerer
connected over 127.0.0.1 inside one Go test: H.264 RTP depacketized to SPS, PPS, IDR; data-channel
input applied and refused per permission; the peer closed when the session ended.
**Tests only:** the API signalling, policy refusals, recording rule, hand-over and audit
(`apps/api/tests/fleet-webrtc.test.ts`, real PostgreSQL and two hub instances, sockets standing in
for the browser and the agent). **Never run:** a real browser receiving the agent's video, and any
connection between two computers. There is no second computer here, and no browser was pointed at
a running agent; the web viewer is type-checked and built only. A Windows N edition without the
Media Feature Pack (the agent then reports the reason and stays on JPEG) was not available either.
**Update (2026-11-25, builder EMU):** a real Chromium has since received the real agent's video on
this one PC (frames decoded, input over the data channel, the `RD_WEBRTC=off` fallback). Between two
computers it is still never run. Candidates, firewall, STUN/TURN and owner steps for a LAN are in
`webrtc-networking.md`.

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
