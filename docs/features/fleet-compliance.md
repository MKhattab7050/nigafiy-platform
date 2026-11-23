# Nigafiy Fleet: evidence-based compliance and remote-admin gaps

Status: built 2026-11-22 on branch `worktree-agent-a200650ca4703c0c6`. No migration (evidence lives in
the existing `endpoints.security` JSONB column). Linux and macOS code was cross-compiled and unit-tested
with documented output samples only; it has **not** run on a real Linux or Mac.

## 1. Evidence-only compliance

Verdicts: `compliant` / `attention` / `non_compliant` / `unknown`. An endpoint is `compliant` only when
every item its platform requires was **measured** and passed. An item with no measurement is `unknown`
with the reason; a single `unknown` keeps the endpoint out of `compliant`. Severity order:
`non_compliant` > `attention` > `unknown` > `compliant`.

### Agent (`agents/endpoint-agent/internal/sysinfo/compliance.go`, parsers in `compliance_parse.go`)

Each piece of evidence carries `check`, `subject`, `state` (`pass`/`fail`/`warn`/`unknown`/`info`),
`value` (what the command printed, summarised), `source` (the command), `measured_at`, optional `reason`
and `count`. `info` is context only and is never judged. Fast checks refresh every 10 minutes, the update
search every 6 hours (30 minutes after a failed search); neither blocks the heartbeat.

| Platform | Item | Source | Notes |
| --- | --- | --- | --- |
| Windows | Firewall, each of Domain / Private / Public | `Get-NetFirewallProfile -PolicyStore ActiveStore`, registry `FirewallPolicy\<profile>\EnableFirewall` fallback | A profile not reported is `unknown`, never "off" |
| Windows | Antivirus, every registered product | WMI `root/SecurityCenter2 AntiVirusProduct`, `productState` decoded (enabled / snoozed, signatures up to date) | A disabled product next to an active one is `info` |
| Windows | Microsoft Defender | `Get-MpComputerStatus` (AMService, Antivirus, real-time, signature age > 7 days = warn) | Passive Defender beside an active third-party AV is `info` |
| Windows | BitLocker, every fixed volume | `Get-BitLockerVolume`, then CIM `Win32_EncryptableVolume`, then `manage-bde -status` | Not elevated: `unknown` with "needs administrator rights" |
| Windows | Pending updates | `Microsoft.Update.Session` search `IsInstalled=0 and IsHidden=0` (4-minute timeout), security count by the language-independent category id | Failure: `unknown` with the error |
| Linux | Firewall | `ufw status`, `firewall-cmd --state`, `nft list ruleset` (input hook with rules or drop policy) | One active front-end passes; unreadable (not root) is `unknown` |
| Linux | Disk encryption, each mounted filesystem | `lsblk -P -o NAME,KNAME,PKNAME,TYPE,FSTYPE,MOUNTPOINT` (crypt layer under the mount), `cryptsetup status -- <dm>` for type and cipher; `dmsetup ls --target crypt` when lsblk fails | |
| Linux | Pending security updates | `apt-get -s upgrade` (packages from `-security` origins), `dnf -q updateinfo list --security`, `zypper list-patches --category security`, `yum -q updateinfo list security` | First manager found in that order |
| macOS | Firewall | `socketfilterfw --getglobalstate` decides; `pfctl -s info` shown as context (needs root) | |
| macOS | FileVault | `fdesetup status` (in-progress = warn) | |
| macOS | SIP | `csrutil status` (custom configuration = warn) | |
| macOS | Gatekeeper | `spctl --status` | |
| macOS | Pending updates | `softwareupdate -l` | |

The agent keeps every field inside the API's limits (subject ≤ 120, source ≤ 200, value / reason ≤ 300,
no control characters, ≤ 64 items) because the API refuses the whole heartbeat otherwise. Above 64
items, failures, warnings and unknowns are kept before passes, and the last slot is an `unknown` item
saying how many items were left out.

### API (`apps/api/src/modules/endpoints/capabilities.ts`)

`evaluateComplianceItems` judges each required item (Windows: firewall, antivirus, disk encryption,
updates, disk space; Linux: firewall, disk encryption, updates, disk space; macOS: those plus SIP and
Gatekeeper) and returns `label_en/ar`, `verdict`, `reason_en/ar` and the evidence. Failure severity:
antivirus and SIP → `non_compliant`; firewall, disk encryption, updates, Gatekeeper, disk ≥ 92 % →
`attention`. Older agents without evidence are still judged from their yes/no fields, and the evidence
then says `agent posture field (no per-item evidence)`. The heartbeat stores status and reasons; the
endpoint detail returns `compliance_items`. Evidence is validated strictly by Zod (`securityEvidenceSchema`).

