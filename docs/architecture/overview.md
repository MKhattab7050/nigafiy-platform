# Architecture

## 1. Technical assessment of the starting point

The repository was empty. The development machine had Node 24 and pnpm; Go was installed for this
project; **Docker, PostgreSQL and Redis were not available**. Consequences, all deliberate:

| Constraint | Decision |
| --- | --- |
| No Docker / PostgreSQL | Development and tests run a real PostgreSQL from the `embedded-postgres` npm package. The schema is plain PostgreSQL, so it runs unchanged on a managed database or the compose file. |
| No TimescaleDB | Time series live in a narrow, BRIN-indexed table and are aggregated with `date_bin()` at query time. Converting it to a hypertable later is a one-statement migration (see database.md). |
| No Redis | Background jobs use an in-process scheduler made single-runner with PostgreSQL advisory locks; real-time fan-out uses `LISTEN/NOTIFY`. Both are correct with several API instances. BullMQ is introduced when per-tenant fan-out jobs appear (Phase 2+). |
| Windows dev host | The collector is developed on Windows and cross-compiled for Linux. Linux-specific paths (`ip neigh`, `/proc/net/route`) are covered by parser unit tests but have not been run on a Linux host yet. |

## 2. System overview

```
 Customer network                                   Cloud
┌───────────────────────────┐   outbound HTTPS    ┌──────────────────────────────────────────┐
│ lan-collector (Go)        │ ──────────────────► │ API (Node/Express)                       │
│  discovery · checks       │  enroll             │  /api/v1/collector/*  credential auth    │
│  spool (disk buffer)      │  heartbeat ⇄ config │  /api/v1/*            session auth       │
│  scope policy (hard caps) │  telemetry          │  jobs: collector-watch, notifications,   │
└───────────────────────────┘                     │        retention                         │
        ▲ ICMP / ARP table / rDNS                 │  SSE  ◄── LISTEN/NOTIFY ──┐              │
        │ only inside authorized scopes           └──────────┬────────────────┼──────────────┘
   LAN devices                                               │                │
                                                     ┌───────▼────────────────┴───┐
   Browser ── same-origin ──► Next.js (web) ──/api──►│ PostgreSQL (RLS per tenant) │
                                                     └────────────────────────────┘
```

The cloud never opens a connection into a customer network. Commands (currently only "run discovery
now") are *polled* by the collector on its heartbeat.

## 3. Module boundaries (API)

Each module owns its routes and SQL and talks to others only through small exported functions.

| Module | Responsibility |
| --- | --- |
| `modules/auth` | Users, sessions, CSRF, organization switching. Only module that touches `users` / `sessions`. |
| `modules/sites` | Sites and authorized network scopes |
| `modules/collectors` | Collector administration (create, token, revoke, scan request) |
| `modules/ingest` | Collector-facing gateway: enroll, heartbeat, telemetry; discovery + check processing |
| `modules/devices` | Inventory read model and manual metadata |
| `modules/monitoring` | Check definitions and time-series queries |
| `modules/events` | Event emission (`emitEvent`), timeline, audit log read |
| `modules/notifications` | Webhook channels |
| `modules/overview` | Dashboard aggregation |
| `modules/realtime` | SSE stream |
| `jobs/*` | collector-watch, notification-dispatch, retention |
| `infrastructure/db` | The two pools and `withTenant()` |

## 4. Tenant isolation (four layers)

1. **Database** — the app connects as `lan_app` (`NOBYPASSRLS`). Every tenant table has an RLS policy
   `organization_id = app_current_org()`. `withTenant(orgId, fn)` sets that value transaction-locally.
   With no tenant set, queries return zero rows. Child rows use composite foreign keys
   `(organization_id, parent_id)`, so a row cannot reference another tenant's parent.
2. **API** — organization and role come from the session row and membership table on every request;
   never from the request body. Cross-tenant ids answer `404`.
3. **Collector** — organization and site come from the credential's database row. A collector sending
   another tenant's scope/check ids gets those items rejected (and RLS would hide them anyway).
4. **Background jobs / realtime** — jobs run set-based SQL with explicit organization columns; the SSE
   stream is keyed by the session's organization and carries only "topic changed" hints.

Proven by `apps/api/tests/auth-and-tenancy.test.ts`.

## 5. Device identity

- A MAC address identifies a device within a site and follows it across IP changes.
- When no MAC is observable (routed subnet, loopback), identity is the IP and the device says so.
- A host seen without a MAC is matched to the device currently holding that IP; if a MAC shows up
  later the identity is upgraded.
- A device is `offline` only after 2 consecutive sweeps of its scope without an ICMP reply **and**
  without a reachable neighbour entry. If the site's only collector goes silent, devices become
  `unknown`, never `offline`.
- Sweeps that arrive late (buffered during an outage) and are older than applied data are stored as
  history but do not change live state.
- Classification: the only automatic inference in Phase 1 is "router" for the address the collector
  uses as default gateway, stored with its evidence. Manual classification always wins.

## 6. Monitoring state machine

Each sample is classified `ok` / `degraded` (above latency or loss threshold) / `down`. A check changes
state only after `failure_threshold` consecutive samples agree, and emits exactly one event per
transition, with the rule, thresholds and latest sample attached as evidence.

## 7. Frontend

Next.js App Router; the browser talks only to its own origin (`/api` is proxied), so the session cookie
is first-party and `SameSite=Lax`. Data is fetched through one hook (`useQuery`) that re-fetches when
the SSE stream reports a change, with a slow polling fallback. All colours come from design tokens;
state is always shown as text plus colour. Arabic uses logical CSS properties (start/end), so the layout
mirrors properly; addresses stay left-to-right.

## 8. Technical dependencies

| Component | Dependencies |
| --- | --- |
| API | express 5, pg, zod 4, pino, helmet, express-rate-limit, ipaddr.js, oui-data (IEEE registry) |
| API (dev) | typescript, vitest, supertest, embedded-postgres |
| Web | next 16, react 19, tailwindcss 4, recharts 3, lucide-react, clsx |
| Collector | pro-bing (ICMP), yaml.v3; everything else is the Go standard library |
