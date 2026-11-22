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
