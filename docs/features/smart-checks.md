# Smart network checks (collector side)

Five read-only checks that the site's collector runs from its own host and reports to the server as
`smart_check` telemetry items. The server stores the results and decides what they mean (findings,
device identification). The collector only measures. This page covers what the collector does and
sends; the API side lives in `apps/api/src/modules/security`.

**Status: not yet verified on real hardware.** Every part described here is covered by unit tests
with test doubles and local `httptest` servers on 127.0.0.1. Nobody has run it against a real router,
DHCP server, Wi-Fi adapter or the dev stack on 192.168.1.0/24 yet.

## Where the code is

| Part | File |
| --- | --- |
| Schedule, "run now", building items, scope re-checks | `collectors/lan-collector/internal/agent/smartchecks.go` |
| Rogue DHCP probe | `internal/smart/dhcpprobe.go`, `dhcplisten_{windows,linux,other}.go` |
| UPnP IGD audit | `internal/smart/upnp.go` |
| Wi-Fi reading | `internal/smart/wifi.go`, `wifi_windows.go` (Native Wi-Fi API), `wifi_linux.go` (nmcli) |
| Banner probe | `internal/smart/banner.go` |
| DHCP fingerprint table | `internal/smart/fingerprint.go`, fed by the passive listener in `internal/dhcp` |
| Wire format (the source of truth) | `apps/api/src/common/smart-check-protocol.ts` |
| Schedule sent to the collector | `apps/api/src/modules/security/config.ts` (`buildSmartCheckConfig`) |

## Configuration and scheduling

Every heartbeat answer carries `config.smart_checks`:

```json
{
  "rogue_dhcp": { "enabled": true, "interval_seconds": 900, "listen_seconds": 4 },
  "upnp": { "enabled": true, "interval_seconds": 3600 },
  "wifi": { "enabled": true, "interval_seconds": 600 },
  "banners": { "enabled": true, "interval_seconds": 1800, "ports": [80, 443, 8080, 8443], "targets": ["192.168.1.20"] },
  "dhcp_fingerprints": { "enabled": true, "interval_seconds": 300 },
  "run_now": [{ "check": "upnp", "requested_at": "2026-11-21T12:00:00.000Z" }]
}
```

- An enabled check runs once when the collector gets its first configuration, then every
  `interval_seconds`. The collector never runs a check more often than once a minute, whatever the
  server says. If the setting is missing or 0, the interval is 15 minutes.
- A `run_now` entry runs its check once with `trigger: "manual"`, even when the schedule is off. Each
  entry is recognised by its `requested_at`: an entry the collector already answered does not run
  again, and a later `requested_at` runs again. If the check is already running, the request waits
  for that run to finish. Entries older than 15 minutes, and checks that cannot be run on request
  (`dhcp_fingerprints`), are ignored.
- A heartbeat without `smart_checks` stops every check.
- The schedule is cached on disk with the rest of the configuration, so checks continue after a
  restart while the server is unreachable. `run_now` entries are removed before caching, so a request
  is never replayed after a restart.
- Each check has at most one run going at a time. Runs happen in the background and never hold up
  discovery, monitoring or uploads.

## What goes on the wire

One run is one item, sent in its own telemetry batch:

```json
{
  "type": "smart_check", "ts": "2026-11-21T12:00:04.2Z", "run_id": "<new UUID v4>",
  "check": "rogue_dhcp", "trigger": "scheduled", "ok": true, "duration_ms": 4180,
  "dhcp": { "interfaces": [ ... ] }
}
```

- `ts` is when the run **finished**. The server clears "run now" requests made up to `ts`.
- A successful run carries exactly the block that matches `check` (`dhcp`, `upnp`, `wifi`,
  `banners`, `dhcp_fingerprints`). A failed run has `ok: false` and
  `error: { kind, message }`. It may also carry partial data of its own kind (for example the rogue
  DHCP interfaces that failed to listen).
- Error kinds: `listen_failed`, `no_interface`, `not_supported`, `command_failed`, `not_found`,
  `timeout`, `protocol`, `internal`. Anything unexpected, a panic inside a check included, is reported
  as `internal` and does not stop the collector.
- Text that comes from devices or nearby networks (SSIDs, page titles, UPnP names, hostnames) is made
  valid UTF-8, has control characters removed, and is cut to the protocol's limits before sending.
- If a check is turned off on this collector (its function in `Deps` is nil), its scheduled runs
  are skipped silently. A "run now" for it is answered with `not_supported`.
- If the collector shuts down in the middle of a run, nothing is reported for that run.

## Scope rule (all checks)

Every address the collector contacts must lie in a scope that the server delivered **and** that
passes this collector's own policy (`scope.Policy`: local `allowed_cidrs` allow-list, at most a
/20, no public or loopback ranges unless explicitly allowed for development). The collector checks
this itself, whatever the configuration says:

- rogue DHCP and UPnP only use host interfaces whose address is inside an authorized scope;
- UPnP keeps only answers from authorized addresses, reads the description and the control URL only
  from the gateway that answered, and never follows a redirect;
