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
| Restore | API `modules/configbackup/restore.ts`; collector `internal/configbackup/restore.go`, `internal/agent/configrestore.go` |
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
| Restore a version to the device (preview, typed name, reason) | admin (owner included) |
| See the restore history | any |

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

## Secret sanitization (migration 041)

Stored configurations no longer contain secrets. Before a configuration is hashed, compared, stored,
shown, diffed or downloaded, the server (`apps/api/src/modules/configbackup/sanitize.ts`) replaces
every recognized secret value with a placeholder carrying a keyed fingerprint:

    snmp-server community s3cr3t RO  →  snmp-server community <nigafiy-redacted:hmac=3f0a9c21b7d4> RO

- The fingerprint is HMAC-SHA-256 (first 48 bits) of the value with a random 32-byte key kept per
  backup target in `config_backup_targets.secret_fp_key_enc` (AES-256-GCM, in `rotate-key`; rotation
  re-seals the same key, so fingerprints stay stable). Same secret → same placeholder, so an unchanged
  device keeps its hash; a changed secret shows in the diff as a changed fingerprint and the
  `config_changed` event carries `secret_lines_changed`. Without the key a fingerprint of a weak
  secret ("public") cannot be brute-forced, and fingerprints of two devices cannot be compared.
- Families and what is redacted (rule ids in `SANITIZE_RULES`):
  - Cisco IOS/IOS-XE/NX-OS/ASA, Aruba, Dell, Huawei: `enable secret/password`, `username … secret/password`,
    any `password|secret|passwd [type] value` (line vty, ppp, BGP neighbor, Huawei `local-user … cipher`),
    `snmp-server community`, community in `snmp-server host`, SNMPv3 `auth … priv …`, Huawei
    `snmp-agent community`, RADIUS/TACACS+ keys (global and inside `radius server` / `aaa-server`
    blocks), `key 7 …`, `key-string`, `crypto isakmp key`, keyring / ASA / IKEv2 `pre-shared-key`,
    OSPF `message-digest-key` / `authentication-key`, HSRP authentication, `wpa-psk`, ASA `passwd`.
  - Junos and VyOS/EdgeOS: `encrypted-password`, `plaintext-password`, `secret`, `pre-shared-secret`,
    `authentication-key`, `ascii-text`, `hexadecimal`, `private-key`, `psk`, SNMP `community` names,
    every quoted value on a `## SECRET-DATA` line, and any `$9$…` string.
  - MikroTik RouterOS: `password=`, `secret=`, `wpa(2)-pre-shared-key=`, `private-key=`,
    `preshared-key=`, `authentication-password=`, `encryption-password=` … and the `name=` of
    `/snmp community` entries (the community is its name).
  - FortiOS: `set <…password|passwd|psksecret|passphrase|secret|pwd|psk|key> [ENC] value`, and
    `set name` inside `config system snmp community`.
  - PAN-OS: `phash`, `password`, `key`, `private-key`, `secret`, `community`, `authpwd`, `privpwd`,
    `bind-password` in the curly format and as XML elements.
  - OpenWrt UCI: `option key|key1-4|password|private_key|preshared_key|auth_secret|acct_secret|sae_password|psk|secret|community|wpa_passphrase`.
  - Any vendor: PEM / OpenSSH / PGP private-key blocks (one placeholder line; an unterminated block
    redacts the rest of the text). Certificates (public) are kept.
- Rules prefer over-redaction: a non-secret word in a secret position is redacted too. Sanitizing is
  idempotent and deterministic. Counts per rule (never values) are kept in
  `config_backup_contents.redactions`.
- The collector does not sanitize: it sends the raw text over its authenticated TLS channel, because
  the server needs it for the sealed raw copy (restore).

**Sealed raw copy.** `config_backup_raw.raw_enc` keeps the normalized, unsanitized text of each version
(AES-256-GCM, in `rotate-key`). No API returns it; it exists only for an administrator-confirmed restore.

