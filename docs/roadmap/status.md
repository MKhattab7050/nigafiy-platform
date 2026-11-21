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
| Historical metrics | Hourly roll-ups (`check_results_hourly`), 90-day charts, separate roll-up retention | `modules/monitoring/rollup.ts` |
| Incident replay | Before / during / after timeline of everything at the site around an incident | incident detail |
| Topology | Internet → gateway → subnet segments → devices, built from the collector routing table, neighbour table, scopes and checks; every edge labelled observed / inferred with evidence, confidence and last-verified time; search, filters, drag, zoom, JSON export | `modules/topology` |

**Device identification (added after Phase 2):** the collector asks devices what they are over mDNS/DNS-SD, SSDP/UPnP and NetBIOS; the API stores what each device announced and classifies it with deterministic rules (`modules/devices/classify.ts`) that carry evidence and a high / medium / low confidence. The collector host itself is classified from its own report. A randomized MAC with no other evidence is shown as "Phone / tablet — low confidence".

On the real test network (5 phones with randomized MACs) **no phone answered any of the three protocols**, so they are typed by the low-confidence hint only and have no names. The parsers and rules are covered by tests, but mDNS/SSDP/NetBIOS answers from real devices have not been observed yet. To name them, the collector now **passively listens for DHCP client broadcasts** (`internal/dhcp`, UDP 67, receive-only — never sends or answers). When a device joins it broadcasts its hostname (option 12) and vendor class (option 60, e.g. `android-dhcp-14`, `MSFT 5.0`); these are matched by MAC to discovered devices, shown with name source "DHCP", and `android-dhcp*` classifies a phone with high confidence. On the Windows dev host the port bound successfully ("passive DHCP name learning is on"). Learned DHCP names are persisted to disk (`state/dhcp-names.json`, up to 4096 entries with a 30-day TTL) so they survive collector restarts. Limits: a name is only learned when a device joins or rebinds (normal lease renewals are unicast to the router and are not seen), and some phones send no hostname.

**Device controls and smart insights (added after Phase 2):** migration `004_device_controls.sql` adds device trust (`unreviewed` / `known` / `unwanted`), per-device alert mute, a device link on monitoring checks, and a payload on collector commands.
- Ingestion now raises a *warning* when an unreviewed device joins after the baseline, and a *critical* `unwanted_device_online` when an unwanted device is seen. Muted devices produce no online/offline events.
- Endpoints: `POST /devices/trust` (bulk), `POST /devices/:id/monitor` (one ping check that follows IP changes), and `POST /devices/:id/wake`.
- Wake-on-LAN adds the closed-list collector command `wake_device`. The API derives the broadcast address from the authorized scope containing the device. The collector re-checks it against its own scopes (`internal/wol`) and refuses anything else. Requests expire after 10 minutes.
- `GET /insights` (`modules/insights/rules.ts`) applies deterministic rules to stored facts. It returns a 0–100 score with each deduction, plus insights with evidence and actions. Arabic wording is rendered client-side from `code` + `params` (`lib/insights-text.ts`); evidence lines and score reasons stay English.
- Deliberately not built: ARP spoofing or packet-injection interference to disconnect devices. Blocking and rate-limiting are performed either via the DNS access-control filter (`005_access_control.sql`) or through explicit router integration (`017_router_control.sql`).
- Not verified: Wake-on-LAN waking a real machine (packet format and scope checks are unit-tested only).

