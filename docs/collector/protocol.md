# Collector architecture and protocol v1

## Architecture

```
sensorcmd                flags, logging, signal handling (run as `nigafiy-engine sensor`,
                         docs/architecture/engine-sensor.md; cmd/nigafiy-sensor is a dev-only build)
internal/config          YAML + env, strict validation, hard ceilings
internal/scope           what may be probed (private only, ≤ /20, optional local allow-list)
internal/discovery       rate/concurrency-limited ICMP sweep + neighbour table + rDNS
internal/identify        active local-link identification: mDNS/DNS-SD, SSDP/UPnP, NetBIOS
internal/dhcp            passive UDP/67 DHCP broadcast name/vendor learning + state/dhcp-names.json persistence
internal/netinfo         reads OS state: neighbour table, default gateway, interfaces (no packets)
internal/probe           ICMP / TCP / DNS measurements
internal/dnsfilter       optional local DNS filtering forwarder (categories, profiles, schedules, stats)
internal/snmp            read-only SNMP v2c/v3 switch polling (interfaces, 64-bit counters, FDB, LLDP)
internal/router          router connectors: client list, TOFU cert fetch, block/unblock, rate limit, schedule
internal/tools           on-demand IT Toolbox measurements (ping, tcp, 19-port scan, dns, rdns, traceroute)
internal/wol             scope-checked Wake-on-LAN magic packet sender
internal/spool           bounded on-disk outbox
internal/cloud           HTTPS client, error classes, backoff
internal/agent           orchestration loops: heartbeat, discovery, checks, SNMP, routers, DNS stats, upload
```

Goroutine loops share one root context; cancelling it (`SIGINT`/`SIGTERM`) stops them, flushes unsent
measurements to disk and exits.

**Discovery & identification** (low impact): one ICMP echo per address → read the host's neighbour table →
one reverse-DNS lookup and local identification query (mDNS/DNS-SD, SSDP/UPnP, NetBIOS) per device found,
supplemented by passive DHCP broadcast listening (`internal/dhcp`, persisted in `state/dhcp-names.json`).
A device that drops ICMP is still found if its neighbour entry is *reachable*; stale entries only supply
the MAC of hosts that answered. Scheduled discovery performs no port scanning (the 19-port IT Toolbox scan
runs only on explicit single-host operator command).

**Limits** — config defaults 32 concurrent / 50 packets per second; ceilings compiled into the binary
(128 / 500 / scopes ≤ /20, private ranges only). Floors: discovery ≥ 60 s, checks ≥ 10 s.

**Trust** — scopes, Wake-on-LAN targets, SNMP switches, router addresses, and LAN toolbox targets delivered
by the server are re-validated locally against the collector's authorized scopes (`allowed_cidrs` when set).
Commands use a closed allow-list:
- `run_discovery` — trigger an immediate discovery sweep
- `run_checks` — run all monitoring checks immediately
- `wake_device` — send a Wake-on-LAN packet inside an authorized scope
- `poll_snmp` — poll a configured SNMP switch immediately
- `run_tool` — run an IT Toolbox diagnostic (`ping`, `tcp`, `ports`, `dns`, `rdns`, `traceroute`)
- `router_refresh`, `router_fetch_certificate`, `router_block`, `router_unblock`, `router_rate_limit`, `router_schedule` — execute an explicit administrator router request

Unknown commands and unknown check kinds are ignored. There is no shell or arbitrary command execution.

**Offline behaviour** — the last configuration is cached on disk, so monitoring continues (and resumes
after a restart) while the server is unreachable. Batches are written to the spool first and deleted
only after a `200`. The spool is bounded (`spool_max_batches`, oldest dropped first).

**Privileges** — Linux: `CAP_NET_RAW` or unprivileged ping (`net.ipv4.ping_group_range`); host
networking so the LAN's layer 2 is visible. No root needed unless binding port 53 (`CAP_NET_BIND_SERVICE`).

## Protocol

Base path `/api/v1/collector`, JSON over HTTPS (or loopback HTTP in local development). Unknown fields are rejected.

### `POST /enroll` — no auth

```json
{ "enrollment_token": "lde_…", "hostname": "edge-1", "version": "0.1.0", "os": "linux", "arch": "amd64" }
```

`201 { "collector_id": "…", "credential": "ldc_<id>.<secret>", "heartbeat_interval_seconds": 30 }`

The token is single-use, expires after 24 h and is consumed atomically. `401` for anything else.
Organization and site are taken from the token's database row.

### `POST /heartbeat` — `Authorization: Bearer ldc_…`

```json
{ "version": "0.1.0", "hostname": "edge-1", "os": "linux", "arch": "amd64", "uptime_seconds": 120,
  "gateway_ip": "192.168.1.1", "interfaces": [{ "name": "eth0", "addresses": ["192.168.1.5/24"] }],
  "spool_depth": 0, "completed_commands": [] }
```

Response delivers `config` (`heartbeat_interval_seconds`, `discovery`, `checks`, `access`, `snmp_targets`, `routers`)
and pending `commands`. Commands are re-sent until acknowledged in `completed_commands`.

### `POST /telemetry` — `Authorization: Bearer ldc_…`

Carries batched items (`discovery_run`, `check_result`, `snmp_switch`, `dns_stats`, `tool_result`,
`router_status`, `router_action_result`).

Response `200 { "duplicate": false, "accepted": 2, "rejected": [{ "index": 0, "reason": "…" }] }`.

- Replayed `batch_id` → `duplicate: true`, nothing applied.
- Each item is processed in its own savepoint; a rejected item does not affect the others.
- Hosts outside the scope are dropped and counted; timestamps more than 5 min in the future are rejected.

### Collector reaction to responses

| Response | Reaction |
| --- | --- |
| 2xx | delete the batch from the spool |
| 400 / 413 / 422 | discard the batch (it can never succeed), log an error |
| 401 / 403 | stop uploading, keep monitoring locally, retry slowly, log that re-enrollment is needed |
| network error / 429 / 5xx | keep the batch, exponential backoff with jitter (2 s → 5 min) |

### Migration path to mutual TLS

The credential is already per-collector and revocable. mTLS replaces the bearer secret with a client
certificate issued at enrollment (the enroll response carries the certificate for a CSR sent by the
collector); the `ldc_` header stays accepted during a transition window. The collector already supports
a private CA via `ca_file`.
