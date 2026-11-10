# Status, gaps, risks and roadmap

## Implemented

**Phase 1 — functional core:** accounts and roles, tenant isolation (PostgreSQL RLS), sites and
authorized scopes, collector enrollment / heartbeat / buffering, ICMP + neighbour-table discovery,
device inventory and identity tracking, ICMP / TCP / DNS checks, dashboard, event timeline, signed
webhooks, audit log, English + Arabic (RTL).

**Phase 2 — network intelligence:**

| Module | What it does | Where |
| --- | --- | --- |
| Incident management | Correlates events into incidents (network path per site, service check, collector, critical device), auto-resolves on recovery, acknowledge / assign / comment / manual resolve with a note | `modules/incidents` |
| Network Doctor | Deterministic rule engine (`rules-v1`): LAN vs gateway vs WAN/ISP vs DNS vs remote target vs quality, service and device rules, collector-gap explanation from buffered samples. Every diagnosis carries evidence, what was ruled out, alternatives, confidence + reason, steps, and cited past incidents | `modules/doctor` |
| Run diagnostics now | `run_checks` collector command | collector `agent.go` |
| Time Machine | Point-in-time snapshot (device status and IP then, check states, open incidents, ±30 min events) and comparison of two periods | `modules/timemachine` |
| Historical metrics | Hourly roll-ups (`check_results_hourly`), 90-day charts, separate roll-up retention | `jobs/rollup.ts` |
| Incident replay | Before / during / after timeline of everything at the site around an incident | incident detail |
| Topology | Internet → gateway → subnet segments → devices, built from the collector routing table, neighbour table, scopes and checks; every edge labelled observed / inferred with evidence, confidence and last-verified time; search, filters, drag, zoom, JSON export | `modules/topology` |

**Device identification (added after Phase 2):** the collector asks devices what they are over mDNS/DNS-SD, SSDP/UPnP and NetBIOS; the API stores what each device announced and classifies it with deterministic rules (`modules/devices/classify.ts`) that carry evidence and a high / medium / low confidence. The collector host itself is classified from its own report. A randomized MAC with no other evidence is shown as "Phone / tablet — low confidence".

On the real test network (5 phones with randomized MACs) **no phone answered any of the three protocols**, so they are typed by the low-confidence hint only and have no names. The parsers and rules are covered by tests, but mDNS/SSDP/NetBIOS answers from real devices have not been observed yet. To name them, the collector now **passively listens for DHCP client broadcasts** (`internal/dhcp`, UDP 67, receive-only — never sends or answers). When a device joins it broadcasts its hostname (option 12) and vendor class (option 60, e.g. `android-dhcp-14`, `MSFT 5.0`); these are matched by MAC to discovered devices, shown with name source "DHCP", and `android-dhcp*` classifies a phone with high confidence. On the Windows dev host the port bound successfully ("passive DHCP name learning is on"). Limits: a name is only learned when a device joins or rebinds (normal lease renewals are unicast to the router and are not seen), the learned table lives in collector memory (lost on restart), and some phones send no hostname. Whether real phone names arrive on the test network is not yet confirmed — it needs a phone to reconnect while the collector runs. Reading the router's client table remains an alternative (not built).

## Verified in the development environment

| What | How |
| --- | --- |
| API, phases 1 + 2 | 33 integration tests against real PostgreSQL (`pnpm test`), including Doctor rules, incident lifecycle, Time Machine reconstruction, topology evidence, roll-ups, tenant isolation of the new endpoints |
| Collector | Go tests (`pnpm test:collector`), including the new command path |
| Real collector ↔ API ↔ database | `scripts/e2e-smoke.mjs` (loopback range, real ICMP, real internet/DNS checks) — run for Phase 1; not re-run after the Phase 2 collector change |
| Real LAN | The collector binary swept a real home/office Wi-Fi network (192.168.1.0/24, Windows host): 7 devices with MAC addresses, router vendor from the IEEE registry, randomized MACs flagged, the collector host's own MAC read from its interface, real gateway / internet / DNS checks, topology with observed layer-2 edges |
| Web app | Type-check, production build, manual check of every Phase 2 page in a browser using `scripts/seed-simulated.mjs` |

`scripts/seed-simulated.mjs` creates an organization named **"SIMULATED demo (not real data)"** and
feeds it invented telemetry through the real API. It is for looking at the UI only.

## Not verified — treat as untested

- Phase 2 on real hardware: incidents, diagnoses and topology were exercised with test and simulated
  telemetry, not with a real outage on a real LAN.
- A real outage on the real LAN (discovery and checks ran there; no fault occurred, so incident and diagnosis paths were not triggered by real data).
- Larger or wired networks, managed switches, multiple subnets.
- `docker-compose.yml`, the collector `Dockerfile`, the systemd unit; the collector at runtime on Linux.
- Go race detector (needs cgo); automated browser tests; load and scale.
- Topology with several hundred devices (layout is designed for it; only ~20 simulated devices were viewed).

## Known limitations

- **Topology has no switch-level links.** Without SNMP/LLDP the honest map is subnet-level; devices are
  grouped by scope. The page says so.
- **Doctor rules cover the network path, services, critical devices and collectors.** Wi-Fi, DHCP,
  switch-port and interface-error diagnostics need data sources that arrive in Phase 3.
- **Baselines** are a 7-day average latency used in wording; they do not change state thresholds yet.
- **Diagnosis text and event titles are English**; UI chrome is translated.
- Time Machine check state is the last recorded transition before the moment; configuration-change
  history does not exist yet (no config backup module).
- Period comparison of periods older than ~25 days uses hourly roll-ups (coarser).
- Device status granularity equals the discovery interval; devices on routed subnets are IP-identified.
- Notifications: webhook only. No maintenance windows, escalation, member invitations, password
  reset, MFA or billing. Dark theme only.
- AI is not used anywhere. The planned AI layer only rephrases and ranks what the rule engine found.

## Risks and assumptions

| Risk / assumption | Mitigation |
| --- | --- |
| A rule misattributes a fault | Confidence is `high` only when independent measurements agree; alternatives are listed; evidence is always shown; rules are pure functions with unit tests |
| Gateway that ignores ICMP looks "down" | Rule lowers confidence when internet still works and suggests a TCP check instead |
| ICMP + ARP misses devices silent to both | Stated in the event evidence; SNMP bridge tables (Phase 3) add a source |
| In-process jobs and rate limits | Advisory locks make jobs single-runner; move to Redis/BullMQ when scaling out |
| Raw time-series growth | Per-organization raw retention + hourly roll-ups; hypertable when TimescaleDB is available |
| `embedded-postgres` is a development convenience | Production needs an operated PostgreSQL |

## Roadmap

**Phase 3 — advanced IT operations:** SNMP polling (interfaces, errors, discards), Port Detective
(bridge/FDB tables, LLDP/CDP → real switch-level topology), IPAM, configuration backup with encrypted
credentials, endpoint agent for servers, Wi-Fi controller integrations, reports, maintenance windows,
email notifications, member invitations.

**Phase 4 — intelligence and security:** Security Center, explainable trust score, knowledge articles
from resolved incidents, AI-assisted explanation over the deterministic rules, digital twin.

**Phase 5 — automation and commercial scale:** visual workflows with approvals, MSP hierarchy UI and
white-label, subscriptions and entitlements, public status pages, public API + SDK, on-premise packaging.

Each module appears in the navigation only when it is implemented.
