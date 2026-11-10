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

**Port Detective — switch ports over SNMP (added after Phase 2):** migration `006_port_detective.sql` (`snmp_targets`, `switch_ports`, `switch_fdb`).
- Collector package `internal/snmp` reads a managed switch read-only over SNMP v2c / v3: system name, interfaces (state, speed, errors, discards, octets), the forwarding table (MAC → port, with VLAN where the switch exposes it) and LLDP neighbours. A switch is read only when its address is inside an authorized scope; the collector re-checks this itself.
- Credentials are stored AES-256-GCM encrypted, never returned by the API, never written to the audit log or the collector's disk cache, and delivered only to the collector of that site over its authenticated channel.
- API (`modules/ports`): switches CRUD + "read now", port table with the devices on each port, `GET /devices/:id/port` ("where is this device plugged in" with kind direct / shared / behind, confidence and evidence), `GET /ports/find`. Events: `device_port_changed`, `switch_unreadable`, `switch_readable`. Insight when ports collect new errors.
- Verified: Go unit tests against the bundled simulator, 4 API tests, and the real collector binary reading `cmd/snmp-sim` (a **simulated** switch serving invented data) through the running stack.
- Not verified: any real switch. No hardware with SNMP was available (the test router does not offer it). CDP is not read. Port actions (disable / enable / VLAN change) are not built: this module is read-only.

**IPAM — IP address management (added after Phase 2):** migration `007_ipam.sql` (`ipam_subnets`, `ipam_addresses`).
- A subnet is an authorized scope. Observed facts (which device answers where, from discovery) and documented facts (the plan and the address records an administrator enters) are kept apart and compared; they are never merged.
- Subnet plan: VLAN ID, gateway, DNS servers, DHCP pool, notes. Without a documented gateway the page shows the default gateway the collector observes, labelled as observed. The DHCP pool is entered by hand — LAN Detective does not read DHCP server configuration or leases.
- Address records: static, DHCP reservation (MAC required) or reserved (kept free). Deterministic conflict rules with evidence (`modules/ipam/plan.ts`): two devices online at one address, a reserved address in use, a different MAC than documented, a static address inside the DHCP pool.
- Address map (one cell per address, paged by /24 for larger subnets), utilization, suggestions for the next free static address, per-address history of the devices that held it, CSV export (formula-safe), and a client-side subnet calculator with subnet splitting.
- Roles: viewers read, technicians document addresses, admins change the subnet plan. Every change is audited.
- Verified: 6 tests (rules + API + roles + tenant isolation) and the page in a browser against the running stack with the simulated organization, in English and Arabic (plan saved, validation error shown, address documented, conflict listed, calculator).
- Not verified: the CSV download button in a browser (the endpoint is tested), subnets larger than /24 in the UI, and the conflict rules that need an *online* device against real data (covered by tests only).
- Limits: IPv4 only; DNS records and DHCP leases are not read from servers; a subnet that is documented but not authorized for discovery cannot be recorded; conflict evidence lines are English.

**Closing Phase 2 — interface history, IPAM conflict events, switch-level topology, email notifications & IT Toolbox:**
- **Interface history (`008_interface_history.sql`):** derives traffic bit-rates (`in_bps`, `out_bps`) and error deltas from consecutive 64-bit SNMP octet/error counters (`switch_port_samples`), handling counter resets and gaps cleanly, with historical charts in the switch port table.
- **IPAM conflict events (`009_ipam_conflict_events.sql`):** tracks currently open IP conflicts in `ipam_open_conflicts` (`modules/ipam/events.ts`) so each conflict produces one `ip_conflict_detected` event when it appears and one `ip_conflict_resolved` event when it clears, rather than repeating every sweep.
- **Switch-level topology (`modules/topology/routes.ts`):** incorporates SNMP forwarding tables (`switch_fdb`) and LLDP neighbours into the topology graph so switches appear as infrastructure nodes with observed layer-2 links to the devices on their ports and inter-switch trunk links.
- **Email notifications (`010_email_notifications.sql`, `modules/notifications/email.ts`):** adds SMTP / STARTTLS / TLS email notification channels alongside signed webhooks, with AES-256-GCM encrypted SMTP passwords and SSRF protection against private/loopback mail hosts.
- **IT Toolbox (`011_toolbox.sql`, `collectors/lan-collector/internal/tools`, `modules/toolbox`):** on-demand diagnostics executed by the site collector (`run_tool` command): ICMP Ping, TCP port check, 19-port Common IT/Management Ports scanner (SSH, RDP, SMB, HTTP/S, VNC, WinRM/RPC, databases, printer ports on a single private LAN host), DNS lookup, Reverse DNS, and hop-by-hop Traceroute. Accessible from `/toolbox` and via one-click quick buttons on every device detail page.

