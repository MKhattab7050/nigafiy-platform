<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/hero-dark.svg">
    <img alt="Nigafiy: know your network, understand every incident. Seven programs on one local engine." src="docs/assets/readme/hero.svg" width="100%">
  </picture>
</p>

<h3 align="center">Free, Windows-first network and endpoint management for IT teams and MSPs.<br>On your own machines, in English and Arabic, with no cloud panel and no AI.</h3>

<p align="center">
  <a href="https://github.com/MKhattab7050/nigafiy-platform/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MKhattab7050/nigafiy-platform/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Platform: Windows 10 and 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-1466E6">
  <img alt="English and Arabic" src="https://img.shields.io/badge/UI-English%20%2B%20%D8%A7%D9%84%D8%B9%D8%B1%D8%A8%D9%8A%D8%A9-0B2A7A">
  <img alt="No AI, deterministic rules" src="https://img.shields.io/badge/AI-none%2C%20deterministic-2E8540">
  <img alt="Status: pre-release 0.1.0" src="https://img.shields.io/badge/status-pre--release%200.1.0-C27C0E">
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#screenshots"><b>Screenshots</b></a> ·
  <a href="#programs"><b>Programs</b></a> ·
  <a href="#architecture"><b>Architecture</b></a> ·
  <a href="docs/README.md"><b>Docs</b></a> ·
  <a href="#security"><b>Security</b></a> ·
  <a href="docs/roadmap/status.md"><b>Status</b></a> ·
  <a href="README.ar.md"><b>العربية</b></a>
</p>

<br>

Nigafiy finds and monitors every device on the network, explains incidents with deterministic,
evidence-backed rules, controls routers, switches and DNS access, and manages and supports company
computers (Windows, Linux, macOS) through an enrolled agent with remote desktop, files, shell and
patching. Seven programs share one local engine, and the data stays on the organization's own machines.

<a id="screenshots"></a>

<p align="center">
  <img alt="The Hub dashboard: network score, devices online, open incidents, failing checks, managed computers and 24-hour availability" src="docs/assets/readme/screens/dashboard-en-light.webp" width="100%">
</p>

<table>
  <tr>
    <td width="33%" valign="top"><img alt="Radar: every device with its address, vendor, type and status" src="docs/assets/readme/screens/radar-devices-en-light.webp" width="100%"><p align="center"><b>Radar</b><br><sub>every device, identified by MAC across IP changes</sub></p></td>
    <td width="33%" valign="top"><img alt="Watch: an internet outage incident with the Network Doctor's root cause and the evidence for it" src="docs/assets/readme/screens/watch-incident-en-light.webp" width="100%"><p align="center"><b>Watch</b><br><sub>incidents with a root cause and the evidence behind it</sub></p></td>
    <td width="33%" valign="top"><img alt="Fleet: a managed Windows computer with live load, hardware, session and power controls" src="docs/assets/readme/screens/fleet-endpoint-en-light.webp" width="100%"><p align="center"><b>Fleet</b><br><sub>live state and controls for every managed computer</sub></p></td>
  </tr>
</table>

<p align="center"><sub>Real screens of the web console, filled with the <a href="scripts/seed-simulated.mjs">simulated demo organization</a> (invented devices and telemetry). The same console in Arabic, right to left, in the dark theme: <a href="README.ar.md#screenshots">README.ar.md</a>.</sub></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/divider-dark.svg">
  <img alt="" src="docs/assets/readme/divider.svg" width="100%">
</picture>

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/how-it-works-dark.svg">
  <img alt="How it works: 1 discover every device, 2 watch it and turn evidence into incidents, 3 alert by email, chat apps and signed webhooks, 4 act from Guard or Fleet" src="docs/assets/readme/how-it-works.svg" width="100%">
</picture>

## Programs

<table>
  <tr>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/hub.svg" width="52" alt=""><br><b>Nigafiy Hub</b><br><sub>Home, sign-in, settings and the engine</sub></td>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/radar.svg" width="52" alt=""><br><b>Nigafiy Radar</b><br><sub>See every device on the network</sub></td>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/watch.svg" width="52" alt=""><br><b>Nigafiy Watch</b><br><sub>Monitor, and understand what went wrong</sub></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/guard.svg" width="52" alt=""><br><b>Nigafiy Guard</b><br><sub>Protect and control the network</sub></td>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/fleet.svg" width="52" alt=""><br><b>Nigafiy Fleet</b><br><sub>Manage and support company computers</sub></td>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/mind.svg" width="52" alt=""><br><b>Nigafiy Mind</b><br><sub>Knowledge, playbooks and automation</sub></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/toolbox.svg" width="52" alt=""><br><b>Nigafiy Toolbox</b><br><sub>Quick network tools</sub></td>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/sensor.svg" width="52" alt=""><br><b>Nigafiy Sensor</b><br><sub>Network collector, one per site</sub></td>
    <td align="center" valign="top" width="33%"><img src="packages/brand/svg/programs/agent.svg" width="52" alt=""><br><b>Nigafiy Agent</b><br><sub>On every managed computer</sub></td>
  </tr>
