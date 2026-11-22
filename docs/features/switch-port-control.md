# Switch port control (Phase 5)

Change switch ports from LAN Detective: enable / disable a port, set its description, move an access
port to another VLAN, and quarantine a device (move its own port to a quarantine VLAN, then release
it back to the VLAN it was in). Every change goes through the site's collector over SNMP SET, is
explicitly confirmed by an administrator, audited, and counts as done only after the collector reads
the new value back from the switch.

## Prerequisites

- A managed switch already added in Port Detective (read over SNMP) and read successfully at least once.
- SNMP **write** access on the switch: a read-write community (v2c) or an SNMPv3 user with write
  access to `IF-MIB::ifAdminStatus` / `ifAlias` and, for VLAN changes, `Q-BRIDGE-MIB`
  (`dot1qPvid`, `dot1qVlanStaticEgressPorts`, `dot1qVlanStaticUntaggedPorts`) or, on Cisco IOS,
  `CISCO-VLAN-MEMBERSHIP-MIB::vmVlan`. Enter these as the switch's *write credentials*; they are
  separate from the read-only credentials. Restrict SNMP write on the switch to the collector's address.
- For VLAN changes and quarantine: the switch must expose its VLAN tables (Q-BRIDGE-MIB or the Cisco
  VTP / VLAN-membership MIB) in the SNMP view, so LAN Detective can read which VLANs exist and each
  port's access VLAN. Without them only enable/disable and description are offered.
- For quarantine: an isolated VLAN created on the switches beforehand (no route to internal networks,
  typically only DHCP + a captive notice or nothing), chosen as the site's quarantine VLAN in
  Port Detective → "Port control for this site" (or per switch, when a switch numbers it differently).
- An online collector of the site (changes are delivered through its authenticated command channel).
- Role: viewing is open to every member; every change, write credential and setting is admin-only.

## How it works

1. **Read.** After every successful switch read the collector also sends a `switch_vlans` item: the
   VLANs the switch defines, each port's access VLAN / trunk mode, and the write methods its tables
   support (`qbridge`, `cisco`). Stored in `switch_vlans`, `switch_port_vlans`, `snmp_targets.vlan_methods`.
2. **Request.** `POST /api/v1/switches/:id/ports/:ifIndex/actions` with `{ op, …, confirm: true }`.
   The API validates the value (VLAN exists on the switch as last read, port is not already in it,
   description is printable ASCII ≤ 64), checks the port is free (one pending change per port) and
   records the request with the values *as last read* (`before_known`).
3. **Risk check.** Disabling a port or changing its VLAN is refused (`409 risky_port`, with the
   evidence) when the port looks like an uplink (LLDP neighbour — observed), has many addresses behind it
   (inferred), is a trunk in the VLAN tables (observed), or has the collector host, the gateway/router,
   or the requester's own machine in its forwarding table (observed). The administrator may proceed
   only by writing an override reason (≥ 10 characters), which is stored and audited. Quarantine never
   overrides. The collector repeats the "never cut yourself off" check against the switch itself
   (its own MACs and the gateway's MAC in the switch's forwarding table) unless overridden.
4. **Deliver.** A `set_switch_port` command is queued for an online collector of the site. While that
   request is pending (and not past its deadline), and only for that collector, the heartbeat
   configuration carries the switch's write credentials (`snmp.targets[].write`). The collector never
   writes them to its disk cache, logs or telemetry.
5. **Execute.** The collector re-validates everything (deadline, at-most-once ledger on disk, switch in
   its configuration with write credentials, address inside an authorized scope, closed list of
   operations, OIDs built locally), reads the current value, writes, reads back, and for 802.1Q VLAN
   moves undoes earlier steps if a later one fails.
   **Automatic rollback of single-step writes.** For the three one-SET operations (ifAdminStatus,
   ifAlias, Cisco `vmVlan`) a read-back that does not show the new value makes the collector write the
   value it read right before the change back and read it back again (`rollbackSingle` in
   `internal/snmp/write.go`). The result is still `failed` (error kind `readback_mismatch`), with
   `rolled_back: true`, the rollback write and read-back listed in the steps and `after` set to the
   restored value; if the rollback write fails or the switch does not show the previous value either,
   `rolled_back` stays false, the steps say why, and `after` is what the switch last reported — check
   the port on the switch. A SET the switch
   refuses changes nothing, so it is not rolled back. Multi-step 802.1Q moves keep their own
   step-by-step undo.
6. **Result.** A `switch_port_result` item reports before / after (read from the switch), verified or
   not, rollback and steps. The request becomes `verified` or `failed`; the port's cached values are
   updated from the read-back; a `switch_port_changed` / `switch_port_change_failed` event is emitted.
7. **TTL.** A request not answered within `PORT_REQUEST_TTL_MINUTES` (10) becomes `expired`, its command
   is closed and the write credentials stop being delivered. The collector refuses an expired command.
   A late result is still recorded (it is the truth about the switch).

## Quarantine