**Existing versions.** SQL cannot decrypt, so migration 041 marks every existing content row
`sanitized = false`. They are converted by the server (`resanitize.ts`): the configuration-backup job
converts up to 200 targets every 5 minutes, ingest converts a target's rows before comparing a new
backup, and reading a version that is not converted yet sanitizes it in memory first — unsanitized
text is never returned after upgrading. Conversion keeps the old text as the version's raw copy and
re-points the version to its sanitized hash (`ON UPDATE CASCADE`). A row that cannot be decrypted (key
changed) is left and logged; such a version cannot be read anyway (409 `content_unreadable`) and the
next backup replaces it.

Verified by tests: `tests/config-sanitize.test.ts` (fixtures for every family above: no secret survives,
the structure stays, idempotent, keyed) and `tests/config-backup.test.ts` (API never returns a secret,
raw copies are sealed, a changed community shows as a changed fingerprint, legacy rows converted by the
job). Not verified against configurations from real devices; vendor syntax not covered by a rule
(an unusual keyword) would stay visible — report it and add a rule.

## Restore (migrations 041, 047)

An administrator can write an earlier version back to the device. Only vendors that replace the
configuration as a whole **and** roll it back by themselves when the change is not confirmed are supported:

| Driver | Method (`RESTORE_METHODS`) | Device-side rollback |
| --- | --- | --- |
| Juniper Junos | `junos_commit_confirmed` | `commit confirmed N`: rolls back unless confirmed within N minutes |
| Cisco IOS XE | `iosxe_configure_replace` | `configure replace … revert trigger error timer N` (see "Cisco IOS XE restore") |
| VyOS / Ubiquiti EdgeOS | `vyos_commit_confirm` | `commit-confirm N`: reboots into the saved configuration unless `confirm` follows (see "VyOS / EdgeOS restore") |
| OpenWrt | `openwrt_uci_apply_rollback` | rpcd `uci apply` with rollback: copies the previous packages back unless `uci confirm` follows (see "OpenWrt restore") |

Every other vendor shows **"Restore not supported"** with its own reason (EN + AR; `UNSUPPORTED_REASONS`
in `restore.ts`, mirrored in the web strings; see "Why other vendors are not restored"). Download the
version and restore it by hand. No other vendor is attempted.

**Before anything is sent** (`restore.ts`, checked at preview and again at request):
- the vendor has a restore method (`driver`, or the detected driver; `RESTORE_METHODS` in `restore.ts`
  must match the collector's `internal/configbackup/restore.go`);
- the version belongs to this device. Two checks (migration `047_config_restore_identity.sql`):
  - **hardware identity** (Junos, VyOS / EdgeOS, OpenWrt; `IDENTITY_DRIVERS`): every backup also reads the
    model and serial number the device reports (`internal/configbackup/identity.go`: Junos `show version` /
    `show chassis hardware`, VyOS and EdgeOS `show version`, OpenWrt `ubus call system board`, which gives
    a model only), stored on the run and the version. The preview shows both identities and `match`,
    `mismatch` or `unknown`. Anything but `match` needs `allow_other_device` (alias `force_other_device`)
    **and** the device's serial (or model, or address when nothing is known) typed as
    `confirm_other_device`; otherwise 409 `device_identity_mismatch` / `device_identity_unknown` or 422
    `confirm_other_device_mismatch`. The check runs again after the backup before the restore (a device
    swapped in meanwhile fails the restore with `device_mismatch`, nothing changed) and once more by the
    collector on the device itself before it changes anything;
  - **host name**: when the host name the configuration declares (IOS `hostname X`, Junos `host-name X;`)
    differs from the latest backup's, the preview shows both names (`other_device`) and the same forced
    confirmation is needed, typing the version's host name (409 `other_device` otherwise);

  the forced case is recorded on the restore (`forced_other_device`, `identity_check`) and in the
  `config_backup.restore.request` audit row;
- the target is ready (in an authorized scope, credentials set and accepted, host key not changed);
- the SSH host key is pinned (a restore never trusts a key on first use);
- a sealed raw copy of the version exists (versions stored before raw copies existed cannot be restored);
- the version is not already the latest, and no other backup or restore of the device is running;
- a collector of the site is online.

**Flow.**
1. `GET /config-backup/targets/:id/restore-preview?version_id=` (admin, audited
   `config_backup.restore.preview`): the diff from the latest backup to the version (sanitized text),
   whether a restore is possible, and the name to type.
2. `POST /config-backup/targets/:id/restore` (admin) with `version_id`, `confirm` (the device name exactly),
   `reason` (10–500 characters) and `confirm_minutes` (1–10, default 5). A wrong name returns 422
   `confirm_mismatch`. A `config_backup_restores` row is created (`pre_backup`), a fresh backup is queued
   (run trigger `restore`), and `config_backup.restore.request` is audited with the reason.
3. When that backup succeeds, the `config_restore` command is queued (`pending`). If it fails, the restore
   fails with "Nothing was changed on the device". If the device already runs the version, the restore is
   `verified` without applying anything.
4. The stored command holds only the restore id. The credentials, the pinned host key, and the version's
   raw text (decrypted from `config_backup_raw`, gzip + base64) are added only in the heartbeat answer to
   the site's own collector, while the restore is pending. If anything changed (credentials rejected, host
   key changed, vendor changed, raw copy gone), the command is withdrawn and the restore fails
   (`withdrawn`, audited).
