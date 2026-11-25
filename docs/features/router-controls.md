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
A capability may also carry `requires: "reservation"` (the only value): the control acts on the
device's DHCP reservation, so it is offered only for devices that have one.

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
  Routers that keep no client names of their own (pfSense, OPNsense, FortiGate) store the name on the
  device's DHCP reservation and report the capability with `requires: "reservation"`: then the
  device must have a reservation instead (API `409 needs_reservation`, device controls reason
  `needs_reservation`), and the form says where the name goes.
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
  is stored as `LAN Detective: <description>` (the label is kept from before the rename, docs/architecture/naming.md) (max 60 chars of the operator's text) so the rule is
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

OPNsense port forwards are offered from OPNsense 26.1 on (destination NAT API, see "Built: R1");
on older firmware the capability is `supported: false` with a note naming the detected version.

## Per-driver matrix (rename, Wi-Fi, reservations, port forwards)

Y = offered, – = not offered (the capability note says why), "via reservation" = rename stored on the
device's DHCP reservation. Every entry is exercised against a protocol test double only; apart from
the Zyxel row, none of this has run on real hardware.

| Driver | Firmware the driver targets | Rename | Wi-Fi | Reservations | Port forward | Source of the vendor interface |
|---|---|---|---|---|---|---|
| zyxel | VMG3625-T50B (ZCFG DAL) | Y | Y | Y | Y | router's own web UI JavaScript (handoff spec) |
| asus, huawei, unifi, mikrotik, omada, openwrt | as in their headers | Y | Y | Y | Y | unchanged by R1 |
| tenda | AC6/AC7/AC9/AC10/AC11/AC15/AC18, firmware **V15.03.x** | Y (V15.03.x only) | Y | Y | Y | `/goform/SetOnlineDevName` (`mac`, `devName`): CVE-2024-10662 (AC15 V15.03.05.19), CVE-2024-10698 (AC6 V15.03.05.19), CVE-2024-0533 (A15) |
| tenda | F3 (V12.x), AC23 (V16.x) | – | Y | Y | Y | handler not confirmed on these families |
| dlink | DIR-825/842/878/882, EXO, COVR (HNAP1) | – | Y | Y | Y | GetClientInfo returns NickName, but no documented SetClientInfo write; only SetClientInfoDemo on DIR-868L (audio settings, CVE-2018-19988) |
| tplink | Archer C6/C80/AX10/AX23/AX53/AX73, VR400/600, VX230v | – | Y | Y | Y | no documented client-name form in the LuCI `stok` API; Tether names live in the TP-Link cloud |
| zte | ZXHN H168N/H188A/H108N, F660/F670L/F680 | – | Y | Y | Y | `accessdev_landev_lua.lua` is a read-only host list; no documented rename page |
| huaweilte | B315/B525/B535/B818/H122/H155 (HiLink) | – | Y | – | Y | huawei-lte-api: `lan/HostInfo`, `wlan/host-list` read-only; `dhcp/static-addr-info` GET only (B310s-22, "usage unknown"), no write format |
| fortigate | FortiOS 6.4–7.4 REST API | via reservation (description) | Y (when SSIDs exist) | Y | Y | FortiOS CLI reference `system dhcp server` → `reserved-address` (`description`); `wireless-controller vap`; `system interface` `status up/down` (Fortinet Community tip on disabling an SSID); `/api/v2/monitor/wifi/client` |
| pfsense | pfSense CE 2.7 / Plus 23.09+ with pfSense-pkg-RESTAPI v2 | via reservation (host name) | – | Y | Y | pfrest `Models/DHCPServerStaticMapping.inc` (`hostname` with HostnameValidator, `descr`), PATCH `/api/v2/services/dhcp_server/static_mapping`; the REST API has no wireless endpoints |
| opnsense | 24.1+ (Kea) | via reservation (host name) | – | Y | Y on **26.1+**, – before | Kea `setReservation/{uuid}` (`reservation.hostname`); OPNsense 26.1 release notes (Port Forward → Destination NAT, MVC/API), `DNatController` and `OPNsense/Firewall/DNat.xml` (docs.opnsense.org development/api/core/firewall.html); no wireless API |
| ciscoxe | IOS XE **16.6+** RESTCONF (native YANG) | via reservation (`client-name`) | – (no radios; Catalyst 9800 out of scope) | Y | Y (needs NAT set up by the administrator) | Cisco Programmability Configuration Guide (RESTCONF), YangModels/yang `vendor/cisco/xe` (Cisco-IOS-XE-dhcp, -nat); see "Built: X1" |

## Built: R1 (2026-11-24)

What was added, all **verified only against protocol test doubles** (pinned TLS, `httptest.NewTLSServer`),
**never run on real hardware**:

- **Rename via reservation** (pfSense, OPNsense, FortiGate). pfSense: PATCH the static mapping's
  `hostname`, then `dhcp_server/apply`. OPNsense: `/api/kea/dhcpv4/setReservation/{uuid}` with
  `{"reservation": {"hostname": ...}}`, then `/api/kea/service/reconfigure`. Both refuse a name
  that is not a host name (letters, digits, hyphens; `router.CleanHostname`) before sending.
  FortiGate: PUT the DHCP server's `reserved-address` list with the entry's `description` changed
  (any printable name up to 63 characters). All three refuse a device without a reservation
  (`not_found`), re-read the reservation after the change and fail if it does not show the new
  name; the undo names the previous name.
- **Tenda rename** on firmware V15.03.x: POST `/goform/SetOnlineDevName` with the normalised MAC and
  the name (at most 32 bytes: the public advisories are about a stack overflow on a long `devName`),
  `errCode` 0 required, then the online list is re-read. Other firmware families: `supported:
  false` naming the detected version, and `ErrUnsupported` before anything is sent. Not known: which
  online-list field a real V15.03 router uses for the new name (the driver reads `qosListRemark`,
  `qosListDevName`, `devName`).
- **FortiGate Wi-Fi**: lists `wireless-controller/vap` SSIDs that have a system interface (name,
  SSID, hidden from `broadcast-ssid`, security; the passphrase is never read), their clients from
  `/api/v2/monitor/wifi/client`, and turns one on/off with PUT `/api/v2/cmdb/system/interface/<vap>`
  `{"status": "up"|"down"}`, then re-reads the status. FortiOS has no main/guest flag, so every SSID
  is reported as a main network (turning one off asks for confirmation). Offered only when SSIDs
  exist; a FortiGate without a wireless controller reports why.
- **OPNsense port forwards** on 26.1 and newer (version parsed from `/api/core/firmware/info`):
  `d_nat/search_rule` + `get_rule/{uuid}` (option fields read from the selection maps),
  `add_rule` with interface `wan`, `inet`, protocol tcp / udp / `tcp/udp`, destination
  `wanip` + port or `start-end`, `target`, `local-port`, description `LAN Detective: …`,
  `pass: "pass"`; `del_rule/{uuid}`; `apply` after each change; the rule is re-read after adding
  and after removing. Rules with aliases, IPv6 targets or no port are left out of the list rather
  than guessed. Older firmware: `ErrUnsupported` and no `d_nat` request at all.
- **Precise refusals** for the rest (see the matrix): D-Link, TP-Link, ZTE and Huawei LTE rename,
  Huawei LTE reservations, pfSense and OPNsense Wi-Fi.
- **API / UI**: capability field `requires` (Zod enum `reservation`), device controls rename reason
  `needs_reservation` and `via: "reservation"`, `POST /routers/:id/rename` answers `409
  needs_reservation` / `settings_unknown` for such routers; EN/AR strings
  (`routers.rename.hintReservation`, `routers.err.needs_reservation`,
  `control.reason.needs_reservation`); `tests/router-settings.test.ts` covers both.

Not verified and needing a real device: every R1 control above; whether OPNsense 26.1's
`get_rule` returns `target` and `destination.port` as plain strings (the driver accepts both
strings and selection maps); whether taking a FortiWiFi SSID interface down stops the broadcast on
every FortiAP model (documented only in a Fortinet Community tip).

## Per-driver matrix (rate limit, schedule)

Y = offered by the router itself, – = not offered (the capability note says why). Where the router
cannot schedule but can block, Nigafiy enforces the schedule itself with the router's block
(`router_product_schedules`, migration 029), so every driver with `block` can still schedule a device.
Every R2 entry is exercised against a protocol test double only; none of it has run on real hardware.

| Driver | Rate limit | Schedule | Mechanism and source |
|---|---|---|---|
| mikrotik | Y | Y | unchanged (simple queues; firewall filter `time`) |
| zyxel | upload only | Y | unchanged (handoff spec) |
| omada | Y | – | rate: unchanged. Schedule: time ranges + gateway ACLs are documented only for the Omada Open API (client-credentials apps), not the controller web API the driver uses |
| tenda | Y | – | rate: unchanged. Schedule: `/goform/saveParentControlInfo` exists on V15.03 (CVE-2024-2850, CVE-2024-2852, AC15) but only its `urls` field is documented |
| unifi | Y | Y (Network 7.x+) | rate: per-device user group `rest/usergroup` (`qos_rate_max_down/up`, kbit/s, -1 unlimited) + client `usergroup_id` (Art-of-WiFi UniFi-API-client). Schedule: v2 `trafficrules` BLOCK rules with `target_devices` and a weekly `schedule` (aiounifi `models/traffic_rule.py`); a controller without the v2 API reports why |
| fortigate | Y | Y | rate: `firewall/shaping-policy` with `traffic-shaper` (upload) / `traffic-shaper-reverse` (download) and `firewall.shaper/traffic-shaper` (kbps, per-policy). Schedule: `firewall.schedule/recurring` + deny `firewall/policy`, moved to the top (`?action=move&before=`). FortiOS 6.4–7.4 Administration Guide and CLI reference |
| opnsense | Y | – | rate: `/api/trafficshaper/settings` pipes (`bandwidth`, `bandwidthMetric` Kbit, mask none) and LAN rules (source/destination = the device). Schedule: rules accept `sched` (MVC `Filter.xml`) but schedules live only in the legacy config (`ScheduleField` reads `schedules/schedule`), with no API |
| pfsense | – | Y | schedule: REST API v2 `firewall/schedule` (`timerange[].position` 1 Mon…7 Sun, `hour` HH:MM-HH:MM on the quarter hour, `FirewallScheduleTimeRange.inc`) + floating quick block `firewall/rule` with `sched` (`FirewallRule.inc`). Rate: limiters need pass or floating *match* rules; the API has no match type and no placement, and a floating pass rule would bypass the administrator's block rules |
| openwrt | Y (with nft-qos) | Y | rate: nft-qos `config client` (`macaddr`, `drate`/`drunit`, `urate`/`urunit`, `limit_mac_enable`; openwrt/packages `net/nft-qos`, 23.05 branch); not offered when the package is absent. Schedule: unchanged |
| asus | – | Y (firmware 386+) | schedule: Parental Controls `MULTIFILTER_MACFILTER_DAYTIME_V2` (`W` + enable + weekday hex mask Sun=bit 0 + HHMM + HHMM; asuswrt-merlin.ng `ParentalControl.asp`, `js/weekSchedule/weekSchedule.js`). Rate: Bandwidth Limiter rules (`qos_bw_rulelist`) have no label, and need QoS mode 2 (switching reboots) |
| dlink | – | – | QoS engine is priority based; HNAP1 schedule actions are not publicly documented |
| tplink | – | – | Archer QoS is priority based; Parental Controls are not in the documented stok API |
| zte | – | – | no per-device speed page (ISP TR-069 QoS); time rules not documented |
| huawei | – | – | no per-device speed limit in the web API; parental-control time rules differ per ISP build |
| huaweilte | – | – | HiLink has no per-device speed limit or time rule |
| ciscoxe | Y | Y | rate: Cisco-IOS-XE-policy `policy-map NIGAFIY-RL-IN/OUT` with `police` per device class (ACL-matched), service-policy on the LAN interface. Schedule: `time-range NIGAFIY-S-<MAC>` (`periodic`) bound to a deny entry of `NIGAFIY-LAN-IN`. See "Built: X1" |

## Built: R2 (2026-11-24)

Rate limits and blocking schedules on every driver whose router offers them, all **verified only
against protocol test doubles** (pinned TLS, `httptest.NewTLSServer`), **never run on real hardware**.

Shared rules (`internal/router/schedule.go`): `ValidateRateLimit` (0–10 000 000 kbit/s, at least
one direction), `ValidateWindows` (1–8 windows, days 0–6, `HH:MM`), `SplitWindows` (a window whose
end is not after its start crosses midnight; it becomes start→24:00 on its days and 00:00→end on the
next days; start = end is 24 hours; segments with the same times are merged). Every new driver
call: refuses bad input before sending anything; treats an empty schedule as "clear"; labels what
it creates `LAN Detective: limit|schedule <mac>` (or the vendor's name field: `LD:<mac>`,
`ld-lim-<hex>`, `LD_<hex>_<n>`); never changes or deletes anything without that label; where the
router keeps one entry per device (UniFi user group, nft-qos client, ASUS Parental Controls) it
refuses when that entry is the administrator's (FortiGate, OPNsense and pfSense get separate
Nigafiy rules and leave the administrator's rules as they are); adds the new
schedule before removing the old one and removes what it just added if the router refuses, so a
refusal leaves the previous schedule in place; re-reads the router after the change and fails if
the router does not show it; says how to undo it.

- **UniFi**: rate limit through a per-device user group (the administrator's groups are never left;
  clearing moves the client back to Default and deletes the group). Schedule through v2 traffic
  rules (Network 7.x+), one BLOCK rule per segment; a window ending at midnight ends at 23:59 (the
  API has no 24:00).
- **FortiGate**: shaping policy + shapers for the limited directions only; deny policies with
  recurring schedules (FortiOS ends a schedule whose end is not after its start on the next day, so
  `22:00–00:00` and an all-day `00:00–00:00` are written as such). Both match the device's current
  IPv4 through an address object and are moved to the top of their table.
- **OPNsense**: traffic-shaper pipe + LAN rule per direction, then `service/reconfigure`.
- **pfSense**: one schedule with one time range per segment (quarter-hour times only, refused
  otherwise) and a floating quick block rule on LAN; list ids are re-read before every delete
  because REST API v2 ids are positions.
- **OpenWrt**: nft-qos client sections when the package is installed (kbit/s → whole kbytes/s,
  rounded up). If MAC limits were off, Nigafiy turns them on, marks that (`nigafiy_enabled_mac`)
  and turns them off again with its last limit; the change says so.
- **ASUS**: Parental Controls time scheduling on firmware 386+, offline rules with `24:00` ends.
  Fix found on the way: the driver now writes `MULTIFILTER_MACFILTER_DAYTIME_V2` with the other
  lists on 386+ firmware, so adding or removing a block no longer misaligns the schedules of the
  administrator's other devices; blocking a device that has a Nigafiy schedule is refused.
- **Precise refusals** for the rest (see the matrix).
- **UI**: on a router that schedules devices itself, the schedule form now shows the driver's note
  (EN/AR label `routers.section.routerNote`, note text from the router driver in English inside a
  `dir="ltr"` span, as the rate-limit form). API test `router-control.test.ts` covers router-side
  schedules, the notes and the role refusals; the API itself needed no change.

Not verified and needing a real device: every R2 control above. Specific unknowns: UniFi — whether
`EVERY_WEEK` + `repeat_on_days` is the mode the UI writes and whether `23:59` includes that minute,
and whether user-group limits reach wired clients on a given gateway; FortiGate — whether a
shaping policy with `dstintf any` and no `srcintf` is accepted on every 6.4–7.4 build; OPNsense —
whether `searchPipes` returns `bandwidth` as a plain string on every release; pfSense — that a
floating quick block rule with a schedule is evaluated before the LAN rules on the installed
release; OpenWrt — that `luci.setInitAction` / `rc.init` restart nft-qos under the router's rpcd
ACL; ASUS — how firmware treats the `W1…` rules of a device whose ENABLE is 1 (the format is taken
from the web UI JavaScript, not from the firewall C code).

## Built: X1 Cisco IOS XE (2026-11-25)

Before X1 the Cisco IOS XE driver (`internal/router/ciscoxe`) was read-only. It now offers every
control the platform can do safely, all through **RESTCONF** (RFC 8040) on the Cisco-IOS-XE-native
YANG model. No SSH CLI fallback was needed: every control has a native model. All of it is **verified
only against a stateful RESTCONF protocol double** (`controls_rw_test.go`, pinned TLS,
`httptest.NewTLSServer`) and has **never run on a real IOS XE device**.

Sources: Cisco "Programmability Configuration Guide, Cisco IOS XE" (RESTCONF chapter: PATCH merges,
PUT replaces one list entry, DELETE removes it, each request one validated transaction), the published
models in github.com/YangModels/yang `vendor/cisco/xe/<release>` (Cisco-IOS-XE-native, -acl, -dhcp,
-nat, -policy, -arp-oper, -dhcp-oper) and `cisco-ia:save-config` (= `write memory`), IOS XE 16.x/17.x.

| Control | Mechanism (file) |
|---|---|
| Block / unblock | `ip access-list extended NIGAFIY-LAN-IN`, applied inbound on the LAN interface (`acl.go`). Per device: a remark naming its MAC and `deny ip host <address> any`; the ACL always ends with `permit ip any any` and is written (PUT, one transaction) **before** it is attached, so attaching it never cuts the LAN off. IOS XE ACLs match IPv4 addresses, not MACs, on a routed interface: the block follows the device's current address, so the note asks for a reservation first |
| Schedule | `time-range NIGAFIY-S-<MAC>` with `periodic <day> hh:mm to hh:mm` entries bound to the device's deny entry. Router local time; IOS has no 24:00, so a window to midnight ends at 23:59; windows across midnight are split (`router.SplitWindows`) |
| Rate limit | Per direction: ACL `NIGAFIY-RL-<MAC>-UP/DN`, `class-map match-all` on it, `policy-map NIGAFIY-RL-IN` (service-policy input, upload) / `NIGAFIY-RL-OUT` (output, download) with `police <bit/s>` (`qos.go`). A platform that refuses the policy in a direction is reported and the change is not kept |
| Reservation | `ip dhcp pool NIGAFIY-<MAC>` manual binding: `host <address> <LAN mask>`, `client-identifier 01<MAC>` (`dhcp.go`). A client that sends another identifier (a DUID) does not match: documented IOS behaviour, stated in the note |
| Rename | `client-name` of the device's Nigafiy pool, only when a reservation exists (`requires: reservation`, as pfSense/OPNsense/FortiGate); host-name characters only |
| Port forward | `ip nat inside source static {tcp\|udp} <LAN address> <port> <outside address> <port>` (`nat.go`), one port per rule, "both" = a tcp and a udp entry in one transaction. Offered only when `ip nat inside` is on the LAN interface and `ip nat outside` on an interface with a static IPv4 address: Nigafiy never turns NAT on. Static NAT has no description, so every entry is shown as the administrator's and removal deletes exactly the entry the operator saw (keys re-checked) |
| Wi-Fi | not supported: IOS XE routers have no radios; wireless runs on a separate Catalyst 9800 controller (out of scope). EN/AR reason `routers.wifi.ciscoXeNote` |
| Reboot | not offered on purpose (restarting an enterprise router drops every routed network at once) |

Safety rules of every write:
- every write capability needs IOS XE **16.6 or later** (RESTCONF configuration writes); an older or
  unparsable release turns them all `supported: false` with a note naming the reported version, and the
  driver refuses with `ErrUnsupported` before sending anything; a missing YANG model is reported the same way;
- only objects named `NIGAFIY-…` are created, replaced or deleted; the administrator's ACLs, policy maps,
  pools and NAT entries are read, never changed; a LAN interface that already carries the administrator's
  inbound ACL (block, schedule) or service policy (rate limit) is refused, with the name in the note;
- the LAN interface is the one whose primary address is the router address; when none matches, every
  write is `supported: false` with that reason;
- every change is read back; `write memory` (`cisco-ia:save-config`) runs **only after** the read-back
  matched; a failed save is reported as an error ("the change is active but write memory failed; it is
  lost at the next restart unless saved"), never hidden;
- the shared rules still apply (multicast / zero MACs, management ports, LAN-subnet checks), plus the
  platform's approval, role (admin), audit row and undo text for each change, unchanged.

Tests (`controls_rw_test.go`, `controls_test.go`): block/unblock over the ACL (attached inbound, saved
once, blocking or unblocking twice changes nothing), refusals with nothing written (the administrator's
ACL on the LAN, IOS XE 16.3, a release without the time-range model), a failing save reported; a
schedule across midnight; rate limits in both directions, a platform refusing the output policy (the
half-made class is removed, nothing saved) and the administrator's service policy; reservation and
rename (rename without a reservation is `not_found`, an address already bound refused, the
administrator's binding never removed); static NAT port forwards and a router without NAT; settings
without the write models and the settings error paths.

Config restore for IOS XE (`configure replace … revert trigger error timer`) is described in
`docs/features/config-backup.md`.

Not verified and needing a real device: every X1 control. Specific unknowns: which platforms accept
`police` in an output policy on the LAN interface (the driver reports a refusal and keeps nothing);
whether the JSON a real device returns uses exactly the key names of the published models on every
release (the protocol double follows the models, not captured device output).
