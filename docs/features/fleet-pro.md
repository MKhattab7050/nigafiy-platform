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
| Remote desktop: multi-monitor list, JPEG frames (quality 25–95, scale), mouse/keyboard/text input | `agents/endpoint-agent/internal/remotedesktop`, `rd_capture`/`rd_input` | Built, frame-by-frame over commands |
| Session start with operator + reason, consent policy, on-screen notice, audit | `apps/api/src/modules/endpoints/remote-desktop` | Built |
| File manager: browse, chunked SHA-256 transfers, guarded paths, delete with confirm | `internal/filemgr`, `modules/endpoints/file-manager` | Built |
| Processes, services, software (install/remove), logs, power (lock/logoff/restart/shutdown), notify user, diagnostic commands (allow-listed) | `internal/control` | Built |
| Enrollment, groups/fleet, policy, compliance | `modules/endpoints/{enrollment,fleet,policy}` | Built |
| Wake-on-LAN | `collectors/lan-collector/internal/wol` | Built (Sensor side) |
| Operator MFA, team accounts and roles | `modules/auth/mfa.ts`, migration `018` | Built |

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