5. The collector (`configrestore.go`) writes the restore id to its at-most-once ledger before touching the
   device. It never starts an expired command. Then `Restore()` runs the vendor's method; for Junos:
   `configure exclusive`,
   `load override terminal`, `commit confirmed N`. It reads the configuration back over a **second** SSH
   session and compares it with the restored text. If they match, it runs `commit` (confirm). If not, or if
   the second session fails, it runs `rollback 1` + `commit` (rolled back).
6. The read-back is reported as a normal backup of the restore's verification run, so it becomes a version.
   Then `config_restore_result` reports the steps and flags, never text or credentials. The server marks
   the restore `verified` only when the verification version's hash equals the restored version's hash.
   Otherwise it is `rolled_back` (the collector put the previous configuration back) or `failed`
   (including `verify_mismatch`). It audits `config_backup.restore.result` (actor `collector`) and emits
   `config_restored` or `config_restore_failed`. The failure event is critical when the change was
   committed but neither confirmed nor rolled back.
7. A restore whose backup or result does not arrive in time becomes `expired` (audited
   `config_backup.restore.expired`), and its command is withdrawn.

The screen: on the device page, every version except the latest has **Restore** (admin). The dialog shows
the diff, the rollback timer, the typed name and the reason, or the honest "not supported / not possible
now" text. The **Restores** card lists every restore with its status, reason, flags and the device steps.

**Tested:**
- `tests/config-restore.test.ts`: roles, unsupported vendor, typed name, validation, backup first,
  secrets only in the heartbeat answer, the real raw text delivered, verified by hash, rolled back, failed
  pre-backup, withdrawn, expired, audit rows free of secrets.
- `internal/configbackup/restore_test.go` against an SSH test double of the Junos CLI: success, mangled
  read-back, device unreachable after commit, syntax error, locked configuration, refusals, host key
  changed.
- `internal/agent/configrestore_test.go`: at-most-once, expiry, nothing leaked.

- `internal/configbackup/restore_test.go`: another device refused unless forced (Junos), the method table.

**Not tested:** it has never run against a real Junos device. Junos output and prompt text were modelled
from the documentation, not captured from a device.

### VyOS / EdgeOS restore (`internal/configbackup/restore_vyos.go`, method `vyos_commit_confirm`)

Sources: VyOS documentation (docs.vyos.io, 1.3 / 1.4 / 1.5: `configure`, `set`, `delete`,
`commit-confirm <minutes>`, `confirm`, `discard`, `save`, `show configuration commands`) and the Ubiquiti
EdgeOS CLI (1.10 / 2.0, the same Vyatta commands). Backups are the `set` lines of
`show configuration commands`, which configuration mode accepts back.

