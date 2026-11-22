# Router controls (beyond block / unblock)

Status: in progress (first router: Zyxel VMG3625-T50B, the owner's own router).

What the product can do on a site's router, besides the existing client list, block, unblock,
rate limit and schedule. Every control:

- is an explicit administrator request (role `admin`; reads need any role); nothing is automatic;
- is queued as a `router_requests` row and a `collector_commands` row and run by the site's own
  collector, which logs in to the router with the stored credentials (never shown, never logged);
- is audited (`router.<action>`) with its parameters (never a password or a Wi-Fi key);
- re-reads the router after the change and reports the new state, so the UI shows what the router
  really did, not what was asked;
- says how to undo it (`change.undo`).

## Capabilities

The driver reports them with the existing ones (`capabilities[]` in a refresh, max 16 entries):

| capability     | what it offers                                                                 |
|----------------|--------------------------------------------------------------------------------|
| `overview`     | read-only: uptime, WAN links (status, type, IPv4, DNS), LAN address           |
| `wifi`         | list the Wi-Fi networks (main and guest), turn one on or off                   |
| `reservations` | list DHCP reservations (MAC → fixed IPv4), add one for a device, remove one    |
| `port_forward` | list port-forwarding rules, add one to a device, remove one                    |
| `rename`       | set the name the router shows for a device                                     |
| `reboot`       | restart the router                                                             |

A capability that is missing or `supported: false` is not offered (the UI shows the note).

## Refresh result: `settings`

A `router_result` of action `refresh` may carry `settings` (each part optional; a part is absent
when the router does not offer it or it could not be read):

```jsonc
"settings": {
  "overview": {
    "uptime_seconds": 86400,            // optional
    "lan_ip": "192.168.1.2",            // optional
    "wan": [ { "name": "ETHWAN", "status": "up|down|connecting|unknown", "type": "ETH|PTM|ATM|USB|...",
               "ipv4": "41.x.x.x", "dns": ["8.8.8.8"], "uptime_seconds": 3600 } ]   // all but name/status optional; max 8
  },
  "wifi": [ { "id": "1", "band": "2.4GHz", "ssid": "Home", "enabled": true, "main": true, "guest": false,
              "hidden": false, "security": "WPA2-Personal", "client_macs": ["aa:bb:..."] } ],      // max 32
  "reservations": [ { "id": "3", "mac": "aa:bb:cc:dd:ee:ff", "ip": "192.168.1.50", "enabled": true } ], // max 256
  "port_forwards": [ { "id": "2", "enabled": true, "description": "LAN Detective: NAS", "protocol": "tcp|udp|both",
                       "external_start": 8080, "external_end": 8080, "internal_start": 80, "internal_end": 80,
                       "internal_ip": "192.168.1.50", "owner": "lan-detective|administrator" } ]           // max 256
}
```

Never present: Wi-Fi keys, RADIUS secrets, any password. `id`s are the router's own identifiers
(opaque strings, max 40 chars); they are only valid until the router's list changes, so a removal is
always re-checked by the collector against the rule's content (see below).

A control result (any action below, `ok: true`) also carries `settings` re-read after the change,
and the API stores it exactly like a refresh's.

## Commands (API → collector) and results

| request action        | command kind           | payload (besides `request_id`, `router_id`)                                     |
|-----------------------|------------------------|----------------------------------------------------------------------------------|
| `rename`              | `router_rename`        | `mac`, `name` (1–63 printable chars)                                             |
| `wifi`                | `router_wifi`          | `wifi_id`, `enabled` (bool)                                                      |
| `reserve`             | `router_reservation`   | `mac`, `ip`                                                                       |
| `unreserve`           | `router_reservation`   | `mac`, `clear: true`                                                             |
| `add_port_forward`    | `router_port_forward`  | `port_forward: {description, protocol, external_start, external_end, internal_start, internal_end, internal_ip}` |
| `remove_port_forward` | `router_port_forward`  | `clear: true`, `port_forward: {the full rule as listed, including id}`          |
| `reboot`              | `router_reboot`        | none                                                                             |

The `router_result.action` equals the request action. `change` is the existing object; `mac` is the
device's MAC or `""` for router-wide changes (Wi-Fi, port forward without a device, reboot).

### Rules the collector enforces (and the API checks first)

- **rename**: the device must be in the router's client list. The name is trimmed; control
  characters are refused. The block switch and icon are sent back unchanged.
- **wifi**: refuses to turn off a network that the collector's own host is connected to (it would
  cut the product off from the router). The API also refuses to turn off the network the requesting
  operator's machine is on (`own_machine`). Turning on a guest network while its band's main network
  is off is refused (the router's UI does the same). Turning off a main network needs
  `confirm: true` in the API request body; the UI warns that every device on it disconnects.
- **reserve**: IPv4 inside the router's LAN subnet, not the router's own address, not the network
  or broadcast address, not reserved for another MAC. If the device already has a reservation to
  the same IP, nothing changes (`applied: false`).
- **unreserve**: removes the reservation of that MAC (whoever made it — the router keeps no owner;
  the change's `undo` says how to re-add it).
- **add_port_forward**: ports 1–65535, `end >= start`, external and internal ranges have the same
  length, at most 1000 ports per rule; the external range must not overlap an existing rule's
  external range of the same protocol, nor the router's own management ports (80, 443, 22, 23,
  7547 — TR-069). `internal_ip` must be inside the LAN subnet and not the router. The description
  is stored as `LAN Detective: <description>` (max 60 chars of the operator's text) so the rule is
  recognisable; those rules list as `owner: "lan-detective"`.
- **remove_port_forward**: the collector looks the rule up by `id` AND checks the protocol,
  external range and internal IP still match what the operator saw; if not, it refuses
  (`not_found`: "the rule changed on the router; refresh and try again"). Rules made by the
  administrator can be removed too (the UI asks for confirmation and shows the owner); `undo` holds
  the full rule so it can be re-added.
- **reboot**: the API requires `{"confirm": "reboot"}`. The collector sends the reboot, reports
  `ok` as soon as the router accepted it, and the router is unreachable for a few minutes; the next
  scheduled refresh records it reachable again (the existing `router_reachable` event).

## API

| method | path                                             | body                                      | role  |
|--------|--------------------------------------------------|-------------------------------------------|-------|
| GET    | `/routers/:id/settings`                          | —                                         | any   |
| POST   | `/routers/:id/rename`                            | `{device_id, name}`                       | admin |
| POST   | `/routers/:id/wifi`                              | `{wifi_id, enabled, confirm?}`            | admin |
| POST   | `/routers/:id/reservations`                      | `{device_id, ip}`                         | admin |
| DELETE | `/routers/:id/reservations/:device_id`           | —                                         | admin |
| POST   | `/routers/:id/port-forwards`                     | `{description, protocol, external_start, external_end?, internal_start?, internal_end?, device_id}` | admin |
| DELETE | `/routers/:id/port-forwards/:rule_id`            | —                                         | admin |
| POST   | `/routers/:id/reboot`                            | `{confirm: "reboot"}`                     | admin |

All POST/DELETE answer `202 {request_id, collector}` and are followed with
`GET /router-requests/:id` (existing). `GET /devices/:id/controls` adds the device-level actions
(`rename`, `reserve`, `unreserve`, `port_forward`) to each router item, with the device's current
reservation and port forwards on that router.

## Storage

Migration adds to `site_routers`: `settings jsonb` and `settings_at timestamptz`, and extends the
`router_requests.action` check with the new actions.

## Driver tests (protocol test doubles only)

Each driver's `controls_test.go` runs against a protocol test double of the vendor API served by
`httptest.NewTLSServer` with its own self-signed certificate, reached through the pinned-certificate
transport (`TransportHTTPSPinned` + `PinSHA256`), exactly as a router with a factory certificate is
reached in the product. For Cisco IOS XE, FortiGate, MikroTik, Omada, OpenWrt, OPNsense, pfSense and
UniFi the suites cover:

- the success path of every control the driver offers (settings read, Wi-Fi, reservations, port
  forwards, rename, reboot), with the router-side state checked after each change;
- the router refusing a change (HTTP error, vendor error code, ubus ACL denial): the driver returns
  an error (`ErrRejected` where the vendor reports a refusal) and the router state is unchanged;
- input refused before anything is sent (multicast / zero MACs, management ports, reservations
  outside the LAN, malformed Wi-Fi ids);
- a wrong password / API key (`ErrBadCredentials`) and a certificate that does not match the pin
  (`ErrCertificate`, nothing sent);
- no secret leaks: the password / API key, session tokens and Wi-Fi keys present in the fake router's
  answers never appear in `Settings`, a `Change` or an error text.

Two driver fixes came out of these tests: the Cisco IOS XE settings read now reports a rejected login,
a pin mismatch or an unreachable router as an error instead of an empty overview, and the UniFi
reboot reports such a failure instead of "no UniFi gateway device found".

OPNsense port forwards stay refused: the capability is `supported: false` with a note naming the
detected firmware. Newer OPNsense releases expose a destination-NAT API (`/api/firewall/d_nat`), but
its rule format differs between releases and has not been verified against a real firewall, so the
driver does not write it; port forwards are managed under Firewall → NAT → Port Forward.
