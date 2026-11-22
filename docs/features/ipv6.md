# IPv6 across Radar and IPAM

Nigafiy finds, lists and documents IPv6 devices and subnets alongside IPv4. A device can hold an
IPv4 address and several IPv6 addresses at once (link-local, unique-local, global, temporary privacy
addresses). Every address is recorded with how it was observed.

Migration: `038_ipv6.sql` (the `device_addresses` table, family-aware IPAM constraints, and the
rename of the conflict event).

## Prerequisites

- Authorize the IPv6 prefix of the LAN as a network scope (Radar → Discovery → site → Add range),
  for example `fd12:3456:789a:1::/64`. The same authorization rule applies as for IPv4.
- The collector must run on a machine attached to that link, with an address inside the prefix.
  The all-nodes echo goes out of the interface that holds the scope address. The neighbour table is
  per link.
- ICMPv6 needs socket privileges:
  - Linux: an unprivileged ICMP datagram socket (`net.ipv4.ping_group_range` must include the
    collector's group; it covers ICMPv6 too) or `CAP_NET_RAW`.
  - macOS: works unprivileged.
  - Windows: raw ICMPv6 sockets need the collector to run as a service or as administrator.
  - Without the privilege, no echo can be sent. Discovery then reports only the addresses that the
    OS neighbour table confirms as reachable, so it finds fewer devices. The run does not flag this
    separately.

## Which prefixes can be authorized (API `common/net.ts`, collector `internal/scope`)

| Prefix | Accepted | Discovery method |
| --- | --- | --- |
| Unique-local `fc00::/7`, global unicast `2000::/3`, link-local `fe80::/10`, `/48` or longer | yes | `neighbor`, or `sweep` when `/120` or longer |
| Larger than `/48` | no: `ipv6_too_large` | |
| Documentation (`2001:db8::/32`, `3fff::/20`), Teredo/ORCHID/benchmarking (`2001::/23`), 6to4 (`2002::/16`), AS112 (`2620:4f:8000::/48`), multicast, NAT64, unspecified | no: `ipv6_not_lan` | |
| IPv4-mapped `::ffff:0:0/96` | no: `ipv6_mapped` (authorize the IPv4 range instead) | |
| Zone index (`fe80::%eth0`) | no: `invalid_cidr` | |
| Loopback `::1/128` | only with `ALLOW_LOOPBACK_SCOPES` (development and tests) | |

**Why an IPv6 prefix larger than /120 is never swept.** A `/64`, the normal size of an IPv6 LAN,
holds 18,446,744,073,709,551,616 addresses. Probing them one by one would take longer than any
network will exist, and would flood the link. A `/120` has 256 addresses, the size of an IPv4 `/24`
sweep. For larger prefixes the collector asks the link instead (method below). The web shows the
method on each scope with this explanation, in English and Arabic.

## Discovery method (collector `internal/discovery/ipv6.go`, `internal/netinfo/ipv6.go`, `internal/probe/icmp6.go`)

For every interface of the collector's host that holds an address of the prefix:

1. Two ICMPv6 echo requests to the all-nodes group `ff02::1`, one second apart, with hop limit 1
   (they never leave the link). They are sent from the host's own address of the scope, so hosts
   answer from an address of the same scope (RFC 6724).
2. The host's IPv6 neighbour table is read. Each platform has a pure parser with table tests:
   - Linux: `ip -6 neigh`
   - Windows: `Get-NetNeighbor -AddressFamily IPv6`, or `netsh interface ipv6 show neighbors`
   - macOS: `ndp -an`
3. One paced unicast echo goes to each known address of the prefix that did not answer yet, at most
   1024 of them, at the scope's packets-per-second rate. For a `/120` or longer, every address of the
   prefix is echoed.
4. The neighbour table is read again, for MAC addresses, confirmed reachability and the router flag.
5. Reverse DNS (PTR) is looked up for every non-link-local address found. Names learned from DHCP
   (IPv4) are matched by MAC.

A device counts as present only when it answered an echo or the OS confirmed it reachable. A stale
neighbour entry alone is not presence.

Evidence per address (`sources`):
- `icmpv6_multicast`, `icmpv6`
- `ndp_cache`
- `local_interface`
- `rdns`, `dhcp`

## Devices with several addresses (API `modules/ingest/discovery`)

- `devices.current_ip` stays the one address the device is identified and watched by. When the
  device has an IPv4 address, that is the one; otherwise the preference is global, then
  unique-local.
- A dual-stack device is matched by MAC. Its IPv6 addresses become additional addresses: no new
  device and no "address changed" event. An IPv6-only device that later answers over IPv4 switches
  its current address to IPv4, again without an address-change event.
- Link-local addresses (`fe80::/10`) are only ever attached to a device already known by its MAC.
  They never create a device.
- `device_addresses` holds every address with its first/last seen time, its scope and its sources.
  The address class (`ipv4`, `link_local`, `unique_local`, `global`) is stored as a generated
  column. Addresses not seen for 30 days are removed (IPv6 privacy addresses rotate daily).
- Availability (online/offline) of an IPv6-only device follows its IPv6 scope's runs. The offline
  event names ICMPv6 / Neighbor Discovery as the method.

## Inventory (web)

- Device list: under the current address, the device's other IPv6 addresses ("+N more IPv6").
- Device detail, Addresses card: every address of the last 30 days, with its class, whether it is
  current, first/last seen and how it was observed.
- Addresses are bidi-isolated (`.mono`, `dir="ltr"`) in Arabic.
- Inventory search and global search match any observed address (`device_addresses`).

## IPAM

- IPv6 subnets can be documented like IPv4 ones: gateway, DHCPv6 pool, DNS servers (of either
  family), VLAN, notes, and static / DHCP-reservation / reserved addresses.
- The database checks that every address is one host address of its family, and that a pool starts
  and ends in one family.
- Address arithmetic is 128-bit (`bigint`, `modules/ipam/plan.ts`):
  - IPv6 has no broadcast address.
  - The all-zeros address of a prefix is the subnet-router anycast address (RFC 4291). It is not a
    host address (`422 not_a_host_address`), except on `/127` (RFC 6164) and `/128`.
  - Counts are exact (`usable_exact`, `free_exact`; `usable` / `free` are approximate numbers for
    large subnets).
- Nothing enumerates a subnet:
  - The plan lists only addresses that were observed, documented or are infrastructure (gateway,
    collector).
  - Free-address suggestions walk forward from the first host address, skipping only listed
    addresses and jumping over the DHCP pool. The walk is bounded by the number of listed addresses.
- The address list of an IPv6 subnet is paged: `GET /ipam/subnets/:id?offset=&limit=` (256 by
  default, at most 4096), or `?ip=` for one address. The web shows a paged list instead of the
  IPv4 grid, plus an input to open any other address of the subnet.
- Conflicts are detected for both families:
  - duplicate online address
  - a reserved address in use
  - not the documented device (MAC mismatch)
  - a static address inside the DHCP pool
- A device's additional IPv6 addresses count as online only when the latest run of their scope saw
  them.
- CSV export is formula-safe as before, and the file name has no colons.
- Event rename: a detected conflict is now `ip_conflict_detected` (its pair `ip_conflict_resolved`
  is unchanged). Migration 038 renamed the event type in:
  - existing events
  - notification channel filters
  - knowledge entries
  - playbook triggers

  The insight code `ip_conflict` ("addresses changed hands", from `ip_mac_changed` events) is a
  different thing and keeps its name.
- Roles: everyone reads. Technicians and above document addresses. Admins and above edit the
  subnet plan. Every change is in the audit log (`ipam.*`).

## Subnet calculator (web, offline)

- IPv4 and IPv6 (`features/ipam/subnet-calc.ts`, bigint):
  - network, mask, host range
  - broadcast (IPv4) or "none" (IPv6)
  - exact counts, shown as 2^n when huge
  - the address class
- The splitter gives the exact number of subnets and lists the first 64.
- Unit tests: `pnpm --filter @lan-detective/web test:unit` (`node --test`).

## Active operations on IPv6 targets (scope rule at API and collector)

- Toolbox:
  - IPv6 literals work for ping, traceroute (`-6`), TCP check, port scan and reverse DNS.
  - A unique-local or link-local address must be inside an enabled scope. A global address inside a
    scope is a LAN address; outside every scope it is public, like a public IPv4 address (ping,
    traceroute and reverse DNS only).
  - Link-local and multicast targets are refused: they need a zone and would leave the scope rule's
    reach.
  - Host names still resolve to IPv4 only.
- Watch checks: the same table. A global IPv6 address outside every scope needs the check's
  `allow_public` opt-in.

## Limits (by design, IPv4 only)

- **Wake-on-LAN**: the magic packet goes to an IPv4 subnet broadcast. IPv6 has no broadcast address,
  and sending to all-nodes multicast would wake nothing reliably. A device without an IPv4 address
  answers `409 wol_ipv4_only`.
- mDNS, SSDP and NetBIOS identification probes, the router integrations, config backup, smart
  checks and endpoint agent addressing stay IPv4.
- Host names resolve to IPv4 in the toolbox.
- DHCPv6 and router advertisements are not read; the DHCPv6 pool in IPAM is documentation entered
  by hand, like the IPv4 pool.

## Verified

- Collector (`go vet ./...`, `go test -count=1 ./...` in `collectors/lan-collector`):
  - neighbour table parsers for Linux, Windows (both formats) and macOS
  - interface selection and the discovery steps (with fakes for the OS reads and probes)
  - scope classes, ValidTarget, the traceroute `-6` parser, and the toolbox/watch rule for IPv6
- **A real ICMPv6 echo was sent to `::1` and answered** (`internal/probe/icmp6_test.go`).
- API (vitest with embedded PostgreSQL, `tests/ipv6.test.ts`, `tests/ipam.test.ts`):
  - scope validation and the API refusals
  - ingest of dual-stack, IPv6-only and link-local hosts, with evidence
  - search, Wake-on-LAN refusal, offline and the family switch
  - IPv6 IPAM plan, conflicts, paging, CSV, history and roles
  - the event rename SQL
- Web: `tsc`, `next build`, subnet calculator unit tests (IPv4 and IPv6).

## Not verified

- The all-nodes multicast echo and the unicast echo were never sent on a real network. No IPv6
  traffic was sent anywhere except to `::1`.
- The Windows raw ICMPv6 path, and the neighbour table commands on real Windows, Linux and macOS
  machines: the parsers are tested on captured output formats only.
- The IPAM and inventory screens were not opened in a browser (build and type checks only).
