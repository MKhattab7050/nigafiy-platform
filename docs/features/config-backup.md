# Configuration backup and diff

The site's collector logs in to switches, routers and firewalls over SSH, reads the running
configuration, and sends it to the server. The server keeps every distinct version, shows what changed
between two versions, and opens a finding when the SSH host key changes.

**Status: not yet verified on real hardware.** The API and the collector are covered by unit tests. The
web screens were checked against the local dev stack only, with no device and no collector online.
Nobody has backed up a real switch through the full path yet.

## Where the code is

| Part | File |
| --- | --- |
| API (targets, credentials, runs, versions, diff, host keys) | `apps/api/src/modules/configbackup` |
| Wire format and the driver list | `apps/api/src/common/config-backup-protocol.ts` |
| Collector side (SSH session, vendor drivers) | `collectors/lan-collector/internal/configbackup`, `internal/agent/configbackup.go` |
| Screens | `apps/web/features/config-backup` (`/config-backup`, `/config-backup/[id]`, and a card on the device page) |

## The screens

**`/config-backup`** (needs a site: it uses the site picked in the top bar, or asks you to pick one):

- **Suggestions.** These are devices that look like network gear, from discovery data. Each one shows
  why it was suggested. **Check SSH now** (technician) asks the collector to test port 22 on them. The
  screen polls the probe until it finishes. **Add** (admin) creates a target with no credentials and
  opens it.
- **Devices backed up.** This is the target table: address, detected vendor, status, last success, and
  the number of versions.
- **Add a device** (admin). Enter the address, an optional driver (or leave it on auto-detect), the
  schedule (daily at an hour, or off), and optional credentials. "Back up now" queues the first run. The
  target page then says what happened: queued, no collector online, or no credentials.

**`/config-backup/[id]`**:

- **Status card.** Shows the status, last error kind with its next step, the pending run, and the
  schedule. It refreshes every 4 s while a run waits for the collector.
- **Back up now** (technician).
- **Delete** (admin) asks you to confirm first.
- **SSH host key.** Shows the pinned fingerprint, when and how it was pinned (first use or accepted by
  someone), and the key the device presents now.
  - The first backup pins the key automatically (trust on first use).
  - If the key changes, backups stop and a warning shows both fingerprints. **Trust this key** (admin)
    opens a dialog that repeats the new fingerprint and needs an explicit confirmation.
  - **Forget** (admin) clears the pin after a confirmation. Use it when the device no longer offers the
    pinned key type. The next backup then pins whatever key it sees.
- **Credentials** (admin).
  - Credentials are **write-only**: the form is never pre-filled, and the API never returns a secret.
  - The options are a password or a private key with an optional passphrase, plus an optional
    enable/privileged password.
  - You can also copy the credentials of another target at the same site.
- **Settings** (admin). Changes the name, port, driver, on/off, schedule and hour. Only changed fields are sent.
- **Versions.**
  - Pick two versions to compare. The diff is inline or side by side, always left-to-right and
    monospaced, and can be downloaded as a `.diff`.
  - Viewing a version and downloading it are **admin only**, because configurations hold secrets.
    Other roles see the timeline with sizes and hashes, plus a note saying who can read the content.
- **Runs.** Each attempt shows its result and error text, plus the next step for that error kind.

**Device page.** The "Configuration backup" card shows the target's status and links to it.
- If the device is not a target but is suggested, an administrator can add it in one click.
- Otherwise the card says why it is not suggested and links to the page.

## Roles

| Action | Role |
| --- | --- |
| See targets, status, version timeline, runs | any |
| Check SSH on suggestions, Back up now | technician |
| Add, change and delete targets; credentials; trust or forget a host key | admin |
| Read the configuration content, the diff, and downloads | admin |

Write actions are hidden below the needed role. When the server still refuses an action (403 or 409),
the screen shows the server's message.

## Error kinds

`out_of_scope`, `unreachable`, `timeout`, `auth_failed`, `host_key_changed`, `privilege`,
`unsupported_vendor`, `command_failed`, `output_too_large`, `protocol`, `invalid_argument`,
`empty_config`, `expired`, `internal`.

Each kind has a plain-language explanation and a next step in `features/config-backup/strings.ts`
(`cb.err.*`).

## Drivers

Cisco IOS / IOS-XE, NX-OS and ASA; Aruba ProCurve and AOS-CX; Juniper Junos; MikroTik RouterOS;
Fortinet FortiOS; Ubiquiti EdgeOS / VyOS; Huawei VRP; Dell OS10 and OS6; OpenWrt; Palo Alto PAN-OS.

"Auto-detect" lets the collector choose the driver from the SSH banner and prompt. The detected vendor
is shown together with how it was detected.