- banner targets outside the scopes, non-IPv4 addresses and repeats are dropped before any dial, and
  the dialer refuses any other address or port;
- results that name an unauthorized address are dropped before sending.

## The checks

### `rogue_dhcp`: rogue DHCP detection

**What it does.** On each authorized interface it sends **one DHCPDISCOVER** (broadcast flag set,
asking only for mask, routers, DNS, domain, lease time and server id) and listens for
`listen_seconds` (default 4, kept between 1 and 30). It records every DHCP server that offers. It
never sends a DHCPREQUEST, never takes a lease and never answers anything. This is the one deliberate
exception to the collector's receive-only DHCP rule.

**Sends:** `dhcp.interfaces[]`: `name`, `address`, `mac`, `scope_id` (the authorized scope of the
address), `listen_seconds`, `listen_error` (set when UDP 68 could not be opened; nothing was sent on
that interface) and `offers[]` (`server_id`, `source_ip`, `offered_ip`, `subnet_mask`, `routers`,
`dns`, `lease_seconds`, `domain`). At most 16 interfaces and 32 offers per interface, one offer per
server.

**Errors.** `no_interface` when no host interface is inside an authorized scope. `listen_failed`
when UDP 68 could not be opened on any interface; the per-interface reasons are in the block.

**Prerequisites.**
- UDP 68 (the DHCP client port) must be free for the collector to bind.
  - Windows: binds the interface address with `SO_REUSEADDR` next to the DHCP Client service. Allow
    inbound UDP 68 for the collector in Windows Defender Firewall.
  - Linux: binds `0.0.0.0:68` per interface with `SO_BINDTODEVICE`. Needs `CAP_NET_BIND_SERVICE`
    and `CAP_NET_RAW`.
  - macOS/BSD: needs permission to bind ports below 1024.
- The collector host must be on the network segment being checked. A DHCP server behind a relay or
  on another VLAN only answers if the relay forwards the broadcast.