What the device guarantees: `commit-confirm N` activates the candidate and schedules a reboot in N
minutes; `confirm` cancels it. The reboot loads the saved boot configuration, so Nigafiy runs `save`
right before the restore: the device's own rollback point is exactly what it ran before. (VyOS 1.4+ can
reload instead of reboot, `system config-management commit-confirm action reload`; Nigafiy does not
change that setting.)

Steps: identity (`show version`) and the configuration before the restore; `configure`, `save`; `delete`
every top-level node and apply every `set` line of the version in the candidate (a refused line runs
`discard` and stops, nothing active); `commit-confirm N`. A second, fresh SSH session reads the
configuration back: equal → `confirm`, `save`. Different or unreadable → the previous lines are applied
again and committed, and only when a third session reads exactly the previous configuration back is the
reboot cancelled with `confirm`; otherwise the timer reboots into the saved previous configuration.
Prerequisite: an account that may enter configuration mode. The automatic way back is a **reboot** (a
short outage) when Nigafiy cannot reach or prove the device after the commit.

Tested only with the SSH protocol double in `restore_vyos_test.go` (verified and saved, read-back
differs → undone and proven, unreachable after commit → timer left running, refusals, identity parsing
and mismatch) and the API side in `tests/config-restore.test.ts`. **Never run against a real VyOS or
EdgeOS device.**

### OpenWrt restore (`internal/configbackup/restore_openwrt.go`, method `openwrt_uci_apply_rollback`)

Sources: OpenWrt rpcd `uci.c` (methods `apply {rollback, timeout}`, `confirm`, `rollback`) and
`session.c`, the OpenWrt ubus documentation (openwrt.org/docs/techref/ubus). This is the mechanism LuCI
uses for "Save & Apply"; it exists since rpcd 2018 (OpenWrt 18.06), older images are refused.

What the device guarantees: `uci apply` with rollback snapshots `/etc/config/<package>` of every package
the ubus session staged changes for, commits them, reloads the services and arms a timer; unless
`uci confirm` (same session) arrives in time, rpcd copies the snapshot back and reloads again.

Steps (each command on its own SSH exec channel; values go through stdin, never on a command line):
`/etc/openwrt_release` must name OpenWrt; identity (`ubus call system board`); rpcd must offer
apply / confirm / rollback; the version and the device must have the same packages and the version must
not change `rpcd` itself; a ubus session is created and granted uci read / write; each differing package
is rebuilt section by section in the session (nothing active yet; a refused call reverts the session);
`uci apply` with rollback and N minutes. A second SSH connection reads `uci export` back: equal →
`uci confirm`; otherwise `uci rollback`, and a third connection must read the previous configuration back.

Limits (shown in the dialog): the timer lives in the rpcd process, so a **reboot or an rpcd restart**
inside the window keeps the restored configuration; a version that adds or removes whole packages is
refused. Prerequisite: root SSH access (or an account allowed to call `ubus` uci / session).

Tested only with the SSH/ubus protocol double in `restore_openwrt_test.go` (apply confirmed, read-back
differs → rolled back and proven, unreachable after apply → rpcd timer left, refusals, `uci export`
quoting, identity parsing) and the API side in `tests/config-restore.test.ts` (model-only identity, a
rolled back restore, the Wi-Fi key kept out of the preview). **Never run against a real OpenWrt device.**

### Why other vendors are not restored

Checked against each vendor's documented mechanisms (2026-11-25). A vendor moves to the table above only
when it can replace the configuration as a whole and roll back by itself.

