# LAN Detective

**Know your network. Understand every incident.**

Network intelligence and IT infrastructure monitoring for IT administrators and MSPs. A lightweight Go
collector runs inside the customer network and reports — over outbound HTTPS only — to a multi-tenant
cloud platform.

> **Status: Phases 1, 2, 3 and 4 (core platform + network intelligence + endpoint management + remote administration).** Everything listed under "What works" is implemented, connected
> to the real backend and tested. Everything else in the product vision is listed honestly under
> [docs/roadmap/status.md](docs/roadmap/status.md) and is **not** in the UI.

## What works today

| Area | Implemented |
| --- | --- |
| Accounts | Registration, login, logout, HttpOnly session cookie, scrypt password hashing, CSRF defence, rate limiting |
| Tenancy | Organizations, memberships, roles (owner / admin / technician / viewer), **PostgreSQL Row Level Security** on every tenant table |
| Sites & scopes | Sites, authorized network scopes (private ranges only, ≤ /20, explicit attestation, audit trail) |
| Collector | Single-use enrollment token → per-collector credential, heartbeat, config + command polling, on-disk buffering, backoff, graceful shutdown |
| Discovery | ICMP sweep (rate + concurrency limited) + host neighbour (ARP) table + reverse DNS; MAC vendor from the IEEE registry |
| Device inventory | Identity tracking across IP changes, new / offline / online / IP-changed / "IP answered by a different MAC" events, IP history, 7-day availability, tags, owner, notes, manual classification |
| Monitoring | ICMP (latency, loss, jitter), TCP port, DNS resolution checks; explainable state machine with flap damping; history charts 15 min → 30 days |
| Dashboard | Overview computed from stored data only, fault-domain hint (LAN vs WAN vs DNS), real-time updates over SSE |
| Events | Timeline with the evidence behind every event, filters, time ranges |
| Notifications | Email (SMTP / STARTTLS / TLS, AES-256-GCM credentials) and signed webhooks (HMAC-SHA256) with retry + backoff and SSRF protection |
| Incidents | Automatic correlation of alerts into incidents, auto-resolution, assignment, notes, before/during/after replay |
| Network Doctor | Deterministic, evidence-backed root-cause rules (LAN / gateway / WAN-ISP / DNS / service / device / collector) with confidence and next steps |
| IT Toolbox | On-demand network probes run from the site collector: ICMP ping, TCP port check, 19-port common IT/management service scanner, DNS lookup, reverse DNS, and hop-by-hop traceroute |
| Time Machine | State of the network at any recorded moment; comparison of two periods; 90-day charts from hourly roll-ups |
| Topology | Evidence-based map (internet → gateway → switches / subnets → devices) using routing tables, ARP, SNMP forwarding tables and LLDP; every link marked observed or inferred |
| Device controls | Approve devices (unreviewed / known / unwanted, one or all at once): unknown devices joining raise a warning, an unwanted device coming back raises a critical alert. Mute alerts per device, one-click "monitor every minute" (follows IP changes), Wake-on-LAN through the collector (only inside an authorized range), one-click IT Toolbox probes, and guidance plus the MAC and router link to block a device on the router. LAN Detective never disconnects or interferes with devices itself |
| Managed endpoints | Company computers running the agent: **Windows**, **Linux**, **macOS** (`agents/endpoint-agent`). Per-platform capability list, compliance from measured evidence only (`unknown` when nothing was measured), **Remote File Manager** (browse, search, chunked upload/download with SHA-256 verification, create, rename, copy, move, delete; never overwrites; protected-path, link and UNC guards), **Remote Desktop** (Windows GDI / Linux X11 / macOS view-only, session notice on screen, audit), processes, services, packages (`winget`/`apt-get`/`brew`), event logs, allow-listed diagnostics, power actions and user messages. Phones and tablets (iOS/Android) are not managed |
| Access control (any router) | The collector can answer DNS for the network (point the router's DHCP DNS at it). Block categories (ads & malware, adult, gambling, social, video, games, chat) and sites for the whole network, per profile (Kids, Guests, Focus templates) or per device; pause the internet for a device or a profile; bedtimes; per-device activity (requests, blocked names). Encrypted-DNS endpoints are blocked so devices fall back to the rules. A device using a VPN or its own DNS can bypass it, and speed limits need router control — both stated in the UI |
| Smart insights | Rule-based summary on the Overview: network score with the reasons behind it, and the few things worth doing now (unwanted devices online, devices to review, silent collector, router/internet/DNS problems, IP changes, important devices offline or unmonitored), each with evidence and a one-click action |
| Port Detective | Reads managed switches over SNMP (read-only): port state, speed, traffic rate & error history charts, the devices on each port, LLDP neighbours; answers "which port is this device plugged into" with confidence and evidence. Needs a switch with SNMP enabled |
| IPAM | Per-subnet address map: observed, documented and free addresses, subnet plan (VLAN, gateway, DHCP pool, DNS), static / reserved records, conflict detection + automatic conflict events with evidence, address history, CSV export, subnet calculator |
| Other | Audit log, English + Arabic (true RTL), responsive layout, retention job |

## Use it on your home network: desktop app

Install **LAN Detective** (`apps/desktop`, installer built with `pnpm --filter @lan-detective/desktop dist`) and
open it. Nothing else is needed — the installer carries the database, API, web app and collector, and runs
them with the app's own built-in Node.js.

On first open it starts everything on this computer (loopback only, ports 47100/47130/47133, data in the
user profile), signs in with a local account it creates for you (random password, encrypted with Windows
DPAPI), finds the network you are connected to and **asks once whether to scan it**. Say yes and the
dashboard opens with your devices appearing within about a minute. Every later open goes straight to the
dashboard. Closing the window keeps monitoring in the tray; **Quit** from the tray stops everything.

Building the installer needs Node.js 24, pnpm, Go 1.24 and this repository:

```bash
pnpm --filter @lan-detective/desktop dist
```

Running the desktop app from the repository (`pnpm --filter @lan-detective/desktop start`) does the same
using the repository's code and your system Node.js 24, and shares `.data/` with `pnpm local`.

## Use it on your home network: one command (no desktop app)

Requirements: Node.js ≥ 24 and Go ≥ 1.24 (Go builds the collector; pnpm is installed for you if missing).

On Windows, double-click **`Start LAN Detective.cmd`**. On any system:

```bash
pnpm local
```

The first time, it:

1. installs dependencies and creates `.env` with fresh secrets,
2. starts the database, API and web app on this computer,
3. finds the network this computer is connected to (for example `192.168.1.0/24`) and **asks you to
   confirm it is your network**,
4. asks for an email and password (your account lives only in the local database),
5. authorizes that one range and enrolls this computer as its collector, then opens http://localhost:3100.

Every later run is just `pnpm local` (or the double-click): everything starts, the collector resumes, and the
browser opens. Ctrl+C (or closing the window) stops it all. Data stays in `.data/` (database, collector
identity, logs in `.data/logs`). Options: `--no-open`, `--no-collector`, `--prod` (optimized web build),
`--token <token>` (enroll with a token created in the web app instead of the guided setup).

Notes: everything runs on this computer and listens on localhost only. Phone names come from passive DHCP
listening (UDP 67) and appear when a phone reconnects to Wi-Fi. On Linux, ICMP and port 67 need extra
privileges (`CAP_NET_RAW`, `CAP_NET_BIND_SERVICE`).

## Run the parts separately (development)

Requirements: Node.js ≥ 24, pnpm ≥ 10, Go ≥ 1.24.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Edit `.env`: set `APP_ENCRYPTION_KEY` (the file shows how to generate one) and change the `lan_app` password.
Then, in three terminals:

```bash
pnpm dev:db
```

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

Open http://localhost:3100, create an account, then go to **Discovery & Collectors**:

1. Authorize the network range you own (for example `192.168.1.0/24`).
2. Add a collector — you get a one-time enrollment token.
3. Build and start the collector on a machine inside that network:

```bash
pnpm build:collector
```

```bash
cd collectors/lan-collector && NIGAFIY_SENSOR_ENROLLMENT_TOKEN=<token> ./bin/lan-collector -config configs/collector.example.yaml
```

(For a local test against the dev API use `server_url: http://localhost:4100` with `allow_insecure_http: true`.)

`pnpm dev:db` starts a real PostgreSQL server from npm-distributed binaries, stored in `.data/pg`.
With Docker available, `docker compose up` provides PostgreSQL (TimescaleDB image) and Redis instead —
that compose file has **not** been exercised in the environment this repository was built in.

## Tests

```bash
pnpm test
```

API integration tests: real HTTP → Express → SQL → RLS against a throw-away PostgreSQL. No mocks.

```bash
pnpm test:collector
```

Collector unit + lifecycle tests (enrollment, outage buffering, reconnect, scope limits).

```bash
node scripts/e2e-smoke.mjs
```

`node scripts/seed-simulated.mjs` fills a clearly-labelled *simulated* organization for looking at the UI.

End-to-end against a running stack with the **real collector binary**, using the loopback range
`127.0.0.0/29` as a permitted test network (requires `ALLOW_LOOPBACK_SCOPES=true` in `.env`).

## Repository layout

```
apps/api                 Cloud API — Node 24 (native TypeScript), Express 5, PostgreSQL
apps/web                 Web app — Next.js 16, React 19, Tailwind 4, Recharts
collectors/lan-collector Edge network collector — Go (ICMP, ARP, DHCP, DNS filter, SNMP, Toolbox)
agents/endpoint-agent    Per-machine IT management & remote control agent — Go
packages/shared-types    API contract types shared by api and web
docs/                    Architecture, protocol, database, security, roadmap
scripts/                 e2e smoke test and simulated demo seed
```

## Documentation

- [Architecture & technical assessment](docs/architecture/overview.md)
- [Database design](docs/architecture/database.md)
- [Collector architecture & protocol v1](docs/collector/protocol.md)
- [Security model](docs/security/model.md)
- [Status, gaps, risks and roadmap](docs/roadmap/status.md)
- [Desktop app (dashboard + bundled collector)](docs/desktop/README.md)
