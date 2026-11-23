# Neighbours: CDP, MikroTik neighbour table, MNDP (Port Detective → Neighbours, Topology)

LLDP was the only neighbour source. Two more now feed the same model, and each entry says which
protocol it came from:

1. **CDP and the MikroTik neighbour table, read from switches over SNMP.**
2. **MikroTik MNDP announcements, heard directly by the collector.**

## Prerequisites

- **Switch tables**: a switch or router already added in Port Detective, with read-only SNMP
  credentials. The neighbour tables are read during the normal switch poll, read-only, and nothing
  else is sent to the device.
  - CDP needs CISCO-CDP-MIB `cdpCacheTable` (Cisco IOS / IOS-XE / NX-OS; some other vendors also
    run CDP).
  - The MikroTik table needs MIKROTIK-MIB `mtxrNeighborTable` (RouterOS). RouterOS fills it from
    MNDP, and from CDP or LLDP when those are enabled.
  - Many small switches implement none of these tables.
- **MNDP**: an enrolled collector on the same layer-2 segment as the MikroTik devices, and an
  authorized scope that covers their addresses.
  - The listener is on by default. It can be turned off per site (Port Detective → Neighbours, admin
    only), or per collector with `mndp_listen: off` in the collector config or the env variable
    `NIGAFIY_SENSOR_MNDP_LISTEN=off`.
- Roles: every role can read. Only owner and admin can change the site switch
  (`PUT /neighbors/settings`, audited as `site.mndp_listen` with before/after).

## How it works

- **CDP** (`collectors/lan-collector/internal/snmp/neighbors.go`): walks `cdpCacheTable`
  (1.3.6.1.4.1.9.9.23.1.2.1.1), indexed by ifIndex.deviceIndex.
  - It reads the device ID, the remote port, the platform, the first line of the version banner, and
    the IPv4 address (4 raw octets).
  - Entries are capped at 512, the same cap as LLDP.
- **MikroTik table**: walks `mtxrNeighborTable` (1.3.6.1.4.1.14988.1.1.11.1.1).
  - It reads identity, MAC, IP, platform, version and the interface (ifIndex).
  - The licence "software ID" is not read.
  - A row whose interface is 0 cannot be placed on a port, so it is not stored per port.
- **Storage**: all entries go in the `lldp` list of the `snmp_poll` item, tagged
  `protocol: lldp | cdp | mikrotik`, with optional `address`, `platform` and `version`.
  - They are stored per port in `switch_ports.neighbors`, as before.
  - The strict schema refuses unknown protocols. The cap is raised to 1536 (3 × 512).
- **MNDP** (`internal/mndp`): a UDP socket on port 5678 that only receives. The collector never
  sends a discovery request or an announcement.
  - It parses the TLVs: MAC, identity, version, platform, uptime (little-endian), board, interface
    name, IPv4 and IPv6. The software ID is skipped on purpose.
  - Announcements whose source is outside the authorized scopes are counted and dropped.
  - The table is capped at 1024 entries. Entries not heard for 30 minutes expire.
  - Every 60 s the collector sends an `mndp_neighbors` telemetry item, but only when something was
    heard.
  - The API applies the scope rule again. It refuses the item while the site has the listener off.
  - Each neighbour is matched to an inventory device by MAC, then by IPv4 address. The result is
    stored in `mndp_neighbors` (migration 039, with RLS).
- **Bind failure** (port in use, for example by WinBox on the same Windows host, or not permitted):
  - the listener records `bind_failed` with a readable reason and retries every 5 minutes;
  - the collector keeps running;
  - the heartbeat carries `mndp_status` (state, error, received, out of scope, malformed, neighbour
    count), which Port Detective shows per collector.
- **No firewall changes**: no firewall rule is created. When the host firewall drops inbound UDP
  5678, the status reads "listening, 0 received", and the UI explains the possible causes.
- **Topology** (`modules/topology/routes.ts`):
  - A `switch_link` is drawn when any neighbour entry names another read switch. The match is by
    system name or device ID (with or without domain, without a CDP "(serial)" suffix), by
    management address, or by chassis MAC.
  - The edge's evidence names the protocol, the port, the platform and how the match was made.
  - Devices heard over MNDP carry an observed `mndp` block (identity, board, version, interface,
    heard-by collector, last heard), which the inspector shows.
  - Neighbours that are not read switches, such as IP phones, never create a link.
- Switch candidates ("probably a switch") now say which protocol announced the device, and also
  match by management address.
- **Web**: Port Detective has protocol badges on port neighbours and a Neighbours card (switch
  table, MNDP list, per-collector listener status, site switch). The topology inspector shows the
  MNDP block. All of it is in EN and AR.

## Verified

- **Go**:
  - `internal/mndp/mndp_test.go`: a RouterOS 7 announcement as raw bytes, a minimal announcement,
    unknown TLVs, control characters, and malformed packets (header only, no MAC, zero MAC, overlong
    TLV, truncated header).
  - The same file also tests the scope filter (IPv4 only), expiry, the 1024 cap, the bind failure
    status, receive and stop, and a real loopback UDP socket.
  - `internal/snmp/neighbors_test.go`: CDP rows (raw 4-octet address, multi-line version) and
    MikroTik rows (IpAddress, raw MAC, interface 0), read through the in-process SNMP simulator
    together with LLDP.
  - `internal/agent/mndp_test.go`: bind failure reported, retry after the delay, receive, an
    out-of-scope drop, the `mndp_neighbors` item, the socket closed when the site turns the listener
    off, and the local opt-out.
- **API**, `apps/api/tests/neighbors.test.ts`:
  - protocol fields stored per port, and an unknown protocol refused;
  - switch links by CDP name and by MikroTik chassis MAC, with no link for a phone;
  - heartbeat status validated and stored, and the site switch delivered;
  - announcements in scope only, matched to a device, updated in place;
  - topology MNDP evidence;
  - admin-only toggle with audit and clearing, viewer read access, and isolation between
    organizations.

## Not verified

- Never run against real Cisco or MikroTik hardware or a real RouterOS broadcast. The byte fixtures
  follow the published MNDP layout and the CISCO-CDP-MIB / MIKROTIK-MIB definitions.
- The listener has only been bound on loopback in tests; it has not been bound on `:5678` on this
  machine.
- Windows may show its own firewall prompt the first time the collector binds UDP 5678 when it is
  not running as a service. Nigafiy never answers that prompt or adds a rule.
- MNDP over IPv6 (RouterOS also announces on ff02::1) is not listened to; only IPv4 broadcasts are
  received.

## Router Wi-Fi clients as topology edges

Wi-Fi clients listed by a configured router (`router_clients` with connection `wifi*`, seen in the
last day, router and client both in the inventory) become an observed `wireless_client` edge from
the device to the router.

- **Evidence**: band, interface or SSID, and signal in dBm. The last-verified time is when the
  router last listed the client.
- **Confidence**: high when the list is under an hour old and the client is active, otherwise
  medium.
- **Edge id**: `e:wifi:<device>`, the same id the impact twin uses, so the two views describe one
  link.
- **No duplicates**: a device that a switch already places on an access port keeps only the
  forwarding-table link.
- **Map**: the link is drawn when the device or the router is selected, and a router shows how many
  Wi-Fi clients it lists.
- **Verified**: an API test in `apps/api/tests/router-control.test.ts` covers the edge and its
  evidence, the wired client, the impact twin, a switch taking precedence, and lists older than a
  day.
- **Not verified**: against a real router's client table. Access points that are not a configured
  router stay invisible, so the router may only be the path to the access point; the map states this
  as a limitation.