| Vendor | Reason |
| --- | --- |
| MikroTik RouterOS | `/import` of an export merges (RouterOS 7 `dry-run` only simulates); a full replace is `/system reset-configuration run-after-reset=` with a reboot and no way back; Safe Mode undoes only when the session drops (TCP timeout about 9 min) and keeps the 100 most recent actions, then leaves Safe Mode **without undoing anything** (help.mikrotik.com, "Configuration Management"). |
| Fortinet FortiOS | `execute restore config` and the REST `system/config/restore` reboot into the restored file and save it; revert mode (`set cfg-save revert`, `cfg-revert-timeout`) undoes only unsaved CLI edits; pasted `show` output merges (Fortinet CLI reference "cfg save"). |
| Cisco NX-OS | `configure replace bootflash:<file> commit-timeout` (9.3(1)+) needs a file on bootflash; the collector does not transfer files to NX-OS. |
| Cisco ASA | No commit-confirmed or rollback; a full replace means erasing the configuration and reloading. |
| Aruba ArubaOS-Switch / AOS-CX | ArubaOS-Switch applies every line at once; AOS-CX has `checkpoint auto`, but a whole replace needs a checkpoint or file copied by TFTP / SFTP. |
| Huawei VRP | V8 `commit trial` / `configuration replace file` need a file on flash; V5 has neither. |
| Dell OS10 / OS6, Palo Alto PAN-OS | Replace only from a transferred file; no rollback timer (PAN-OS commit has no confirmed mode). |
| pfSense, OPNsense, UniFi | Not configuration-backup drivers (they appear only under router controls). None offers a timed rollback either: pfSense restores `config.xml` or a Config History entry from the GUI or console with no timer, and pfSense-pkg-RESTAPI v2 documents no restore endpoint; OPNsense's API `core/backup/revert_backup` reverts to a history entry at once, with no confirm timer; UniFi restores a whole-controller `.unf` backup and restarts the controller, not one device's configuration. |

### Cisco IOS XE restore (`internal/configbackup/restore_iosxe.go`, method `iosxe_configure_replace`)

Source: Cisco "Configuration Replace and Configuration Rollback" configuration guide (IOS XE 16.x/17.x) and
the `configure replace`, `configure confirm`, `configure revert` and `archive` command references.

Prerequisites on the device (each is checked, and nothing is changed when one is missing):
- IOS XE ("show version" must say "Cisco IOS XE Software") and a privilege-15 account (the prompt must
  reach `#`, after `enable` when the account logs in at `>`);
- the configuration archive (`archive` with ` path …`): without it IOS XE refuses the rollback timer, so
  Nigafiy refuses first;
- `ip scp server enable` and exec authorization for the account (the file is copied over SCP).

Steps (each one is reported in the restore's steps):
1. checks above, on the host-key-pinned SSH connection;
2. the version is copied to `bootflash:nigafiy-restore.cfg` (`flash:` when the device has no `bootflash:`)
   over SCP on the same connection, and the device's own `verify /md5` must match the MD5 of what was sent;
3. `configure replace bootflash:nigafiy-restore.cfg force revert trigger error timer N` (N = 1–10 minutes,
   from the dialog); it must end with "Rollback Done";
4. a **second**, fresh SSH session reads `show running-config`. Only when that works and equals the
   restored text (ignoring `!` comment lines, the "Building configuration" / "Current configuration"
   header and the measured `ntp clock-period`) is the change kept: `configure confirm`, then
   `write memory` (only now, after the verified change), then the temporary file is deleted;
5. otherwise `configure revert now` puts the previous configuration back at once, and the running
   configuration is read again to prove it (status `rolled_back`). When the revert cannot be proven (or
   the session ends during the replace, or `configure confirm` fails), the error says so and that the
   device reverts by itself when its N-minute timer ends; nothing is saved with `write memory`.
   A release that does not accept the `revert trigger error timer` syntax is refused with nothing changed.

Tested only with the SSH/SCP protocol double in `restore_iosxe_test.go`: verified then saved, `flash:`
fallback (and the default 5-minute timer), read-back differs or the second session is refused after the
replace (reverted, nothing confirmed or saved), refusals with nothing changed (classic IOS, no archive
path, a release without the timer syntax, SCP server off, an upload whose `verify /md5` differs), a
command of the file failing (device reverts, proven by read-back, temporary file removed, no secret in
the error), and the configuration comparison helpers. `tests/config-restore.test.ts` covers the API side (method offered,
another device's configuration refused unless forced with the second typed confirmation).
**Never run against a real IOS XE device**; prompts and messages were modelled from Cisco's documentation.
