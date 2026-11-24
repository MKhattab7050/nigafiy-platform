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
`fleet.quick_support_connected`, `fleet.quick_support_failed`. Notes, typed text and PINs are never in
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