</table>

<p align="center"><sub>The Sensor runs as <code>nigafiy-engine sensor</code>; the Agent runs on Windows, Linux and macOS. The program list is defined once in <a href="packages/shared-types/src/programs.ts"><code>programs.ts</code></a>; icons and accents come from <a href="packages/brand"><code>packages/brand</code></a>.</sub></p>

### What each program does

<details>
<summary><img src="packages/brand/svg/programs/radar.svg" width="18" alt=""> <b>Radar</b>: discovery and inventory</summary>
<br>

- ICMP sweep, neighbour table, mDNS, SSDP, NetBIOS and passive DHCP names
- One identity per device by MAC, across IP changes; IPv4 and IPv6
- Topology with observed and inferred links, single points of failure; IPAM; switch ports

</details>

<details>
<summary><img src="packages/brand/svg/programs/watch.svg" width="18" alt=""> <b>Watch</b>: monitoring, incidents and notifications</summary>
<br>

- Ping, TCP, DNS, HTTP/HTTPS, TLS expiry and SNMP OID checks
- Events with evidence; incidents correlated and resolved automatically; Network Doctor; Time Machine
- Email, signed webhooks, Telegram, Slack, Discord and ntfy; escalation policies; maintenance windows

</details>

<details>
<summary><img src="packages/brand/svg/programs/guard.svg" width="18" alt=""> <b>Guard</b>: control and protection</summary>
<br>

- DNS access control for any router
- 16 router drivers, with a read-back after every change
- Switch port control over SNMP; security checks; SSH config backup with Junos and IOS XE restore

</details>

<details>
<summary><img src="packages/brand/svg/programs/fleet.svg" width="18" alt=""> <b>Fleet</b>: company computers</summary>
<br>

- Agent for Windows, Linux and macOS; evidence-only compliance
- Remote desktop with consent and an on-screen banner (WebSocket JPEG, WebRTC H.264 on Windows)
- Files, shell, scripts, jobs and patches; access policies with MFA step-up and second-admin approval

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/fleet-remote-desktop-dark.svg">
  <img alt="Remote desktop flow: the technician starts a session, the API checks the access policy, the Agent dials out and picks up the command, the user consents, frames flow over WebSocket or WebRTC, and the session is audited" src="docs/assets/readme/fleet-remote-desktop.svg" width="100%">
</picture>

</details>

<details>
<summary><img src="packages/brand/svg/programs/mind.svg" width="18" alt=""> <b>Mind</b> and <img src="packages/brand/svg/programs/toolbox.svg" width="18" alt=""> <b>Toolbox</b></summary>
<br>

- Mind: knowledge memory, approval-gated playbooks, an automation catalogue. No AI
- Toolbox: ping, TCP port, common ports, DNS, reverse DNS, traceroute from the site Sensor, subnet calculator

</details>

