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

**Device controls and smart insights (added after Phase 2):** migration `004_device_controls.sql` adds device trust (`unreviewed` / `known` / `unwanted`), per-device alert mute, a device link on monitoring checks, and a payload on collector commands.
- Ingestion now raises a *warning* when an unreviewed device joins after the baseline, and a *critical* `unwanted_device_online` when an unwanted device is seen. Muted devices produce no online/offline events.
- Endpoints: `POST /devices/trust` (bulk), `POST /devices/:id/monitor` (one ping check that follows IP changes), and `POST /devices/:id/wake`.
- Wake-on-LAN adds the closed-list collector command `wake_device`. The API derives the broadcast address from the authorized scope containing the device. The collector re-checks it against its own scopes (`internal/wol`) and refuses anything else. Requests expire after 10 minutes.
- `GET /insights` (`modules/insights/rules.ts`) applies deterministic rules to stored facts. It returns a 0–100 score with each deduction, plus insights with evidence and actions. Arabic wording is rendered client-side from `code` + `params` (`lib/insights-text.ts`); evidence lines and score reasons stay English.
- Deliberately not built: disconnecting, blocking or throttling devices from LAN Detective (it would require ARP spoofing or similar interference). The UI explains how to block on the router instead, with the MAC to copy and a link to the gateway. Router integrations (reading the client list, blocking through a router API) are not built.
- Not verified: Wake-on-LAN waking a real machine (packet format and scope checks are unit-tested only).

**Access control that works with any router (added after Phase 2):** migration `005_access_control.sql` (site rules, profiles, per-device pause/rules, `dns_stats`).
- Collector package `internal/dnsfilter`: a filtering DNS forwarder (UDP + TCP, local clients only, upstream = router then 1.1.1.1 / 8.8.8.8, never itself). Devices are matched by MAC from the neighbour table, else by IP. Blocked names get `0.0.0.0` / `::` (NXDOMAIN for other types). Category lists: StevenBlack hosts (ads & malware, adult, gambling) downloaded daily and cached; social / video / games / chat and the encrypted-DNS list are built in. Bedtimes are evaluated in the collector host's local time. Statistics (requests, blocked, top 25 names per device) are sent every 5 minutes.
- The feature is off until an admin turns it on; it then binds port 53 (`dns_listen`, `LAN_COLLECTOR_DNS_LISTEN`, `off` disables).
- API: `GET /access`, `PUT /access/settings`, profiles CRUD + pause, `POST /devices/:id/pause`, `PATCH /devices/:id/access`, `GET /devices/:id/activity`. Insights: filter not running, no device using it, partial coverage, adult content blocked, encrypted-DNS bypass attempts.
- Verified: unit tests (Go) and 48 API tests; the real collector binary answered DNS on loopback (`127.0.0.1:15353`) over UDP and TCP — blocked category / custom / encrypted-DNS / adult names got `0.0.0.0`, allowed and normal names resolved through the router; the profile and pause reached the collector in its config; the page and device card were checked in English and Arabic.
- Not verified: real devices on the LAN using the filter (needs the router's DHCP DNS changed), port 53 on the LAN interface, Windows firewall prompt on a fresh install. Limits: VPNs, hard-coded resolvers and unlisted encrypted DNS bypass it; no speed limits; if the computer is off, devices pointed at it lose name resolution.
- Router connectors (real block / disconnect / speed limit through the router's API) are not built yet. The test network's router is a Zyxel VMG3625-T50B (ZCFG/DAL API, RSA+AES login).

## Verified in the development environment

| What | How |
| --- | --- |
| API, phases 1 + 2 + controls + access | 48 integration tests against real PostgreSQL (`pnpm test`), including Doctor rules, incident lifecycle, Time Machine reconstruction, topology evidence, roll-ups, tenant isolation of the new endpoints |
| Collector | Go tests (`pnpm test:collector`), including the new command path |
| Real collector ↔ API ↔ database | `scripts/e2e-smoke.mjs` (loopback range, real ICMP, real internet/DNS checks) — run for Phase 1; not re-run after the Phase 2 collector change |
| Real LAN | The collector binary swept a real home/office Wi-Fi network (192.168.1.0/24, Windows host): 7 devices with MAC addresses, router vendor from the IEEE registry, randomized MACs flagged, the collector host's own MAC read from its interface, real gateway / internet / DNS checks, topology with observed layer-2 edges |
| Desktop app, self-contained | Packaged app (`electron-builder --win dir`, copied outside the repository) opened in local mode with a fresh profile: started the bundled database, API and web server on 127.0.0.1 with Electron's own Node 22, created and signed in to the local account, authorized 192.168.1.0/24, enrolled the bundled collector (first sweep: 8 devices) and showed the dashboard; Quit stopped every process. The scan consent was given through the non-interactive test switch, not by clicking the dialog. The NSIS installer itself was built but not installed over the existing installation |
| One-command home use | `pnpm local` on Windows from a clean stop: started database, API and web, detected 192.168.1.0/24, created the account, authorized the range, enrolled the collector (passive DHCP on) and the devices appeared in the web app; a second run resumed without setup. The interactive prompts were exercised through their non-interactive path (`LD_SETUP_*` + `--yes`); the double-click `.cmd` file and macOS/Linux were not run |
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