**Access control that works with any router (added after Phase 2):** migration `005_access_control.sql` (site rules, profiles, per-device pause/rules, `dns_stats`).
- Collector package `internal/dnsfilter`: a filtering DNS forwarder (UDP + TCP, local clients only, upstream = router then 1.1.1.1 / 8.8.8.8, never itself). Devices are matched by MAC from the neighbour table, else by IP. Blocked names get `0.0.0.0` / `::` (NXDOMAIN for other types). Category lists: StevenBlack hosts (ads & malware, adult, gambling) downloaded daily and cached; social / video / games / chat and the encrypted-DNS list are built in. Bedtimes are evaluated in the collector host's local time. Statistics (requests, blocked, top 25 names per device) are sent every 5 minutes.
- The feature is off until an admin turns it on; it then binds port 53 (`dns_listen`, `LAN_COLLECTOR_DNS_LISTEN`, `off` disables).
- API: `GET /access`, `PUT /access/settings`, profiles CRUD + pause, `POST /devices/:id/pause`, `PATCH /devices/:id/access`, `GET /devices/:id/activity`. Insights: filter not running, no device using it, partial coverage, adult content blocked, encrypted-DNS bypass attempts.
- Verified: unit tests (Go) and 48 API tests; the real collector binary answered DNS on loopback (`127.0.0.1:15353`) over UDP and TCP — blocked category / custom / encrypted-DNS / adult names got `0.0.0.0`, allowed and normal names resolved through the router; the profile and pause reached the collector in its config; the page and device card were checked in English and Arabic.
- Not verified: real devices on the LAN using the filter (needs the router's DHCP DNS changed), port 53 on the LAN interface, Windows firewall prompt on a fresh install. Limits: VPNs, hard-coded resolvers and unlisted encrypted DNS bypass it; no speed limits; if the computer is off, devices pointed at it lose name resolution.

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

**Phases 3 & 4 — endpoint agent and remote administration (`012_endpoints.sql`, `013`–`015`, `agents/endpoint-agent`, `modules/endpoints`):**
- **Platforms:** company computers running the LAN Detective agent: **Windows**, **Linux** and **macOS**, from the fleet page (`/endpoints`) and a per-endpoint control page (`/endpoints/[id]`). **iOS and Android are not supported.** An earlier "MDM" for them was removed (`015_remove_mobile_mdm.sql`): it had no Apple MDM protocol (no APNs, no signed profiles, no check-in handling) and no Android device-policy app, so nothing it queued could ever run on a phone.
- **Capability list (`modules/endpoints/capabilities.ts`):** per platform, what the agent can do and what it needs (for example X11 tools on Linux, Screen Recording / Full Disk Access permissions on macOS). macOS remote desktop is **view-only**: mouse and keyboard input are not implemented there and the API refuses them. Commands the agent cannot run on a platform (sign-out off Windows, `gpresult` off Windows) are refused by the API instead of being queued.
- **Compliance (`evaluateCompliance`):** only from what the agent measured. The Windows agent reports the firewall (standard profile) and Microsoft Defender state when it can read them; disk encryption and pending updates are not measured on any platform, and nothing is reported for Linux or macOS. Unmeasured values are left out, so an endpoint with no evidence is "unknown", never "compliant". Each heartbeat replaces the reported posture, so a check that stops being reported disappears instead of keeping an old answer.
- **Policy:** two settings, both enforced: allowed file-manager folders (`allowed_fs_roots`, checked by the agent) and the remote-desktop consent mode (a "prompt" policy refuses sessions because the agent cannot ask yet).
- **Remote File Manager (`agents/endpoint-agent/internal/filemgr`, `components/remote-file-manager.tsx`):**
  - Browse drives/volumes, search, sort/filter, optionally show hidden/system files; create folders and files, rename, copy, move, delete (explicit confirmation, admin only), upload (admin only) and download in base64 chunks with SHA-256 verification.
  - Never overwrites: creating, renaming, copying or moving onto an existing name is refused (copying a file into its own folder used to truncate it).
  - Path guards: no `..` segments, no UNC/network or `\\?\` / `\\.\` device paths, credential stores blocked (the registry hive folder `System32\config`, `/etc/shadow`, `/root/.ssh`, Keychains), OS folders protected from changes (wherever Windows is installed, `/boot`, `/proc`, `/sys`, `/usr/bin`, ...). Symlinks and Windows junctions are resolved, so a link inside an allowed folder cannot lead outside it.
- **Live Remote Desktop (`agents/endpoint-agent/internal/remotedesktop`, `components/remote-desktop-console.tsx`):**
  - Captures frames with GDI on Windows, `scrot` / `gnome-screenshot` / ImageMagick `import` on Linux X11 and `screencapture` on macOS. When there is no interactive desktop (for example a Windows service in session 0) the capture fails with a clear error; no placeholder image is ever sent. Capture and input are accepted only inside a started session, and starting or ending a session shows a notice on the endpoint's screen naming the operator. A policy that requires the user's consent refuses to start.
  - Input: `SetCursorPos` / `mouse_event` / `keybd_event` on Windows; `xdotool` on Linux X11 using the screen size it reports (no assumed resolution); none on macOS. Session recording is not implemented and the API refuses a request for it.
- **Remote administration (`internal/control`, `endpoint_commands`):**
  - Fast command poll (`/api/v1/agent/poll`), immediate result upload (`/api/v1/agent/command-result`), `?wait_ms=` on the API. Commands are delivered at most once.
  - `kill_process` (never the agent itself), `service_action` (PowerShell / `systemctl` / `launchctl`), `power_action`, `notify_user`, `software_action` (`winget` / `apt-get` / `brew`, admin only), `fetch_logs` (`Get-WinEvent` / `journalctl` / `log show`), and allow-listed `diagnostic_command`. Service names, package ids and DNS targets must start with a letter or digit (checked by both API and agent) so they can never be read as program options, and `apt-get`, `brew` and `systemctl` get `--` before them.

**Platform governance, router control & operational workflows (`016`–`020`):**
- **Smart defaults & automation (`016_automation.sql`, `modules/automation`):** catalogue of safe, deterministic automations with per-organization and per-site overrides (`automation_settings`) and explicit actor tracking (`user` / `system` / `collector`) in `audit_logs`.
- **Router control (`017_router_control.sql`, `modules/routers`, `collectors/lan-collector/internal/router`):** reads connected clients, Wi-Fi signal/interface details, and active blocks from site routers (`site_routers`, `router_clients`) and executes explicit admin requests (`router_refresh`, `router_fetch_certificate`, `router_block`, `router_unblock`, `router_rate_limit`, `router_schedule` in `router_requests`). Credentials are AES-256-GCM encrypted and write-only; TLS trust supports `https`, `https-pinned` (TOFU SHA-256 certificate pinning), and explicit `http`; lockout protection (`login_paused_until`) prevents repeated bad logins; and `router_blocks` tracks pre-existing blocks so LAN Detective never lifts a block an administrator created on the router directly.
- **Team accounts, invitations, password reset & TOTP MFA (`018_team_accounts.sql`, `modules/auth`):** member invitations (`invitations`), member deactivation/reactivation (`memberships.status`), self-service and admin-issued password resets (`auth_tokens`), RFC 6238 TOTP multi-factor authentication with AES-256-GCM encrypted secrets, replay prevention (`mfa_last_step`), brute-force lockout (`mfa_locked_until`), SHA-256 hashed single-use recovery codes (`user_recovery_codes`), organization-level MFA policy (`off` / `admins` / `all`), and explicit opt-in account email delivery (`use_for_account_emails`).
- **Maintenance windows (`019_maintenance.sql`, `modules/maintenance`):** one-off and weekly recurring windows evaluated in the site's wall-clock timezone (`maintenance_windows`, `maintenance_runs`), scoped to the whole site/org or specific devices, checks, and collectors. Matching events during a window are recorded with `in_maintenance = true` without opening incidents or dispatching alert notifications.
- **Global search, summary reports, system self-check & themes (`020_search_indexes.sql`, `modules/overview`, `modules/system`):** `pg_trgm` GIN trigram indexes powering instant global search (`GET /api/v1/search`) across devices, endpoints, incidents, scopes, switches, and checks; printable executive/technical summary report (`GET /reports/summary`, opened from the top bar, not a separate page); the module self-check `GET /system/modules`, shown in **Settings → System self-check** (jobs, last run, last error, overdue and not-scheduled jobs); and full Light / Dark theme support alongside English / Arabic (RTL).

**Phase 5 / 6 work from the parallel builders (`021`–`026`), finished in Milestone 0b (2026-11-21):**

| Feature | API + DB | Collector | Web UI | Tests |
| --- | --- | --- | --- | --- |
| Switch port control: disable/enable, VLAN, quarantine over SNMP SET (`021`, `modules/ports/control`) | built | built (`internal/agent/switchports.go`) | built (`features/ports/components/site-port-control.tsx`) | API + Go; doc `docs/features/switch-port-control.md` |
| Config backup + diff over SSH, vendor auto-detect (`022`, `modules/configbackup`) | built | built (`internal/configbackup`, `internal/agent/configbackup.go`) | built (`/config-backup`, `/config-backup/[id]`, card on the device page) | API + Go; doc `docs/features/config-backup.md` |
| Smart security checks: rogue DHCP, UPnP IGD audit, Wi-Fi analyser, DHCP/HTTP fingerprinting (`023`, `modules/security`) | built | built (`internal/agent/smartchecks.go`, `internal/smart`; scheduled + run now, scope re-checked at every layer) | built (`/security`) | API + Go; doc `docs/features/smart-checks.md` |
| Approval-gated playbooks (`024`, `modules/playbooks`) | built | n/a | built (`/playbooks`, editor, `/playbooks/runs`, run detail with approvals) | API; doc `docs/features/playbooks.md` |
| Knowledge memory (`025`, `modules/knowledge`) | built | n/a | built (`/knowledge`, `/knowledge/[id]`) | API |
| Optional AI assistant, off by default, admin's own key (`026`, `modules/assistant`) | built | n/a | built (`/assistant`) | API |
| Impact analysis (digital twin) and MSP portfolio (`modules/impact`, `modules/portfolio`) | built | n/a | built (`/impact`, `/portfolio`) | API (`modules.test.ts`) |

Milestone 0b finished the rows that were missing or partial at the baseline (collector wiring and Go tests for smart checks, the config backup, smart checks and playbooks screens, and their feature docs).

Milestone 0b verification (2026-11-21): `pnpm typecheck`, 161 API tests, collector and agent Go tests, web build and desktop tests pass. Real run on 192.168.1.0/24 against the dev stack: "run now" for rogue DHCP (one offer, from the router 192.168.1.2), UPnP (no gateway answered), Wi-Fi (host on Ethernet, 10 networks listed) and banners (7 devices probed) all returned ok and cleared their requests; the DHCP fingerprint check ran on schedule. **Not yet done:** the packaged-app smoke test with the new screens (`pnpm run pack` + `--local-smoke`).

## Verified in the development environment

**Baseline 2026-11-21 (before the Nigafiy restructuring):** `pnpm typecheck` clean; `pnpm test` 21 files / 161 tests passing; `pnpm test:collector`, `pnpm test:agent` and `go vet` clean; web production build; desktop unit tests (11); `pnpm run pack` in `apps/desktop`, and the unpacked app run with a scratch `--user-data-dir --local-smoke`: database, API and web started on 127.0.0.1, account created and signed in, collector enrolled and swept 192.168.1.0/24 (7 devices), clean quit. Fixed on the way: the packaged API could not start (`@lan-detective/shared-types` runtime values are now compiled into the bundle by `bundle-backend.mjs`), a knowledge candidate's detail page did not pick up later incident comments, and two stale test expectations.

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
- Notifications: webhook and SMTP email, with scheduled maintenance windows (`019_maintenance.sql`). No multi-tier alert escalation, external SSO (SAML/OIDC), or billing.
- Endpoint management covers Windows, Linux and macOS computers with the agent. Phones and tablets are not managed (no iOS/Android support); they still appear as discovered network devices. On macOS, remote desktop is view-only and the agent's Linux/macOS builds have only been cross-compiled and unit-tested, not run on those systems.
- AI is not used anywhere. The planned AI layer only rephrases and ranks what the rule engine found.

## Risks and assumptions

| Risk / assumption | Mitigation |
| --- | --- |
| A rule misattributes a fault | Confidence is `high` only when independent measurements agree; alternatives are listed; evidence is always shown; rules are pure functions with unit tests |
| Gateway that ignores ICMP looks "down" | Rule lowers confidence when internet still works and suggests a TCP check instead |
| ICMP + ARP misses devices silent to both | Stated in the event evidence; SNMP bridge tables and router client tables add sources |
| In-process jobs and rate limits | Advisory locks make jobs single-runner; move to Redis/BullMQ when scaling out |
| Raw time-series growth | Per-organization raw retention + hourly roll-ups; hypertable when TimescaleDB is available |
| `embedded-postgres` is a development convenience | Production needs an operated PostgreSQL |

## Roadmap

The product brief of 2026-11-10 defines the target: a local-first, on-premise network operations,
endpoint management and remote administration suite for company-owned, enrolled devices, built in
six phases. Status against it:

| Phase | In the brief | State |
| --- | --- | --- |
| 1 Core platform | structure, database, auth, RBAC, desktop app, API, live dashboard, inventory, discovery, collector | **Built.** Includes member invitations, TOTP MFA + recovery codes, password reset, self-contained & remote desktop app modes, and Light/Dark + EN/AR themes |
| 2 Network intelligence | SNMP, monitoring, topology, charts, IPAM, switch ports, alerts, Network Doctor, IT toolbox | **Built.** Interface history charts, switch-level FDB/LLDP topology, IPAM conflict events, email notifications, maintenance windows, and IT toolbox (Ping, TCP, Common ports, DNS, rDNS, Traceroute) are all implemented and tested |
| 3 Endpoint management | Go endpoint agent, enrollment, inventory, health, software inventory, activity telemetry | **Built** for Windows/Linux/macOS: `agents/endpoint-agent`, `/api/v1/agent/*`, `/api/v1/endpoints/*`, `/endpoints` UI with per-platform capabilities, evidence-only compliance and auto-linking to LAN devices. Mobile device management (iOS/Android) is not built: it needs Apple MDM (APNs certificate, signed profiles, check-in protocol) and an Android device-policy app |
| 4 Remote administration | processes, services, power/session actions, user messaging, command audit, Remote File Manager, live Remote Desktop, software & logs | **Built.** Live Remote File Manager (`internal/filemgr`), live Remote Desktop (`internal/remotedesktop`), process termination, service start/stop/restart, software install/remove/upgrade, event log retrieval, allow-listed diagnostic terminal, lock/logoff/restart/shutdown, on-screen user messaging, and full audit log |
| 5 Infrastructure control & security | router / switch / firewall control, VLAN operations, quarantine, security intelligence, config backup, automation | **In progress.** DNS-based access control (`005`), smart-default automation (`016`), and router control (`017`: client lists, block/unblock, rate limits, schedules, TOFU cert pinning, block ledger) are built. Switch port write actions / VLAN reconfiguration, device config backups, and multi-step workflow automation remain |
| 6 Intelligence | AI assistant, knowledge memory, incident replay, digital twin, reports, multi-site / MSP | **In progress.** Incident replay, multi-tenant data model, trigram global search (`020`), and printable summary reports (`/reports`) are built. AI assistant, knowledge memory, and digital twin simulation remain |

**Next, in order:**
1. Complete Phase 5: switch port write controls / VLAN assignment, network device configuration backup & version diffing, and multi-step workflow automation with approval gates.
2. Complete Phase 6: optional AI explanation layer on top of deterministic Network Doctor diagnoses, incident resolution knowledge memory, and multi-site MSP roll-up views.

**Decisions the brief forces** (to make when Phases 3–4 start):
- `docs/security/model.md` states that remote command execution is deliberately absent and that the collector protocol cannot carry one. That stays true for the network collector. Remote administration goes through the separate endpoint agent, installed and enrolled per machine, with its own protocol, permissions and audit trail.
- The API is currently something the collector dials out to; the desktop app runs it on loopback only. Serving agents on other machines means listening on the LAN interface with TLS, which does not exist yet.
- Repository layout: `collectors/lan-collector` stays; the endpoint agent goes to `agents/endpoint-agent`. Moving existing apps to match the brief's suggested tree would churn every import for no functional gain.

Each module appears in the navigation only when it is implemented.