**Limits.** `server_mac` is not filled in (a UDP socket does not show the sender's Ethernet address).
Servers that answer only by unicast to an existing lease are not seen.

### `upnp`: UPnP port-forward audit

**What it does.** Multicasts SSDP M-SEARCH requests for Internet Gateway Devices from each authorized
interface address and waits 3 s for answers. For each gateway that answers from an authorized
address (at most 8), it reads the device description and calls only two **read** actions:
`GetExternalIPAddress`, and `GetGenericPortMappingEntry` with index 0, 1, 2, … until the gateway says
the list has ended (UPnP errors 713/714/402/501). It never adds, deletes or changes a mapping.

**Sends:** `upnp.gateways[]`: `address`, `friendly_name`, `manufacturer`, `model`, `service_type`,
`external_ip`, `error` (for example UPnP 606 "not authorized"), `mappings_truncated` and `mappings[]`
(`protocol`, `external_port`, `remote_host`, `internal_client`, `internal_port`, `description`,
`enabled`, `lease_seconds`). At most 256 mappings per gateway. Mappings with an unknown protocol or a
non-IPv4 internal client are left out because they cannot be reported accurately. No gateway answering is a
successful run with an empty list.

**Errors.** `no_interface` when no host interface is inside an authorized scope.

**Prerequisites.** UPnP IGD enabled on the router. Outbound UDP to 239.255.255.250:1900 and inbound
answers to the collector's ephemeral port must be allowed by the host firewall.

**Limits.** HTTP timeout 5 s per request, 3 minutes for the whole run. IPv6 gateways are not audited.

### `wifi`: Wi-Fi analyzer input

**What it does.** Reads the collector host's **own** Wi-Fi adapter: its current link and the networks
that the adapter already lists from its own background scans. It never starts a scan and never
connects to anything.

**Sends:** `wifi`: `platform`, `interface`, `connected`, `link` (SSID, BSSID, channel, band,
frequency, signal, security, `rx_mbps`/`tx_mbps`, `phy`) and `networks[]` (at most 256, `truncated`
when cut). Networks whose frequency does not map to a known 2.4/5/6 GHz channel are left out rather
than guessed, because the protocol requires the band. A link without a known band is left out while
`connected` stays true.

**Errors.** `no_interface` (no Wi-Fi adapter, or it is off). `not_supported` (no WLAN AutoConfig
service, location access denied on Windows 11 24H2+, no NetworkManager on Linux, or any other OS).
`command_failed` (`nmcli` or a Native Wi-Fi call failed). `protocol` (unexpected output).
`timeout` (30 s).

**Prerequisites.**
- Windows: the Native Wi-Fi API (`wlanapi.dll`, the same source as `netsh wlan`) and the WLAN
  AutoConfig service. On Windows 11 24H2 and later, location access for desktop apps must be on
  (Settings → Privacy & security → Location), or Windows hides BSSIDs and nearby networks.
- Linux: NetworkManager's `nmcli` (run as `nmcli -t -f IN-USE,SSID,BSSID,FREQ,SIGNAL,SECURITY,RATE device wifi list --rescan no`).
- macOS: not supported. Apps can only see SSIDs and BSSIDs with location permission, and a
  background collector does not have it.

**Limits.** It only covers what the collector host's adapter hears from where it stands. On Linux,
signal is a percentage only (no dBm).

### `banners`: device web banner probe

**What it does.** For each target the server lists (online devices not probed recently, at most 64
per run) it sends **one `GET /`** to each configured port (the server fixes these to 80, 443, 8080 and
8443). It uses TLS on 443 and 8443 and plain HTTP on the others. It does not follow redirects, uses
no proxy and no keep-alive, waits at most 3 s per request and reads at most 64 KiB. Nothing else is
sent: no credentials, no other path, no form. Certificate verification is skipped **only** so the
device's own certificate can be read; the result states whether that certificate was self-signed.

**Sends:** `banners.probed[]` (every address contacted, so "nothing answered" is recorded too) and
`banners.results[]`: `ip`, `port`, `scheme`, `status`, `title` (the first `<title>` with entities
decoded and whitespace collapsed, at most 120 bytes), `server` (the `Server` header),
`tls_subject`, `tls_issuer`, `tls_self_signed`.

**Scheduling.** A scheduled pass with no target due sends nothing. An address probed by schedule is
not probed again by schedule for 30 minutes, even if the server still lists it before the result
arrives. "Run now" probes again straight away.

**Prerequisites.** None beyond the device being reachable from the collector on those ports.

**Limits.** A device that serves its interface on another port, or only after a redirect to another
path, shows only what `/` answers. For SHA-1 certificates, "self-signed" is decided by issuer equal to
subject, because Go refuses to verify SHA-1 signatures.

### `dhcp_fingerprints`: DHCP option fingerprints

**What it does.** The passive DHCP listener (UDP 67, **receive-only**: it never sends or answers)
hands every client message it parses to a table. For each MAC the table keeps option 55 (the
parameter request list, in the client's order), option 60 (vendor class), option 12 (hostname) and,
from a DHCPREQUEST only, option 54 (the server the client chose). Every `interval_seconds` (300) the
collector reports what it heard since the last report and empties the table. While the check is
off, whatever is heard is discarded.

**Sends:** `dhcp_fingerprints.clients[]`: `mac`, `prl` (for example `"1,3,6,15,119,252"`, cut on a
code boundary to 400 characters), `vendor_class`, `hostname`, `server_id`, `seen_at`. At most 1024
clients; when the table is full, the client heard least recently is dropped.

**Errors.** `listen_failed` when the passive listener could not open UDP 67 (the reason is in the
message). `not_supported` when passive DHCP listening is turned off on this collector.

**Prerequisites.** The same as passive DHCP name learning. UDP 67 must be free (no DHCP server on
the collector host). On Linux this needs `CAP_NET_BIND_SERVICE`. On Windows it needs an inbound
firewall rule for UDP 67.

**Limits.** Only clients whose broadcasts reach the collector's segment are heard. A client that
renews by unicast is not seen until it broadcasts again.

## Tests

- `internal/smart`: `TestParseOfferReadsServerAndOptions`, `TestParseOfferFixture`,
  `TestParseOfferRejectsWrongXID`, `TestParseOfferWithoutServerIDUsesSource`, `TestBuildDiscover`,
  `TestDHCPProbeCollectsOffersPerInterface`, `TestCleanTextKeepsLongFieldsAndStripsControls`,
  `TestParseSSDPLocation`, `TestParseIGDDescription`, `TestMappingFromFields`,
  `TestAuditGatewayReadsOnly`, `TestChannelOf`, `TestSecurityFromIEs`, `TestSplitNmcliTerse`,
  `TestParseNmcliWifiEscapedColons`, `TestNormalizeDropsWhatTheProtocolCannotCarry`,
  `TestBannerProbeOnlyInsideAllowedScopes`, `TestBannerProbeNothingAnswering`, `TestPageTitle`,
  `TestFingerprintTableKeepsOrderAndDedupes`, `TestFingerprintTableRules`, `TestFingerprintTableIsBounded`.
  The fixtures in `internal/smart/testdata/` were built by hand to the RFC and vendor formats. They
  are not captures from real devices.
- `internal/agent`: `TestSmartChecksScheduleAndRunNow`, `TestSmartChecksErrorKinds`,
  `TestSmartWiFiItemCarriesOnlyWhatTheProtocolAccepts`, `TestSmartBannersStayInScope`,
  `TestSmartFingerprintsFromPassiveListener`, `TestSmartChecksNotCachedWhenAbsent`. Every item these
  tests produce goes through a Go check of the protocol rules. With `SMART_ITEMS_OUT=<dir>` the
  items are also written out, so they can be checked against the real zod schema.
- Not unit-tested: the Windows Native Wi-Fi structure parsing (`wifi_windows.go`), the platform
  UDP 68 listeners, and the SSDP multicast search. These need real hardware.

## Still to do

- Run the collector against the dev stack on 192.168.1.0/24, press "run now" for each check, and
  confirm that `GET /api/v1/security` shows real results or a real error kind. Then replace the status
  line at the top of this page with what was verified.
