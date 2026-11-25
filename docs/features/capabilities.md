# What Nigafiy does today, by area

This table moved here from the root README. It lists what is implemented and connected to the real
backend. [roadmap/status.md](../roadmap/status.md) is the source of truth: it says, per feature, what ran
on real hardware and what is covered by tests only. Read its "Real hardware versus tests only" table
before relying on any row below.

| Area | Implemented |
| --- | --- |
| Accounts | Registration, login, logout, HttpOnly session cookie, scrypt password hashing, CSRF defence, rate limiting, team invitations, password reset, TOTP MFA with recovery codes, OIDC and SAML 2.0 sign-in ([sso.md](sso.md)) |
| Tenancy | Organizations, memberships, roles (owner / admin / technician / viewer), **PostgreSQL Row Level Security** on every tenant table |
| Sites & scopes | Sites, authorized network scopes (private ranges only, ≤ /20, explicit attestation, audit trail); IPv6 scopes no larger than /120 ([ipv6.md](ipv6.md)) |
| Sensor | Single-use enrollment token → per-Sensor credential, heartbeat, config + command polling, on-disk buffering, backoff, graceful shutdown; runs as `nigafiy-engine sensor` ([../architecture/engine-sensor.md](../architecture/engine-sensor.md)) |
| Discovery | ICMP sweep (rate + concurrency limited) + host neighbour (ARP) table + reverse DNS; MAC vendor from the IEEE registry; mDNS/DNS-SD, SSDP/UPnP, NetBIOS and passive DHCP names |
| Device inventory | Identity tracking across IP changes, new / offline / online / IP-changed / "IP answered by a different MAC" events, IP history, 7-day availability, tags, owner, notes, manual classification |
| Monitoring | ICMP (latency, loss, jitter), TCP port, DNS resolution, HTTP/HTTPS, TLS certificate expiry and SNMP OID checks ([watch-checks.md](watch-checks.md)); explainable state machine with flap damping; history charts 15 min → 30 days, 90 days from hourly roll-ups |
| Dashboard | Overview computed from stored data only, fault-domain hint (LAN vs WAN vs DNS), real-time updates over SSE |
| Events | Timeline with the evidence behind every event, filters, time ranges |
| Notifications | Email (SMTP / STARTTLS / TLS), signed webhooks (HMAC-SHA256), Telegram, Slack, Discord and ntfy, with retry + backoff, SSRF protection and escalation policies; secrets AES-256-GCM sealed |
| Incidents | Automatic correlation of alerts into incidents, auto-resolution, assignment, notes, before/during/after replay |
| Network Doctor | Deterministic, evidence-backed root-cause rules (LAN / gateway / WAN-ISP / DNS / service / device / collector / smart-check findings) with confidence and next steps |
| IT Toolbox | On-demand probes run from the site Sensor: ICMP ping, TCP port check, 19-port common IT/management service scanner, DNS lookup, reverse DNS, hop-by-hop traceroute; every target checked against the authorized scopes ([toolbox-scope.md](toolbox-scope.md)) |
| Time Machine | State of the network at any recorded moment; comparison of two periods; 90-day charts from hourly roll-ups |
| Topology | Evidence-based map (internet → gateway → switches / subnets → devices) using routing tables, ARP, SNMP forwarding tables, LLDP, CDP, MikroTik neighbours and MNDP ([neighbors-cdp-mndp.md](neighbors-cdp-mndp.md)); every link marked observed or inferred |
| Device controls | Approve devices (unreviewed / known / unwanted): unknown devices joining raise a warning, an unwanted device coming back raises a critical alert. Mute alerts per device, one-click "monitor every minute" (follows IP changes), Wake-on-LAN through the Sensor (only inside an authorized range), one-click Toolbox probes. Nigafiy never disconnects or interferes with devices by itself; blocking goes through the DNS filter or an explicit router control |
| Managed endpoints (Fleet) | Company computers running the Agent: **Windows**, **Linux**, **macOS** (`agents/endpoint-agent`). Per-platform capability list, compliance from measured evidence only ([fleet-compliance.md](fleet-compliance.md)), Remote File Manager, Remote Desktop (consent dialog, session banner, WebSocket + JPEG on every platform, WebRTC H.264 on Windows agents), processes, services, packages, patches, event logs, allow-listed diagnostics, remote shell (admins only, off by default), scripts and jobs, power actions and user messages ([fleet-pro.md](fleet-pro.md)). Phones and tablets (iOS/Android) are not managed |
| Access control (any router) | The Sensor can answer DNS for the network (point the router's DHCP DNS at it). Block categories and sites for the whole network, per profile or per device; pause the internet for a device or a profile; bedtimes; per-device activity. Encrypted-DNS endpoints are blocked so devices fall back to the rules. A device using a VPN or its own DNS can bypass it, and speed limits need router control; both stated in the UI |
| Router control | 16 vendor drivers: client list, block/unblock, rate limit, schedule, rename, Wi-Fi, DHCP reservations, port forwards and reboot where the firmware offers them, each re-read after the change ([router-controls.md](router-controls.md)) |
| Switch ports | Port Detective reads managed switches over SNMP (state, speed, traffic and error history, devices per port, "which port is this device plugged into"); port control over SNMP SET: enable/disable, VLAN, quarantine ([switch-port-control.md](switch-port-control.md)) |
| Security checks | Rogue DHCP, UPnP IGD audit, Wi-Fi analyser, DHCP/HTTP fingerprinting ([smart-checks.md](smart-checks.md)) |
| Config backup | SSH configuration backup, diff and secret sanitization; restore for Juniper Junos (`commit confirmed`) and Cisco IOS XE (`configure replace` with a revert timer), both tested only against SSH test doubles ([config-backup.md](config-backup.md)) |
| Mind | Knowledge memory, approval-gated playbooks ([playbooks.md](playbooks.md)), automation catalogue with overrides. No AI anywhere: everything is deterministic |
| Smart insights | Rule-based summary on the Overview: network score with the reasons behind it, and the few things worth doing now, each with evidence and a one-click action |
| IPAM | Per-subnet address map (IPv4 and IPv6): observed, documented and free addresses, subnet plan (VLAN, gateway, DHCP pool, DNS), static / reserved records, conflict detection + automatic conflict events with evidence, address history, CSV export, subnet calculator |
| Hub | Program switcher, global search ([global-search.md](global-search.md)), system self-check ([system-self-check.md](system-self-check.md)), in-app user guide in EN + AR ([user-guide.md](user-guide.md)), signed update check ([../operations/updates.md](../operations/updates.md)), MSP portfolio |
| Other | Audit log, English + Arabic (true RTL), light and dark themes, responsive layout, retention jobs, built-in LAN TLS for remote Sensors and Agents ([lan-tls.md](lan-tls.md)) |