### UI

Endpoint → Security tab: "Compliance evidence" lists every item with its verdict, reason and an evidence
table (subject, result, observed value, source command, time), EN and AR. Agent explanations are
translated to Arabic where they are fixed phrases (`localizeEvidenceReason`); command output stays as
reported, in bidi isolates.

## 2. File-manager upload never silently overwrites

- The agent refuses an existing target (`upload target already exists`) unless the first chunk carries
  `overwrite: true`; a folder, link or special file is never replaced. Continuation chunks only extend an
  upload this agent started, at exactly the file's current end.
- The console checks the listing first and asks in a dialog (EN + AR) showing the path, existing size and
  date, and new size. If the file appeared after the listing, the agent's refusal opens the same dialog.
- The API accepts `overwrite` only on an upload at offset 0, admins only; the request's audit row
  (`endpoint.fs_op`) records `overwrite: true`, never the file content.
- The path guard also blocks Windows DPAPI and Credential Manager stores (`AppData\Roaming\Microsoft\
  Credentials|Protect|Vault`, `AppData\Local\Microsoft\Credentials|Vault`, `ProgramData\Microsoft\Vault`,
  `System32\Microsoft\Protect`), and search never walks into them.

## 3. Package actions

Linux detects `apt-get`, then `dnf`, `zypper`, `yum`; each gets the package id after `--` on top of the
id pattern. `upgrade` with apt uses `--only-upgrade`.

## 4. Notices, lock and sign-out

- Linux notice: `notify-send` inside the active graphical logind session (`runuser -u USER -- env
  DBUS_SESSION_BUS_ADDRESS=… notify-send …`); falls back to `wall` and the result says which was used
  and why.
- macOS notice: `osascript display notification` in the console user's session (`launchctl asuser`),
  falling back to a dialog that closes after 20 s.
- Linux lock / sign-out: `loginctl lock-session` / `terminate-session` on the active graphical session.
- macOS lock: `CGSession -suspend` when present (removed in recent macOS); otherwise the screen saver
  starts, which locks only if "Require password immediately" is set. The result says which happened.
  `pmset displaysleepnow` is no longer used.
- macOS sign-out: `osascript -e 'tell application "System Events" to log out'`. The user confirms, apps
  with unsaved work can cancel, and macOS may ask once to allow automation.
- Sign-out is no longer refused for Linux and macOS by the API, and the console shows the button.

## 5. macOS logs

`log show --last 15m --style compact` is tailed to the requested line count (10–200), each line at most
140 characters, so the result stays under the API's 32,000-character limit.

## Prerequisites

- Windows: BitLocker status needs the agent to run elevated (Administrator or SYSTEM); otherwise every
  volume is `unknown` with that reason. The update search needs the Windows Update service.
- Linux: root for `ufw`, `nft` and `cryptsetup`; `libnotify` (`notify-send`) and `runuser` for desktop
  notices; logind for lock and sign-out.
- macOS: root for `pfctl` and for `launchctl asuser`; a user at the console for notices, lock, sign-out.

## What was verified

- Go: `go vet` for windows, linux and darwin; unit and table tests for every parser (samples written
  from the documented formats, not captured from real machines), the collectors with fake commands,
  command construction for notices, lock, sign-out and packages, the evidence limits, the log tail.
- Real run on this Windows 11 machine, not elevated (`NIGAFIY_LIVE_COMPLIANCE=1 go test -run Live`): three
  firewall profiles pass, Security Center and Defender read, BitLocker on C: and D: `unknown` "needs
  administrator rights". The Windows Update search was not run live (it queries Microsoft's servers).
- API: verdict tests for every path, heartbeat storage, strict evidence validation, overwrite flag rules
  and audit (`apps/api/tests/fleet-compliance.test.ts`).
- Web: typecheck and production build. The dialogs and evidence table were not exercised in a browser
  against a real agent.

## Not verified / known limits

- No Linux or macOS command was run on a real system.
- Windows `lock` and `logoff` were not changed here: they run `LockWorkStation` / `shutdown /l` in the
  agent's own session. If the agent is run as a Windows service (session 0) they would not reach the
  signed-in user's session; that path was not tested.
- apt's count reflects the last `apt update`; the agent never refreshes package lists itself.
