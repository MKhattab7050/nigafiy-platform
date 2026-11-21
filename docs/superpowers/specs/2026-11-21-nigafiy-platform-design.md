# Nigafiy platform: design

Status: draft for the owner's approval (2026-11-21).
Starting point: the LAN Detective monorepo in `D:\network`, branch `phase-2-network-intelligence`.

## 1. Intent

The owner is turning LAN Detective into **Nigafiy**, a bigger and stronger **network and IT platform**
for companies. Three things change:

1. **Name and identity.** Everything becomes Nigafiy, with one visual language across all of it.
2. **A family of Windows programs, not one big app.** Each program does one job well. Features that
   belong together stay together inside one program, and the programs open each other.
3. **A public website** that presents every program and lets anyone download each program on its
   own or the full bundle.

Nothing that exists today may be lost in the move. Every page, API module, collector and agent
capability must end up inside one of the programs (see the map in section 5).

## 2. Goals, non-goals, anti-goals

**Goals**
- Every current feature is in exactly one program (with shared pieces, such as the device card, shown everywhere).
- One background engine and one set of data. A device, user or incident exists once.
- Each program installs separately and has its own icon, Start-menu entry, taskbar identity and
  window. A small download each, plus a "full bundle".
- Sign in once and every program is signed in.
- Programs link to each other. From any device you can reach every action any installed program offers.
- Existing LAN Detective installations upgrade to Nigafiy with their data intact.
- Arabic and English with full RTL everywhere: programs, installers and website.

**Non-goals (for this restructuring)**
- User accounts, licences or payments on the website.
- A cloud or online control panel. Data stays on the company's own machines.
- Mobile apps or mobile device management (removed on purpose in migration `015`; do not re-add).
- macOS or Linux builds of the desktop programs. The **agent** keeps its Windows, Linux and macOS support.

**Anti-goals (the work fails if any of these happen, even if everything else works)**
- A feature disappears, gets simpler, or turns into a button that does nothing.
- Any mock, demo or simulated data or mode ships in the product.
- Two programs keep their own copies of the same data.
- The owner's real LAN Detective installation or its database gets damaged or overwritten during development.
- Remote access becomes less transparent. No stealth access, keylogging, credential capture or covert interception.

## 3. Decisions the owner made

| Topic | Decision |
| --- | --- |
| Scope | A bigger, stronger network and IT platform, building on what LAN Detective does |
| Architecture | **One shared engine** with several specialised programs on top of it |
| Website | **Showcase, downloads and documentation** in Arabic and English. No accounts, licensing or online control |
| Name | **Nigafiy**. The owner was told that the spelling reads close to an English slur and chose to keep it |
| Visual design | **Native Windows 11** (Mica, soft corners, light and dark themes that follow the system) with **one accent colour per program** |

## 4. Current state (read before touching anything)

- Monorepo (pnpm, Node 24):
  - `apps/api`: Node/TypeScript API, run with plain `node src/main.ts`. Feature modules live in `src/modules/*` and are registered in `modules/registry.ts`.
  - `apps/web`: Next.js UI. Pages are in `app/(app)/*`; the shell is in `components/shell`.
  - `apps/desktop`: Electron. It starts embedded PostgreSQL, the API, the web server and the collector through `local-stack.cjs` and `collector-manager.cjs`, and builds an NSIS installer.
  - `collectors/lan-collector`: Go network collector.
  - `agents/endpoint-agent`: Go endpoint agent.
  - `packages/shared-types`.
- **There are about 325 uncommitted changes**: 142 modified, 153 new and 30 deleted files. Most of it is a
  refactor that moved files into feature folders (for example `modules/endpoints/*`, `modules/ports/*`,
  `components/shell/`, `lib/i18n/`), plus feature work from earlier parallel sessions (migrations
  021–027: port control, config backup, smart security checks, playbooks, knowledge, AI assistant,
  impact, portfolio). It is not known whether all of that work is finished and passing.
- `docs/roadmap/status.md` is the source of truth for what is built and what is verified.
- Dev environment and pitfalls: see section 10.

## 5. The program family and the complete feature map

Each program has a name, a job, an accent colour and its contents. **Everything in today's repo is assigned.**

