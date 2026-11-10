# Collector architecture and protocol v1

## Architecture

```
cmd/lan-collector        flags, logging, signal handling
internal/config          YAML + env, strict validation, hard ceilings
internal/scope           what may be probed (private only, ≤ /20, optional local allow-list)
internal/discovery       rate/concurrency-limited ICMP sweep + neighbour table + rDNS
internal/netinfo         reads OS state: neighbour table, default gateway, interfaces (no packets)
internal/probe           ICMP / TCP / DNS measurements
internal/spool           bounded on-disk outbox
internal/cloud           HTTPS client, error classes, backoff
internal/agent           four loops: heartbeat, discovery, checks, upload
```

Four goroutine loops share one context; cancelling it (SIGINT/SIGTERM) stops them, flushes unsent
measurements to disk and exits.

**Discovery method** (low impact): one ICMP echo per address → read the host's neighbour table →
one reverse-DNS lookup per device found. A device that drops ICMP is still found if its neighbour
entry is *reachable*; stale entries only supply the MAC of hosts that answered. No port scanning.

**Limits** — config defaults 32 concurrent / 50 packets per second; ceilings compiled into the binary
(128 / 500 / scopes ≤ /20, private ranges only). Floors: discovery ≥ 60 s, checks ≥ 10 s.

**Trust** — a scope delivered by the cloud is re-validated locally; with `allowed_cidrs` set, the
collector refuses anything outside it. Only one command kind exists (`run_discovery`); unknown commands
and unknown check kinds are ignored. There is no remote execution.

**Offline behaviour** — the last configuration is cached on disk, so monitoring continues (and resumes
after a restart) while the cloud is unreachable. Batches are written to the spool first and deleted
only after a `200`. The spool is bounded (`spool_max_batches`, oldest dropped first).

**Privileges** — Linux: `CAP_NET_RAW` or unprivileged ping (`net.ipv4.ping_group_range`); host
networking so the LAN's layer 2 is visible. No root needed.

## Protocol

Base path `/api/v1/collector`, JSON over HTTPS. Unknown fields are rejected.

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

Response:

```json
{ "server_time": "…",
  "config": { "heartbeat_interval_seconds": 30,
              "discovery": { "interval_seconds": 300, "scopes": [{ "id": "…", "cidr": "192.168.1.0/24" }] },
              "checks": [{ "id": "…", "kind": "icmp", "target": "auto:gateway", "port": null, "interval_seconds": 30 }] },
  "commands": [{ "id": "…", "kind": "run_discovery" }] }
```

Commands are re-sent until acknowledged in `completed_commands`.

### `POST /telemetry` — `Authorization: Bearer ldc_…`

```json
{ "batch_id": "<uuid>", "sent_at": "…", "items": [
  { "type": "discovery_run", "run_id": "<uuid>", "scope_id": "…", "trigger": "scheduled",
    "started_at": "…", "finished_at": "…", "hosts_probed": 254,
    "hosts": [{ "ip": "192.168.1.10", "mac": "00:11:22:33:44:55", "hostname": "nas.lan", "rtt_ms": 0.4,
                "sources": ["icmp", "arp_cache", "rdns"] }] },
  { "type": "check_result", "check_id": "…", "ts": "…", "ok": true, "latency_ms": 12.4,
    "loss_pct": 0, "jitter_ms": 0.8, "resolved_target": "192.168.1.1" } ] }
```

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