**Phases 3 & 4 + Universal Endpoint Management (`012_endpoints.sql`, `013_universal_endpoints.sql`, `agents/endpoint-agent`, `modules/endpoints`):**
- **Universal Platform Coverage:** manages **Windows** (`windows_agent`), **Linux** (`linux_agent`), **macOS** (`macos_agent`), **Android Enterprise** (`android_device_owner`, `android_work_profile`, `android_companion`), and **Apple iOS / iPadOS MDM** (`ios_supervised_mdm`, `ios_byod_mdm`) from a single Fleet Dashboard (`/endpoints`) and a 10-tab Unified Control Center (`/endpoints/[id]`).
- **Dynamic Capability Matrix (`modules/endpoints/capabilities.ts`):** computes per-device capabilities (`full_agent_control`, `remote_desktop`, `remote_file_manager`, `process_control`, `service_control`, `software_management`, `diagnostic_terminal`, `event_logs`, `network_connections`, `power_controls`, `mdm_lock`, `mdm_wipe`, `mdm_lost_mode`, `mdm_app_distribution`) with explicit platform prerequisites and restrictions enforced by both API and UI.
- **Compliance & Policy Engine (`evaluateCompliance`):** automatically evaluates endpoints (`compliant` / `non_compliant`) against per-endpoint or tenant policies (`require_firewall`, `require_antivirus`, `min_free_disk_gb`, `min_battery_pct`, `allowed_roots`).
- **Complete Phase 4 — Remote File Manager (`agents/endpoint-agent/internal/filemgr`, `components/remote-file-manager.tsx`):**
  - Browse drives/volumes (`C:\`..`Z:\` on Windows, `/` on POSIX), navigate directories, search recursively, sort/filter, optionally view hidden/system files.
  - Create folders (`mkdir`), create files (`touch`), rename, copy, move, delete (requires `confirm_destructive: true`), and upload/download files with base64 chunking and end-to-end SHA-256 verification.
  - Enforces path traversal protection (`..`), forbidden credential store blocking (`SAM`, `SECURITY`, `/etc/shadow`, `/Library/Keychains`), protected OS directory guards (`C:\Windows\System32`, `/boot`, `/proc`, `/sys`, `/System`), and policy `allowed_roots`.
- **Complete Phase 4 — Live Remote Desktop (`agents/endpoint-agent/internal/remotedesktop`, `components/remote-desktop-console.tsx`):**
  - Captures live desktop frames (`native_gdi` via `user32.dll` / `gdi32.dll` `BitBlt` + `GetDIBits` on Windows, `import`/`scrot`/`gnome-screenshot` on Linux X11, `screencapture` on macOS, with automatic `session0_fallback` diagnostic canvas when Windows Session-0 isolation blocks interactive desktop capture).
  - Supports multi-monitor selection, resolution scale (`25%`–`100%`), JPEG quality (`30`–`90`), adaptive streaming loop, fullscreen mode, interactive mouse (`move`, `click`, `dblclick`, `down`, `up`, `wheel`) and keyboard (`keypress`, `keydown`, `keyup`, Ctrl+Alt+Del, Windows Key, Alt+Tab, Esc) input injection (`SetCursorPos` / `mouse_event` / `keybd_event` on Windows, `xdotool` on Linux, `osascript` on macOS).
  - Enforces session start/stop lifecycle, audit logging, and on-screen user transparency notice.
- **Cross-Platform IT Administration (`internal/control`, `endpoint_commands`):**
  - Fast 500ms command poll (`/api/v1/agent/poll`) + immediate result delivery (`/api/v1/agent/command-result`) with synchronous `?wait_ms=` API support.
  - `kill_process`, `service_action` (`sc`/`systemctl`/`launchctl`), `power_action` (`lock`, `logoff`, `restart`, `shutdown`), `notify_user`, `software_action` (`winget` / `apt-get` / `brew`), `fetch_logs` (`Get-WinEvent` / `journalctl` / `log show`), and allow-listed `diagnostic_command` (`ipconfig`, `route`, `arp`, `nslookup`, `whoami`, `systeminfo`, `netstat`, `gpresult`, `df`, `uptime`).
- **Android Enterprise & Apple iOS/iPadOS MDM (`POST /api/v1/agent/mdm/connect`, `GET /api/v1/endpoints/:id/apple-profile.mobileconfig`):**
  - Generates Android Enterprise DPC / Zero-Touch JSON provisioning bundles (`android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE`) and downloadable Apple `.mobileconfig` XML configuration profiles (MDM enrollment, Passcode policy, Wi-Fi).
  - Supports mobile battery/storage/security-patch inventory, `mdm_action` (`sync_policy`, `lock_device`, `reboot_device`, `enable_lost_mode`, `disable_lost_mode`, `push_wifi_profile`, `push_vpn_profile`, `wipe_device`), and managed app distribution (`software_action`), while strictly rejecting unsupported capabilities on mobile (e.g., unattended Remote Desktop on iOS, arbitrary filesystem browsing outside app sandboxes, or Lost Mode/Reboot on unsupervised BYOD iOS devices).

## Verified in the development environment

| What | How |
| --- | --- |
| API, phases 1–4 + Universal Endpoint Management (core + intelligence + controls + access + ports + IPAM + email + toolbox + universal endpoints) | 12 integration test suites against real PostgreSQL + RLS (`pnpm test`), including `tests/real-windows-agent.test.ts` which spawns the real compiled `endpoint-agent.exe` binary |
| Network Collector & Endpoint Agent | Go unit + lifecycle tests (`pnpm test:collector` and `pnpm test:agent`, covering `agent`, `control`, `filemgr`, `remotedesktop`, `sysinfo`) and binary builds (`pnpm build:collector`, `pnpm build:agent`) |
| Real Windows Endpoint Agent ↔ API ↔ database | `tests/real-windows-agent.test.ts`: compiled `agents/endpoint-agent/bin/endpoint-agent.exe` enrolled, uploaded real Windows host telemetry/processes/services/disks, executed live Remote File Manager (`touch`, `list`, `download` with SHA-256 verification, `delete`), captured a live Remote Desktop JPEG frame (`rd_capture`), and executed a live `whoami` diagnostic command |
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

- **Doctor rules cover the network path, services, critical devices and collectors.** Wi-Fi and DHCP
  server diagnostics are not built yet.
- **Baselines** are a 7-day average latency used in wording; they do not change state thresholds yet.
- **Diagnosis text and event titles are English**; UI chrome is translated.
- Time Machine check state is the last recorded transition before the moment; configuration-change
  history does not exist yet (no config backup module).
- Period comparison of periods older than ~25 days uses hourly roll-ups (coarser).
- Device status granularity equals the discovery interval; devices on routed subnets are IP-identified.
- Notifications: webhook and SMTP email. No maintenance windows, escalation, member invitations, password
  reset, MFA or billing. Dark theme only.
- Endpoint remote administration on Windows, Linux, and macOS covers live Remote Desktop (`native_gdi` / X11 / `screencapture` with `session0_fallback` when Windows Session-0 blocks interactive desktop access), Remote File Manager (chunked SHA-256 transfers, protected path guards), processes, services, software/package management, event logs, allow-listed diagnostics, power/session actions, and on-screen user notifications. On Android Enterprise and Apple iOS/iPadOS MDM, capabilities are strictly bounded by OS sandbox and MDM rules (`modules/endpoints/capabilities.ts`). Production Apple MDM push notifications require an Apple Push Notification service (APNs) MDM vendor certificate.
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

The product brief of 2026-11-10 defines the target: a local-first, on-premise network operations,
endpoint management and remote administration suite for company-owned, enrolled devices, built in
six phases. Status against it:

| Phase | In the brief | State |
| --- | --- | --- |
| 1 Core platform | structure, database, auth, RBAC, desktop app, API, live dashboard, inventory, discovery, collector | **Built.** Gaps: member invitations, MFA, password reset |
| 2 Network intelligence | SNMP, monitoring, topology, charts, IPAM, switch ports, alerts, Network Doctor, IT toolbox | **Built.** Interface history charts, switch-level FDB/LLDP topology, IPAM conflict events, email notifications, and IT toolbox (Ping, TCP, Common ports, DNS, rDNS, Traceroute) are all implemented and tested |
| 3 Endpoint management | Go endpoint agent, enrollment, inventory, health, software inventory, activity telemetry, Universal MDM | **Built.** `agents/endpoint-agent` (Windows/Linux/macOS) + Android Enterprise & Apple iOS/iPadOS MDM + `/api/v1/agent/*` + `/api/v1/endpoints/*` + `/endpoints` Fleet & Control Center UI with Dynamic Capability Matrix, compliance engine, and auto-linking to LAN devices |
| 4 Remote administration | processes, services, power/session actions, user messaging, command audit, Remote File Manager, live Remote Desktop, software & logs | **Built.** Live Remote File Manager (`internal/filemgr`), live Remote Desktop (`internal/remotedesktop`), process termination, service start/stop/restart, software install/remove/upgrade, event log retrieval, allow-listed diagnostic terminal, lock/logoff/restart/shutdown, MDM lock/wipe/lost mode, on-screen user messaging, and full audit log |
| 5 Infrastructure control & security | MikroTik / switch / firewall control, VLAN operations, quarantine, security intelligence, config backup, automation | Not started (DNS-based access control exists) |
| 6 Intelligence | AI assistant, knowledge memory, incident replay, digital twin, reports, multi-site / MSP | Incident replay and the multi-tenant data model exist; the rest is not started |

**Next, in order:**
1. Close Phase 2: interface history (bandwidth / errors over time from SNMP counters) with charts, switch-level topology from FDB + LLDP, IP-conflict events, email notifications, IT toolbox (ping, traceroute, DNS, port check run by the collector).
2. Phase 3: `agents/endpoint-agent` (Go, Windows service) with enrollment tokens, per-agent credentials, heartbeat, local buffering, inventory and health telemetry; policy-controlled collection; a visible notice on managed machines.
3. Phase 4 on top of the agent channel: processes, services, power actions, then file manager and command execution with role checks, per-action audit and approval for sensitive operations; remote desktop on an established stack (WebRTC or an RDP gateway) with an on-screen session notice.
4. Phases 5 and 6 as in the table.

**Decisions the brief forces** (to make when Phases 3–4 start):
- `docs/security/model.md` states that remote command execution is deliberately absent and that the collector protocol cannot carry one. That stays true for the network collector. Remote administration goes through the separate endpoint agent, installed and enrolled per machine, with its own protocol, permissions and audit trail.
- The API is currently something the collector dials out to; the desktop app runs it on loopback only. Serving agents on other machines means listening on the LAN interface with TLS, which does not exist yet.
- Repository layout: `collectors/lan-collector` stays; the endpoint agent goes to `agents/endpoint-agent`. Moving existing apps to match the brief's suggested tree would churn every import for no functional gain.

Each module appears in the navigation only when it is implemented.
