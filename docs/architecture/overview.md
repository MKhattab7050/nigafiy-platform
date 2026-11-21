# Architecture

## 1. Technical assessment of the starting point

The repository was empty. The development machine had Node 24 and pnpm; Go was installed for this
project; **Docker, PostgreSQL and Redis were not available**. Consequences, all deliberate:

| Constraint | Decision |
| --- | --- |
| No Docker / PostgreSQL | Development and tests run a real PostgreSQL from the `embedded-postgres` npm package. The schema is plain PostgreSQL, so it runs unchanged on a managed database or the compose file. |
| No TimescaleDB | Time series live in narrow, BRIN-indexed tables (`check_results`, `switch_port_samples`, `endpoint_samples`) and are aggregated with `date_bin()` and hourly roll-ups (`check_results_hourly`). Converting to hypertables later is a one-statement migration (see database.md). |
| No Redis | Background jobs use an in-process scheduler made single-runner with PostgreSQL advisory locks; real-time fan-out uses `LISTEN/NOTIFY`. Both are correct with several API instances. |
| Windows dev host | The collector and endpoint agent are developed on Windows and cross-compiled for Linux and macOS. |

## 2. System overview

```
 Customer network                                     Server (local or cloud)
┌─────────────────────────────┐   outbound HTTPS    ┌────────────────────────────────────────────┐
│ lan-collector (Go)          │ ──────────────────► │ API (Node/Express)                         │
│  discovery · checks · SNMP  │  enroll             │  /api/v1/collector/*  collector auth       │
│  DHCP · mDNS/SSDP/NetBIOS   │  heartbeat ⇄ config │  /api/v1/agent/*      endpoint agent auth  │
│  DNS filter · WoL · toolbox │  telemetry          │  /api/v1/*            session + CSRF + MFA │
│  router control · spool     │                     │  jobs: collector-watch, endpoint-watch,    │
└─────────────────────────────┘                     │        maintenance, notification-dispatch, │
┌─────────────────────────────┐   outbound HTTPS    │        retention, rollup, router-requests, │
│ endpoint-agent (Go)         │ ──────────────────► │        toolbox-expiry                      │
│  inventory · health · logs  │  enroll / heartbeat │  SSE  ◄── LISTEN/NOTIFY ──┐                │
│  processes · services · FS  │  long-poll commands └──────────┬────────────────┼────────────────┘
│  remote desktop · software  │                                │                │
└─────────────────────────────┘                        ┌───────▼────────────────┴───┐
   Browser ── same-origin ──► Next.js (web) ──/api────►│ PostgreSQL (RLS per tenant) │
                                                       └────────────────────────────┘
```

The server never opens an inbound connection into a customer network. Both `lan-collector` and
`endpoint-agent` dial out over HTTPS and poll for closed-list commands (`run_discovery`, `run_checks`,
`wake_device`, `poll_snmp`, `run_tool`, and `router_*` on the collector; structured endpoint actions on
the agent).

## 3. Module boundaries (API)

Each module under `apps/api/src/modules` owns its routes and SQL (25 modules total, wired in `modules/registry.ts`):

| Module | Responsibility |
| --- | --- |
| `modules/auth` | Users, sessions, CSRF, organization switching, member invitations, member deactivation, password reset, TOTP MFA & recovery codes |
| `modules/sites` | Sites and authorized network scopes |
| `modules/collectors` | Collector administration (create, enrollment token, revoke, manual scan request) |
| `modules/ingest` | Collector-facing gateway: enroll, heartbeat, telemetry (discovery, checks, SNMP, DNS stats, toolbox, router status/results) |
| `modules/devices` | Device inventory, deterministic classification (`classify.ts`), trust level, Wake-on-LAN, per-device ping monitor |
| `modules/monitoring` | Check definitions, state transitions, and raw + hourly roll-up time-series queries |
| `modules/incidents` | Event correlation into incidents, acknowledgement, assignment, activity stream, incident replay |
| `modules/doctor` | Deterministic Network Doctor diagnosis rule engine (`rules-v1`) |
| `modules/timemachine` | Point-in-time site snapshots and period-over-period comparison |
| `modules/topology` | Observed + inferred network graph (gateway, subnets, SNMP FDB/LLDP switches, devices) |
| `modules/insights` | Deterministic network health score (0–100) and actionable security/reliability insights |
| `modules/access` | Collector DNS filtering rules, profiles, schedules, and per-device query/block activity |
| `modules/ports` | Port Detective: SNMP v2c/v3 switch targets, switch port tables, FDB/LLDP MAC-to-port resolution, traffic rate history |
| `modules/ipam` | IP address management: subnet plans, static/DHCP-reservation/reserved records, conflict detection & lifecycle events |
| `modules/toolbox` | On-demand collector network tools (Ping, TCP port check, 19-port scan, DNS, rDNS, Traceroute) |
| `modules/endpoints` | Enrolled Windows/Linux/macOS endpoint agent gateway, inventory, compliance, Remote File Manager, live Remote Desktop, remote admin commands |
| `modules/automation` | Configurable smart defaults and automated actions with audit attribution |
| `modules/routers` | Router integration: encrypted credentials, TOFU certificate pinning, connected clients, block ledger, rate limits & schedules |
| `modules/maintenance` | One-off and recurring weekly maintenance windows in site wall-clock timezones |
| `modules/correlation` | Cross-domain event/incident correlation helpers |
| `modules/events` | Event emission (`emitEvent`), timeline, and append-only audit log queries |
| `modules/notifications` | Signed outbound webhooks and encrypted SMTP email channels |
| `modules/overview` | Dashboard aggregation, global search (`GET /api/v1/search`), and printable summary reports |
| `modules/system` | Platform self-check and runtime health status |
| `modules/realtime` | Per-organization SSE stream backed by PostgreSQL `LISTEN/NOTIFY` |
| `infrastructure/scheduler.ts` | Single-runner advisory-locked background job scheduler (collector/endpoint watch, maintenance, notification dispatch, retention, roll-ups, router requests, toolbox expiry) |
| `infrastructure/db` | Owner pool, RLS-enforced `lan_app` pool, and `withTenant()` |

