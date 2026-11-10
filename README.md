# LAN Detective

**Know your network. Understand every incident.**

Network intelligence and IT infrastructure monitoring for IT administrators and MSPs. A lightweight Go
collector runs inside the customer network and reports — over outbound HTTPS only — to a multi-tenant
cloud platform.

> **Status: Phases 1 and 2 (functional core + network intelligence).** Everything listed under "What works" is implemented, connected
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
| Notifications | Signed webhooks (HMAC-SHA256) with retry + backoff and SSRF protection |
| Incidents | Automatic correlation of alerts into incidents, auto-resolution, assignment, notes, before/during/after replay |
| Network Doctor | Deterministic, evidence-backed root-cause rules (LAN / gateway / WAN-ISP / DNS / service / device / collector) with confidence and next steps |
| Time Machine | State of the network at any recorded moment; comparison of two periods; 90-day charts from hourly roll-ups |
| Topology | Evidence-based map (internet → gateway → subnets → devices); every link marked observed or inferred |
| Other | Audit log, English + Arabic (true RTL), responsive layout, retention job |

## Run it locally (no Docker needed)

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
cd collectors/lan-collector && LAN_COLLECTOR_ENROLLMENT_TOKEN=<token> ./bin/lan-collector -config configs/collector.example.yaml
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
collectors/lan-collector Edge collector — Go
packages/shared-types    API contract types shared by api and web
docs/                    Architecture, protocol, database, security, roadmap
scripts/                 e2e smoke test
```

## Documentation

- [Architecture & technical assessment](docs/architecture/overview.md)
- [Database design](docs/architecture/database.md)
- [Collector architecture & protocol v1](docs/collector/protocol.md)
- [Security model](docs/security/model.md)
- [Status, gaps, risks and roadmap](docs/roadmap/status.md)
