# Nigafiy design mockups

Live canvas: https://claude.ai/artifact/UgAvbazdgsCatGmPwfqQnd (private to the owner). Source files:
`*.dc.html` in this folder. Each artboard has Dark / Arabic tweaks.

| Artboard | Decides |
| --- | --- |
| Hub home (`Main.dc.html`) | Window shell (Mica title bar, sidebar with the active item marked on the inline-start edge), program tiles with "Open" or "Install", engine status, "Needs your attention" items tagged with their program's colour |
| Radar devices (`Radar.dc.html`) | Program shell with its own accent, device table showing name source and confidence, and the **shared device card** with actions grouped by program ("Available in Nigafiy Mind: install" when a program is missing) |
| Website home (`Site.dc.html`) | Hero, the three promises (local-first, transparent, works things out), the program family, "build your bundle" picker with SHA-256 note. Screenshots are slots for real screenshots |
| Icons (`Icons.dc.html`) | Program glyphs in rounded accent squares at 72/24/16 px, logo options, status colours |

## Decisions (owner, 2026-11-21)

- **Direction approved:** native Windows 11, one accent per program, the shared device card.
- **Logo: option D**, the owner's two-tone rounded lowercase **n** with the lowercase wordmark `nigafiy`, and the app
  icon as the n on a navy rounded square. Mark and wordmark only: no mascot or character.
  The vector in the mockups is a draft; the final SVG/ICO set is produced in Milestone 2.

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