`POST /api/v1/devices/:id/quarantine { reason?, confirm: true }` requires the device to be located
*directly* on a port (alone on an access port, high confidence), the quarantine VLAN to exist on that
switch, write credentials, a readable access VLAN, and no risk on the port. It creates a
`device_quarantines` row (`requested`) and an access-VLAN change (`purpose = quarantine`). When verified,
the quarantine becomes `active` and its original VLAN is the value the collector read right before
writing. `POST /api/v1/quarantines/:id/release { confirm: true }` moves the port back to that VLAN
(`releasing` → `released`; on failure it stays `active` with the error). Manual VLAN changes of a
quarantined port are refused.

### Automatic release (optional TTL)

The quarantine request may carry `release_after_minutes` (whole minutes, 5 to 43 200 = 30 days; the
dialog offers 1 h, 4 h, 8 h, 1 day, 3 days, 7 days or "No"). The time counts from the **verified**
move (`activated_at`), so a quarantine still waiting for the collector never releases early; the
device view shows `auto_release_minutes` and, once active, `auto_release_at`.

The `quarantine-auto-release` job (ports module, every 60 s, advisory lock 727161) queues the same
verified release an administrator's **Release** queues, with the same checks (switch enabled and in
scope, write credentials, collector online, no change pending on the port). The port request is
recorded with `requested_via = 'auto_release'` and no user; the audit row is a system action
(`device.quarantine.release`, `actor = system`, `metadata.automation = quarantine_auto_release`,
`auto_release: true`). The history marks such a release "released automatically".

Fail closed: if the release cannot be queued (for example the switch is disabled or no collector is
online) or the collector cannot verify it, the quarantine stays `active` — the device stays isolated —
the reason is shown (`last_error`, audited as `device.quarantine.auto_release_failed`), and the job
tries again after 15 minutes (`auto_release_attempted_at`). An administrator can release by hand at any
time. Columns: `device_quarantines.auto_release_minutes`, `auto_release_attempted_at` (migration 041).

## API

| Method | Path | Role |
|---|---|---|
| GET | `/switches/:id/control` | member |
| PUT / DELETE | `/switches/:id/write-credentials` | admin |
| PUT | `/switches/:id/quarantine-vlan` `{ vlan \| null }` | admin |
| GET | `/switches/:id/ports/:ifIndex/control` | member |
| POST | `/switches/:id/ports/:ifIndex/actions` | admin |
| GET | `/port-requests?target_id&device_id&if_index&limit`, `/port-requests/:id` | member |
| GET / PUT | `/sites/:id/port-control` `{ quarantine_vlan }` | member / admin |
| GET / POST | `/devices/:id/quarantine` | member / admin |
| POST | `/quarantines/:id/release` | admin |

Audit actions: `switch_port.admin_status|alias|access_vlan`, `switch.write_credentials.set|clear`,
`switch.quarantine_vlan`, `site.port_control`, `device.quarantine`, `device.quarantine.release`
(also as a system action for an automatic release), `device.quarantine.auto_release_failed`.
Credentials are never in audit metadata.

## UI

- Port Detective → switch → each port has **Change** (admins): current state as last read, risks with
  their source (observed / inferred), enable/disable, description, VLAN picker from the switch's read
  VLANs, override reason when needed, explicit confirmation, and the port's change history.
- Switch → **Port control** card: write credentials (write-only form), VLANs read, per-switch quarantine
  VLAN, open quarantines, change history with before (read by the collector, or "as last read") and
  after (read back).
- Port Detective → **Port control for this site**: the site's quarantine VLAN, with switches missing it.
- Device page → switch-port card → **Quarantine** / **Release**, with why it is not possible when it isn't.
  The quarantine dialog has **Release automatically** (No / after 1 h … 7 days, English and Arabic);
  the card shows when the automatic release is due.

## Code

- API: `apps/api/src/modules/ports/control/` (`schema.ts`, `service.ts`, `routes.ts`, `ingest.ts`),
  `ports/credentials.ts` (`buildSnmpConfig` write-credential delivery), migration `021_switch_port_control.sql`,
  protocol `apps/api/src/common/switch-port-protocol.ts`.
- Collector: `collectors/lan-collector/internal/agent/switchports.go`, `internal/snmp/write.go`, `vlan.go`.
- Web: `apps/web/features/ports/` (`control-text.ts`, `control-types.ts`, `components/port-actions.tsx`,
  `switch-control.tsx`, `site-port-control.tsx`, `device-quarantine.tsx`, `request-history.tsx`).
- Tests: `apps/api/tests/switch-port-control.test.ts` (including the auto-release job),
  `internal/agent/switchports_test.go`, `internal/snmp/write_test.go`, `internal/snmp/rollback_test.go`
  (single-step rollback against the SNMP simulator with a switch that ignores or mangles a SET).

## Limits

- One pending change per port; one write at a time per collector.
- Only plain access ports are moved between VLANs (trunks are refused by the collector unless overridden).
- Vendors without Q-BRIDGE-MIB write support or the Cisco VLAN-membership MIB can only be enabled/disabled
  and described.