| Program | Job | Accent | Contains (today's pages → API modules) |
| --- | --- | --- | --- |
| **Nigafiy Hub** | Home and engine | Nigafiy brand blue | Overview dashboard `/` → `overview`, global search; login, register, invite, reset password → `auth` (team, MFA, recovery codes); `/settings`; system self-check → `system`; `/portfolio` (MSP) → `portfolio`; collector/sensor management → `collectors`, `ingest`, `realtime`; installing, updating and launching the other programs (new) |
| **Nigafiy Radar** | See the network | Cyan | `/discovery` → `sites` (authorized scopes), discovery; `/devices`, `/devices/[id]` → `devices` (identify, classify, trust, Wake-on-LAN, monitor); `/topology` → `topology`; `/ipam` → `ipam`; `/ports` → `ports` (switches, Port Detective, interface history, "where is it plugged in") |
| **Nigafiy Watch** | Watch and understand | Amber | `/monitoring` → `monitoring` (checks, rollups); `/events` → `events`; `/incidents`, `/incidents/[id]` → `incidents`, `correlation`; `/doctor` → `doctor`; `/time-machine` → `timemachine`; insights → `insights`; notifications (email, webhooks) → `notifications`; maintenance windows → `maintenance`; `/reports` → `overview/reports`; `/impact` → `impact` |
| **Nigafiy Guard** | Protect and control | Red | `/access` → `access` (DNS filter, profiles, pause, bedtimes); `/routers`, `/routers/[id]` → `routers` (block, unblock, rate limit, schedule); switch port control (disable/enable, VLAN, quarantine) → `ports/control`; smart security checks (rogue DHCP, UPnP, Wi-Fi analyser, fingerprinting) → `security`; config backup and diff → `configbackup` |
| **Nigafiy Fleet** | Manage company computers | Violet | `/endpoints`, `/endpoints/[id]` → `endpoints` (enrollment, fleet, policy, compliance, remote desktop, file manager, processes, services, commands, software, logs, power, notify user) |
| **Nigafiy Mind** | Intelligence and automation | Pink | `/assistant` → `assistant` (off by default, uses the admin's own key); `/knowledge`, `/knowledge/[id]` → `knowledge`; playbooks (approval-gated) → `playbooks`; automation catalogue and overrides → `automation` |
| **Nigafiy Toolbox** | Quick tools | Green | `/toolbox` → `toolbox` (ping, TCP port, common ports, DNS, reverse DNS, traceroute run by the site collector); subnet calculator (today inside IPAM, also shown here) |

Installed on other machines, not on the admin's PC:

| Program | Today | Job |
| --- | --- | --- |
| **Nigafiy Agent** | `agents/endpoint-agent` | Runs on managed Windows, Linux and macOS computers; Fleet talks to it |
| **Nigafiy Sensor** | `collectors/lan-collector` | The network collector. Hub runs one locally; extra Sensors go at other sites |

Shared across programs (one implementation, used everywhere):
- **Device card.** Opening a device from any program shows the same card. Its action bar lists actions
  from *all* installed programs (Radar: identify, trust, wake; Watch: monitor, incidents; Guard: block,
  pause, quarantine; Fleet: remote desktop, files; Toolbox: ping, ports). Actions from a program that is
  not installed show as "Available in Nigafiy Guard: install" rather than being hidden or doing nothing.
- **Notifications and attention items** from every program show in Hub and in the Windows notification area.
- **Global search** opens results in the program that owns them.

The builder must keep a **parity checklist** (section 9, step 6) that ticks off every row above
against the running programs before calling the work done.

## 6. Architecture

```
            Website (static)  ── downloads, release manifest ──┐
                                                               │ updates
┌──────────────────────── Admin's Windows PC ───────────────────▼─────────┐
│  Nigafiy Hub ─ installs/updates/launches ─┐                             │
│  Radar  Watch  Guard  Fleet  Mind  Toolbox  (small launchers, own icons) │
│        └────── shared desktop runtime (one Electron install) ──────┐     │
│                       windows load the UI from the engine           │     │
│  Nigafiy Engine (Windows service, starts at boot)                  ▼     │
│     PostgreSQL (embedded)  ·  API  ·  web UI server  ·  local Sensor     │
└──────────────────────────────────────────────────────────────────────────┘
        ▲ authenticated channel                    ▲ authenticated channel
  Nigafiy Sensor (other sites)              Nigafiy Agent (managed computers)
```

**6.1 Engine.** Today's `local-stack.cjs` (database, API, web server, collector) becomes a **Windows
service** so it keeps running when no program is open and starts at boot. It listens on
127.0.0.1 by default. The existing setting for serving the web console on the LAN stays available.
The collector keeps the privileges it needs (ICMP, passive DHCP on UDP 67, DNS on 53 when the filter is on).
The API stays **one process with all modules**. Whether a program is installed only decides which UI
is present, never which data is collected, so uninstalling Guard does not quietly turn off a DNS
filter that is protecting the network. Service wrapper technology is the builder's call.

**6.2 Programs.** There is **one UI codebase** (`apps/web`). Each program is a scope inside it:
- A registry (for example `apps/web/lib/programs.ts`) defines each program's id, names in Arabic and
  English, accent, icon and sections, mirroring the table in section 5.
- The shell reads the current program and shows only that program's sidebar, name, icon and accent.
  Hub's home dashboard gathers widgets from every installed program.
- URLs are namespaced per program (for example `/radar/devices/123`, `/fleet/endpoints/7`). Old
  URLs redirect so bookmarks, notifications and links in emails keep working.

On the desktop, Hub installs **one shared Electron runtime**. Each program is a **small separate
package**: its own `.exe` launcher with its own icon and version info, its own Windows
AppUserModelID (separate taskbar group), Start-menu entry and uninstall entry. The launcher starts
the shared runtime with `--program=<id>`. One runtime with one session partition means one sign-in
for all programs. The launcher technology is the builder's call; it must stay small (a few MB).

**6.3 Program-to-program links.** Hub registers the `nigafiy://` protocol, for example
`nigafiy://fleet/endpoints/7` or `nigafiy://guard/devices/123/block`. If the target program is
installed it opens or focuses on that page. If it is not, Hub offers to install it and then continues.
The engine exposes which programs are installed (for example `GET /api/v1/platform/programs`) so the UI
can build the device card's action bar.

**6.4 Updates.** Hub reads a release manifest published on the website. The manifest lists each
component (engine, runtime, each program, agent, sensor) with version, URL, size and SHA-256, and the
manifest itself is signed. Updates download in the background and install on the admin's click or at a
scheduled time. Agents and Sensors update through the engine, as today.

**6.5 Upgrade from LAN Detective.** The Hub installer detects an existing LAN Detective installation
(`C:\Program Files\LAN Detective` and its data folder). It stops that installation cleanly and moves or
imports its database, collector state and settings, then removes or retires the old app. Accounts,
devices, history and enrolled agents and collectors keep working. Enrolled agents and collectors that
still use old names and addresses must keep connecting. This is tested on a copy, never on the
owner's live installation.

**6.6 Renaming.** Product strings, logos, window titles, installers, package names (`@lan-detective/*` →
`@nigafiy/*`), binary names (`nigafiy-agent.exe`, `nigafiy-sensor.exe`) and docs move to Nigafiy.
Anything persisted or on the wire must stay compatible or be migrated: database names, environment
variable prefixes (`LD_*`), the collector and agent protocol, enrollment tokens, and data and state
folders. The builder decides each one and writes the decision down.

## 7. Website (`apps/site`, new)

A static Next.js site in Arabic and English (RTL), in the same visual language as the programs.
- **Home:** what Nigafiy is, the program family, why it is different: local-first, transparent,
  and it works things out by itself.
- **One page per program:** what it does, screenshots of the real running program (no invented numbers),
  what it needs.
- **Downloads:** each program on its own, the **full bundle**, Agent (Windows, Linux, macOS) and Sensor,
  each with version, size and SHA-256. A "build your bundle" picker: tick the programs you want and get
  one Hub installer that installs exactly those.
- **Docs** generated from the repo's `docs/`, plus **changelog**, **security and privacy** (from
  `docs/security/model.md`) and the **release manifest** for Hub updates.
- Hosting is not decided (Vercel is available in this environment). Downloads must come from a stable
  host (for example GitHub Releases or blob storage).

## 8. Visual design

- **Native Windows 11 look:** Mica window backgrounds (Electron `backgroundMaterial`, with a solid fallback
  on Windows 10), Fluent 2 style spacing, soft corners and calm surfaces. Light and dark follow the system,
  and the user can override them (the existing theme switch).
- **One accent per program:** Hub brand blue, Radar cyan, Watch amber, Guard red, Fleet violet,
  Mind pink, Toolbox green. The accent marks the program's icon, active sidebar item, primary buttons
  and focus rings. Status colours (ok, warning, critical) are shared and never reuse an accent.
- **Icons:** one family. Each program glyph sits in a rounded square in its accent, so all of them read as a set.
- **Type:** Segoe UI Variable in the programs. The website uses a web font with good Arabic support.
  Both must render Arabic properly in RTL.
- The owner wants to shape the design together. **Before restyling the whole app, show the owner
  mockups** (Hub home, one program such as Radar, website home, the set of icons) and get approval.

## 9. Order of work

0. **Baseline.** Check whether earlier parallel builder sessions are still running and leave their files
   alone until they finish. Run the full checks: `pnpm typecheck`, `pnpm test`, `pnpm test:collector`,
   `pnpm test:agent`, the web build and the desktop pack. Fix what is broken, update `status.md`, and
   commit the current work as a clean baseline **with the owner's OK**. Nothing else starts before this.
1. **Design mockups** (section 8), approved by the owner.
2. **Rename and brand** (section 6.6), with data compatibility.
3. **Engine as a service and Hub** (sections 6.1, 6.4): install, sign in, home dashboard, program launcher, updates.
4. **Programs:** program scopes in the UI, URL namespacing with redirects, launchers, `nigafiy://` links,
   the shared device card, cross-program notifications.
5. **Installers and upgrade:** a package per program, the full bundle, Agent and Sensor packages, and the
   LAN Detective upgrade path (section 6.5), tested on a copy.
6. **Parity audit:** walk every row of section 5 in the running programs, in Arabic and English, and record
   the result in `status.md`. Anything missing is fixed before moving on.
7. **Website** (section 7).
8. Then continue the existing roadmap (phases 5 and 6 items still open in `status.md`), now inside the right program.

## 10. Standing rules (carried over from the owner's brief)

- Do not remove, simplify or skip any feature. Phases are an order, not permission to cut.
- 100% real product: no simulated modes, drivers or data in the product. Test doubles live only in tests.
  Never present guessed facts as confirmed; show how something was found and how sure it is.
- Every feature has backend, database, UI, validation, permission checks, audit log, tests and documented prerequisites.
- Design for company networks (several sites, routers and vendors), not just a home network.
- Smart and easy: ask the user for as little as possible and work out the rest. Consent and security
  steps stay explicit clicks: authorizing a scan range, enrolling a machine, remote sessions,
  destructive actions, DNS filtering and credentials.
- Remote access stays transparent.
- Inspect before overwriting any file.
- **The owner has LAN Detective installed and often running** (`C:\Program Files\LAN Detective`, ports
  47100/47130/47133). Never install over it, attach to it or stop its processes by image name. Before
  any launcher or desktop test, check those ports and the dev ports 3100/4100/5433 are free, and use
  `--user-data-dir=<scratch>` for test runs. Stop processes by PID only.
- Dev environment: no Docker. Embedded PostgreSQL (dev 5433, tests 5439, override with
  `LD_TEST_PG_PORT`) initialised with `--encoding=UTF8 --locale=C`. API on 4100 with plain `node`
  (`--watch` loops here). Web on 3100. Only scan 192.168.1.0/24 (the owner's network); ask before any other range.
- The router admin password is typed only by the owner.

## 11. Left to decide

**The owner decides** (the builder asks when it gets there):
- Website domain and hosting, and where downloads are hosted.
- A **code-signing certificate**. Without one, Windows SmartScreen warns on every download. The owner has to buy it.
- The final logo, chosen from the mockups.

**The builder decides and writes the decision down:**
- Service wrapper, launcher technology, URL scheme details, the update scheduling defaults,
  which internal identifiers to rename, and the website's framework details.
