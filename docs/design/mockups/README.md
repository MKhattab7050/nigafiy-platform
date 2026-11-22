# Nigafiy design mockups

Live canvas: https://claude.ai/artifact/UgAvbazdgsCatGmPwfqQnd (private to the owner). Source files:
`*.dc.html` in this folder. Each artboard has Dark / Arabic tweaks.

| Artboard | Decides |
| --- | --- |
| Hub home (`Main.dc.html`) | Sites with their Sensors and health, window shell (Mica title bar, sidebar with the active item marked on the inline-start edge), program tiles with "Open" or "Install", engine status, "Needs your attention" items tagged with their program's colour |
| Radar devices (`Radar.dc.html`) | Program shell with its own accent, device table showing name source and confidence, and the **shared device card** with actions grouped by program ("Available in Nigafiy Mind: install" when a program is missing) |
| Website home (`Site.dc.html`) | Hero, the three promises (local-first, transparent, works things out), the program family, "build your bundle" picker with SHA-256 note. Screenshots are slots for real screenshots |
| Icons (`Icons.dc.html`) | Program glyphs in rounded accent squares at 72/24/16 px, logo options, status colours |
| Watch (`Watch.dc.html`) | Incident with the Network Doctor path (LAN → gateway → internet → DNS), evidence tagged observed / inferred, ruled out, steps, before/during/after timeline |
| Guard (`Guard.dc.html`) | Protection overview cards (DNS filter off until turned on, routers, quarantined ports, config changes) and security findings with how each was found |
| Fleet (`Fleet.dc.html`) | Computer page with tabs; a remote session shows the on-screen notice, reason and audit line, an End session button, and compliance where unmeasured items say "not measured" |
| Fleet Pro: computers (`FleetHome.dc.html`) | Address book with groups, filters, bulk actions, Wake and connect, help requests from the tray, live sessions others can join |
| Fleet Pro: live session (`FleetSession.dc.html`) | AnyDesk-class viewer: measured fps/latency/route, monitors, quality, view only, clipboard, files, chat, audio, record, draw, privacy screen, block input, Ctrl+Alt+Del, switch user, restart and reconnect, print, invite; the user's session bar shown inside the picture |
| Fleet Pro: user side (`FleetUser.dc.html`) | Consent prompt with per-permission ticks and timeout, the session bar with End, the tray's Request help and support activity, Quick Support code, the privacy screen text |
| Fleet Pro: tools (`FleetTools.dc.html`) | Two-pane file transfer with queue, admin-only PowerShell with transcript, scripts and jobs on groups and schedules, patch windows |
| Fleet Pro: policy (`FleetPolicy.dc.html`) | Attended or unattended, MFA, second-admin approval, hours, recording retention, IP allow-list, permission profiles matrix, and what no policy can turn off |
| Mind (`Mind.dc.html`) | Playbook run with an approval gate on the disruptive step, the two-person rule and a related knowledge article |
| Toolbox (`Toolbox.dc.html`) | Tool tabs, Ping run from a chosen Sensor inside authorized scopes, and the subnet calculator |

## Decisions (owner, 2026-11-21)

- **Direction approved:** native Windows 11, one accent per program, the shared device card.
- **Logo: option D**, the owner's two-tone rounded lowercase **n** with the lowercase wordmark `nigafiy`, and the app
  icon as the n on a navy rounded square. Mark and wordmark only: no mascot or character.
  The vector in the mockups is a draft; the final SVG/ICO set is produced in Milestone 2.
- **Fleet Pro approved** (the five `Fleet*.dc.html` screens and `docs/features/fleet-pro.md`): built in Milestone 4b.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| Logo blue / logo navy | `#1A73FF` / `#0B2A7A`, wordmark `#0B1F5C`, icon ground `#0B1F5C` | The logo only |
| Hub accent | `#1466E6` | Hub UI (a shade of the logo blue that keeps white text at AA contrast) |
| Radar | `#0099BC` (buttons `#00809D`) | |
| Watch | `#C27C0E` | |
| Guard | `#D13438` | |
| Fleet | `#7A4FD6` | |
| Mind | `#C239B3` | |
| Toolbox | `#2E8540` | |
| Agent / Sensor | `#4B5563` / `#3D6E7A` | |
| Status ok / warning / critical / unknown | `#0E7A0D` / `#9D5300` / `#B3261E` / `#5C5C5C` (light theme) | Always with an icon and a word, never colour alone, because Guard red and Toolbox green sit close to critical and ok |

Type: Segoe UI Variable in the programs (IBM Plex Sans Arabic as the Arabic fallback); the website uses
IBM Plex Sans / IBM Plex Sans Arabic, and Poppins 600 for the wordmark.