Area by area, with links to every feature page: [docs/features/capabilities.md](docs/features/capabilities.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/divider-dark.svg">
  <img alt="" src="docs/assets/readme/divider.svg" width="100%">
</picture>

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/architecture-dark.svg">
  <img alt="Architecture: on the admin's Windows PC, loopback only, nigafiy-engine supervises the web console, the API, PostgreSQL with Row Level Security and the local Sensor. Sensors at other sites and Agents on managed computers dial out to the API; the Sensor reaches the LAN with ICMP, ARP, SNMP, SSH and router APIs." src="docs/assets/readme/architecture.svg" width="100%">
</picture>

The server never opens a connection into a customer network: Sensors and Agents dial out and poll for
commands from a closed list. More diagrams (ports, discovery, enrollment, remote desktop, router
changes, config restore, updates, distribution, sign-in) are in
[docs/architecture/flowcharts.md](docs/architecture/flowcharts.md); the written architecture is in
[docs/architecture/overview.md](docs/architecture/overview.md).

## Quick start

**Prerequisites:** Node.js 24+, Go 1.27.3+ (pnpm 10 is installed for you by `pnpm local` when missing).
No Docker, PostgreSQL or Redis needed.

```bash
pnpm local
```

On Windows you can double-click `Start Nigafiy.cmd` instead. The first run installs dependencies,
creates `.env`, starts the database, API and web app on this computer, asks you to confirm your
network, creates your account and opens http://localhost:3100.

<details>
<summary><b>Development: run each part in its own terminal</b></summary>

```bash
pnpm install
cp .env.example .env      # then set APP_ENCRYPTION_KEY and the lan_app password
pnpm dev:db               # PostgreSQL on 5433
pnpm dev:api              # API on 4100
pnpm dev:web              # web on 3100
```

</details>

<details>
<summary><b>The gate every change passes</b></summary>

```bash
pnpm typecheck
pnpm lint
pnpm check:brand
pnpm test                 # API integration tests, real PostgreSQL + RLS
pnpm test:collector       # Sensor (Go)
pnpm test:agent           # Agent (Go)
pnpm test:engine          # Engine (Go)
pnpm build
```

</details>

<details>
<summary><b>Repository map</b></summary>

| Path | What it is |
| --- | --- |
| [`apps/api`](apps/api) | API: Node 24 (native TypeScript), Express 5, Zod, PostgreSQL with Row Level Security, background jobs |
| [`apps/web`](apps/web) | Web console for all seven programs: Next.js 16, React 19, Tailwind 4, EN + AR |
| [`apps/desktop`](apps/desktop) | Windows desktop app (Electron): program windows, tray, local mode, NSIS / MSI / MSIX packaging |
| [`engine`](engine) | `nigafiy-engine` (Go): supervises database, API, web and Sensor; Windows service; control API; update helper; program launchers |
| [`collectors/lan-collector`](collectors/lan-collector) | The Sensor (Go): discovery, checks, SNMP, DNS filter, router drivers, config backup, Toolbox |
| [`agents/endpoint-agent`](agents/endpoint-agent) | The Agent (Go) for Windows, Linux and macOS, plus Quick Support (`nigafiy-support`) |
| [`packages/shared-types`](packages/shared-types) | API contract types, program list and route table shared by API and web |
| [`packages/brand`](packages/brand) | Logo, program icons and colour tokens |
| [`packaging`](packaging) | Endpoint agent NSIS script |
| [`scripts`](scripts) | `pnpm local`, brand check, e2e smoke, README art and screenshots, installers, release and signing |
| [`docs`](docs) | Architecture, features, operations, security, roadmap |
| [`.github`](.github) | CI workflow, issue and pull request templates |

</details>

The desktop installer, the Sensor on another machine, every build target and every test command:
[docs/getting-started.md](docs/getting-started.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/divider-dark.svg">
  <img alt="" src="docs/assets/readme/divider.svg" width="100%">
</picture>

## Security

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/security-dark.svg">
  <img alt="Security layers: every request passes sign-in (scrypt, TOTP MFA, SSO, rate limits), server-side role checks, PostgreSQL Row Level Security per organization, AES-256-GCM sealed secrets and an append-only audit log. Sensors and Agents only dial out over HTTPS; the server never connects into a site." src="docs/assets/readme/security.svg" width="100%">
</picture>

Every control and where it lives: [docs/security/model.md](docs/security/model.md). To report a
vulnerability, see [SECURITY.md](SECURITY.md).

## Documentation and status

- 📚 **[Documentation index](docs/README.md)**: architecture, features, operations, security and roadmap
- 🧭 **[Project status](docs/roadmap/status.md)**: what is built, what ran on real hardware, what is tested only
- 🗺️ **[Flowcharts](docs/architecture/flowcharts.md)**: every flow that exists in the code, with links to it
- 🤝 **[Contributing](CONTRIBUTING.md)**: the internal workflow

<details>
<summary><b>Honest status: tested for real versus tests only</b></summary>
<br>

Many features have only been exercised against protocol test doubles, fixtures or loopback, not on real
hardware: for example 15 of the 16 router drivers (Cisco IOS XE controls included), SNMP switches, SSO,
config restore (Junos and IOS XE), the agent on Linux and macOS, WebRTC in a real browser, the engine's
Windows service mode and the MSI / agent installers. Discovery, checks and smart checks ran on a real
LAN; the Windows agent ran against the real API; one router (Zyxel VMG3625-T50B) was controlled for
real. The GitHub CI workflow has not run yet. [docs/roadmap/status.md](docs/roadmap/status.md) lists
exactly what ran for real and what did not.

</details>

## License

Not yet chosen: all rights reserved until then.