## 4. Tenant isolation (four layers)

1. **Database** — the app connects as `lan_app` (`NOBYPASSRLS`). Every tenant table has an RLS policy
   `organization_id = app_current_org()`. `withTenant(orgId, fn)` sets that value transaction-locally.
   With no tenant set, queries return zero rows. Child rows use composite foreign keys
   `(organization_id, parent_id)`, so a row cannot reference another tenant's parent.
2. **API** — organization and role come from the session row and active membership table on every request;
   never from the request body. Cross-tenant ids answer `404`.
3. **Collector & Endpoint Agent** — organization and site come from the credential's database row.
   Telemetry items referencing another tenant's scope/check/target ids are rejected.
4. **Background jobs / realtime** — jobs run set-based SQL with explicit organization columns; the SSE
   stream is keyed by the session's organization and carries only "topic changed" hints.

Proven by `apps/api/tests/auth-and-tenancy.test.ts`.

## 5. Device identity and classification

- A MAC address identifies a device within a site and follows it across IP changes.
- When no MAC is observable (routed subnet, loopback), identity is the IP and the device says so.
- A host seen without a MAC is matched to the device currently holding that IP; if a MAC shows up
  later the identity is upgraded.
- A device is `offline` only after 2 consecutive sweeps of its scope without an ICMP reply **and**
  without a reachable neighbour entry. If the site's only collector goes silent, devices become
  `unknown`, never `offline`.
- Sweeps that arrive late (buffered during an outage) and are older than applied data are stored as
  history but do not change live state.
- Classification (`modules/devices/classify.ts`): combines mDNS/DNS-SD, SSDP/UPnP, NetBIOS, passive
  DHCP broadcast options (persisted in `state/dhcp-names.json`), IEEE OUI vendor lookup, router client
  tables, SNMP switch data, and gateway identity into deterministic rules with explicit confidence and
  evidence. Manual classification always wins.

## 6. Monitoring state machine

Each sample is classified `ok` / `degraded` (above latency or loss threshold) / `down`. A check changes
state only after `failure_threshold` consecutive samples agree, and emits exactly one event per
transition, with the rule, thresholds and latest sample attached as evidence. Events occurring during
an active maintenance window (`019_maintenance.sql`) are marked `in_maintenance` and do not open
incidents or trigger alert notifications.

## 7. Frontend

Next.js App Router; the browser talks only to its own origin (`/api` is proxied), so the session cookie
is first-party and `SameSite=Lax`. Data is fetched through `useQuery`, which re-fetches when the SSE
stream reports a change, with a slow polling fallback. All colours come from semantic design tokens
supporting both Dark and Light themes; state is always shown as text plus colour. Arabic uses logical
CSS properties (`start`/`end`), so the layout mirrors properly while network addresses stay left-to-right.

## 8. Technical dependencies

| Component | Dependencies |
| --- | --- |
| API | express 5, pg, zod 4, pino, helmet, express-rate-limit, ipaddr.js, oui-data (IEEE registry) |
| API (dev) | typescript, vitest, supertest, embedded-postgres |
| Web | next 16, react 19, tailwindcss 4, recharts 3, lucide-react, clsx |
| Collector & Agent | pro-bing (ICMP), gosnmp, dns, yaml.v3; everything else is the Go standard library |
