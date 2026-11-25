# Flowcharts: how Nigafiy really works

Each diagram shows a flow that exists in the code today, with links to where it lives. Where a flow has
only been exercised by tests, the section says so; [../roadmap/status.md](../roadmap/status.md) has the
full "real hardware versus tests only" table.

Contents:

1. [System components and ports](#1-system-components-and-ports)
2. [Discovery to inventory, events, incidents and notifications](#2-discovery-to-inventory-events-incidents-and-notifications)
3. [Endpoint agent enrollment and command delivery](#3-endpoint-agent-enrollment-and-command-delivery)
4. [Remote desktop: connect, consent, transports, recording](#4-remote-desktop-connect-consent-transports-recording)
5. [A router change with read-back and capability refusal](#5-a-router-change-with-read-back-and-capability-refusal)
6. [Configuration backup and restore safety](#6-configuration-backup-and-restore-safety)
7. [Signed update flow](#7-signed-update-flow)
8. [Distribution channels](#8-distribution-channels)
9. [Sign-in: local, MFA, SSO and throttling](#9-sign-in-local-mfa-sso-and-throttling)

---

## 1. System components and ports

On the admin's PC everything listens on loopback. The engine supervises the database, API, web console
and (in service mode) the Sensor as separate child processes, each in its own Windows Job Object. When
the desktop app has to start the engine itself, it starts `nigafiy-engine run --no-sensor` and runs the
Sensor on its own, as before. Sensors and Agents always dial out to the API; the API never connects
into them. Port numbers shown are the installed app; the dev stack (`pnpm dev:*`) uses 3100 / 4100 / 5433.

```mermaid
flowchart LR
  subgraph PC["Admin's Windows PC, loopback only"]
    DESK["Desktop app, Electron"]
    ENG["nigafiy-engine run, control API 127.0.0.1:47140"]
    DB[("PostgreSQL, embedded, port 47133")]
    API["API, Node + Express, port 47100"]
    WEB["Web console, Next.js, port 47130"]
    SEN["Local Sensor: nigafiy-engine sensor"]
  end
  BR["Browser or program window"]
  RS["Sensor at another site"]
  AG["Agent on a managed computer"]
  LAN["Devices on the LAN"]
  DESK -->|"reuse or start"| ENG
  DESK -.->|"runs it when the engine has --no-sensor"| SEN
  ENG -->|supervises| DB
  ENG -->|supervises| API
  ENG -->|supervises| WEB
  ENG -->|"supervises, service mode"| SEN
  BR -->|"same origin"| WEB
  WEB -->|"proxies /api and WebSocket"| API
  API --> DB
  API -->|"status, update apply"| ENG
  SEN -->|"HTTP on loopback"| API
  RS -->|"HTTPS, LAN TLS listener HTTPS_PORT"| API
  AG -->|"HTTPS poll and results, WebSocket stream"| API
  SEN -->|"ICMP, ARP, SNMP, SSH, DNS 53 if on, MNDP UDP 5678, DHCP 67 listen"| LAN
  BR -.->|"WebRTC video, LAN only, Windows agents"| AG
```

Code: [engine supervisor](../../engine/internal/supervisor), [engine control API](../../engine/internal/control),
[desktop engine-stack.cjs](../../apps/desktop/src/engine-stack.cjs),
[collector-manager.cjs](../../apps/desktop/src/collector-manager.cjs), [scripts/local.mjs](../../scripts/local.mjs),
[API app.ts](../../apps/api/src/app.ts), [web proxy.ts](../../apps/web/proxy.ts),
[LAN TLS](../../apps/api/src/infrastructure/lan-tls.ts). Docs: [desktop/engine.md](../desktop/engine.md),
[engine-sensor.md](engine-sensor.md), [features/lan-tls.md](../features/lan-tls.md).
Tested only: the engine as a Windows service and LAN TLS from a second computer.

---

## 2. Discovery to inventory, events, incidents and notifications

The Sensor sweeps only its authorized scopes, writes every batch to an on-disk spool and uploads it to
`/api/v1/collector/telemetry`. Ingest updates the inventory and emits events. `emitEvent` checks
maintenance windows, stores the event with its evidence, queues a delivery per matching channel (not
during maintenance), hands the event to correlation (incidents) and pings the SSE stream. Background
jobs, each single-runner through a PostgreSQL advisory lock, send the notifications and escalations.

```mermaid
flowchart TD
  CFG["Heartbeat answer: scopes, checks, commands"] --> SWEEP
  SWEEP["Sensor sweep: ICMP, neighbour table, rDNS, mDNS, SSDP, NetBIOS, passive DHCP"] --> SPOOL["On-disk spool"]
  SPOOL -->|"POST /api/v1/collector/telemetry"| INGEST["Ingest: scope and tenant checks"]
  INGEST --> INV["Device inventory: identity by MAC, IP history, classification"]
  INV --> RULES{"Change seen?"}
  RULES -->|"new, offline after 2 sweeps, IP changed, unwanted device"| EMIT["emitEvent"]
  RULES -->|no| DONE["Store samples only"]
  EMIT --> MW{"In a maintenance window?"}
  MW -->|yes| EV1["network_events row, in_maintenance"]
  MW -->|no| EV2["network_events row and notification_deliveries per channel"]
  EV1 --> CORR["correlateEvent"]
  EV2 --> CORR
  CORR --> INC["Incident opened, updated or auto-resolved"]
  INC --> DOC["Network Doctor diagnosis with evidence"]
  EV2 --> DISP["notification-dispatch job every 5 s"]
  DISP --> CH["Email, webhook, Telegram, Slack, Discord, ntfy, with retry"]
  INC --> ESC["notification-escalation job every 60 s"]
  EMIT --> SSE["pg_notify to SSE: the web console refreshes"]
```

Code: [Sensor discovery](../../collectors/lan-collector/internal/discovery),
[spool](../../collectors/lan-collector/internal/spool),
[ingest/discovery/process-run.ts](../../apps/api/src/modules/ingest/discovery/process-run.ts),
[offline.ts](../../apps/api/src/modules/ingest/discovery/offline.ts),
[events/emit.ts](../../apps/api/src/modules/events/emit.ts),
[correlation/engine.ts](../../apps/api/src/modules/correlation/engine.ts),
[doctor](../../apps/api/src/modules/doctor),
[notifications/dispatch.ts](../../apps/api/src/modules/notifications/dispatch.ts),
[escalation.ts](../../apps/api/src/modules/notifications/escalation.ts),
[realtime](../../apps/api/src/modules/realtime). Discovery ran on a real LAN; incidents and diagnoses
have only seen test telemetry (no real outage happened), and Telegram/Slack/Discord/ntfy only local test
servers.

---

## 3. Endpoint agent enrollment and command delivery

An admin creates the endpoint and gets a single-use `ldea_` token (only its SHA-256 is stored). The Agent
exchanges it once for a per-endpoint credential `lda_<id>.<secret>` and keeps it in its state file.
Commands are checked for role and platform before they are queued. Inserting a command fires
`pg_notify('ld_agent_wake')`, which wakes the Agent's long poll on whichever API instance holds it.
Delivery is **at most once**: the API marks the row `delivered` as it hands it out and never hands it out
again (a repeated "restart this computer" would be a reboot loop), and the Agent also skips any command
id it has already seen.

```mermaid
sequenceDiagram
  autonumber
  actor Admin
  participant API as API
  participant DB as PostgreSQL
  participant Agent as Nigafiy Agent
  Admin->>API: POST /endpoints (admin role)
  API->>DB: endpoint row with enrollment token hash
  API-->>Admin: one-time ldea_ token
  Agent->>API: POST /api/v1/agent/enroll with the token
  API->>DB: consume the token, store the credential hash
  API-->>Agent: credential lda_id.secret, saved in the state file
  loop every heartbeat and long poll, wait_ms up to 25 s
    Agent->>API: POST /api/v1/agent/poll (Bearer credential)
  end
  Admin->>API: POST /endpoints/:id/commands
  API->>API: zod schema, role and platform checks, audit row
  API->>DB: insert endpoint_commands, status pending
  DB-->>API: trigger pg_notify ld_agent_wake
  API->>DB: mark delivered, never handed out again
  API-->>Agent: command id, kind, payload
  Agent->>Agent: skip ids already seen, then run
  Agent->>API: POST /api/v1/agent/command-result
  API->>DB: store result, pg_notify ld_command_done
  API-->>Admin: result, live in the console
```

Remote sessions add an access policy on top. `POST /remote-desktop/start` evaluates it in this order,
and every refusal is audited as `fleet.policy_refused` in its own transaction:

```mermaid
flowchart TD
  REQ["Operator: reason, profile, optional TOTP"] --> STEP{"Policy asks for MFA?"}
  STEP -->|yes| SU["POST /fleet/step-up: TOTP to a 5-minute token, 5 wrong codes lock 15 min"]
  STEP -->|no| ROLE
  SU --> ROLE{"Role allowed?"}
  ROLE -->|no| REF["Refused with a code, audited"]
  ROLE -->|yes| IP{"Operator IP in the allow-list?"}
  IP -->|no| REF
  IP -->|yes| HRS{"Inside allowed hours?"}
  HRS -->|no| REF
  HRS -->|yes| MFA{"MFA step-up valid?"}
  MFA -->|no| REF
  MFA -->|yes| PROF["Profile clamped to the group maximum"]
  PROF --> MODE{"Attended or unattended?"}
  MODE -->|attended| USER["Consent dialog on the endpoint"]
  MODE -->|unattended| APPR{"Second-admin approval required?"}
  APPR -->|yes| WAIT["waiting_approval: another admin decides, or it expires"]
  APPR -->|no| UNATT["Refuse window or notice, then start"]
  WAIT -->|approved| UNATT
```

Code: [enrollment](../../apps/api/src/modules/endpoints/enrollment/service.ts),
[agent gateway routes](../../apps/api/src/modules/endpoints/agent/routes.ts),
[agent service.ts](../../apps/api/src/modules/endpoints/agent/service.ts),
[repo.ts deliverPendingCommands](../../apps/api/src/modules/endpoints/repo.ts),
[commands/guards.ts](../../apps/api/src/modules/endpoints/commands/guards.ts),
[migration 033](../../apps/api/src/database/migrations/033_agent_long_poll_wake.sql),
[Agent agent.go](../../agents/endpoint-agent/internal/agent/agent.go),
[fleet-policy](../../apps/api/src/modules/endpoints/fleet-policy) (`enforce.ts`, `step-up.ts`, `approvals.ts`).
Docs: [features/fleet-pro.md](../features/fleet-pro.md). The Windows agent ran for real against the API;
policy branches, approvals and MFA step-up are covered by API tests.

---

## 4. Remote desktop: connect, consent, transports, recording

A session opens only after the policy above. Under the `prompt` policy the hub sends the Agent zero
viewers until the user's consent is recorded, so no frame leaves before consent. The default picture
path is WebSocket binary frames with JPEG tiles, relayed in memory and never stored; if the socket fails
or stays waiting for more than 6 s, the console falls back to one JPEG per HTTP command. On Windows
agents the browser can offer WebRTC (H.264, direct on the LAN, no TURN), signalled over the existing
sockets; any failure falls back to JPEG. Recorded sessions always stay on the server path.

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator browser
  participant Hub as API stream hub
  participant Agent as Agent
  actor User as Person at the computer
  Op->>Hub: POST /remote-desktop/start (policy checked)
  Hub->>Agent: rd_session_open command
  alt policy is prompt
    Agent->>User: consent dialog, 60 s, no answer means no
    User-->>Agent: accept
    Agent->>Hub: consent recorded
  end
  Agent->>User: banner with operator name, reason, End session
  Agent->>Hub: WebSocket /api/v1/agent/stream
  Op->>Hub: WebSocket /endpoints/:id/remote-desktop/stream
  Hub-->>Op: JPEG tiles relayed in memory, acks back to the Agent
  opt Windows agent, recording off, RD_WEBRTC not off
    Op->>Hub: rtc_offer on the stream socket
    Hub->>Hub: session active, viewer has view, agent supports WebRTC
    Hub->>Agent: relay offer
    Agent-->>Op: rtc_answer and ICE through the hub
    Agent-->>Op: H.264 video, direct peer on the LAN
    Op->>Agent: input on the data channel, checked by the Agent
    Agent->>Hub: rtc_input summary, audited as endpoint.rd_input
  end
  Note over Op,Agent: No answer in 8 s, no frame in 10 s, ICE failed, encoder failed or recording on, then rtc_fallback to JPEG
  Note over Op,Hub: JPEG socket fails or waits over 6 s, then HTTP rd_capture fallback
```

Recording, when the group rule is `required` or the holder switches it on:

```mermaid
flowchart LR
  RULE{"Group rule"} -->|off| NOREC["No recording"]
  RULE -->|optional| CHOICE{"Profile allows record and the holder turns it on?"}
  RULE -->|required| REQP{"Profile allows record?"}
  REQP -->|no| REFUSE["Session refused: recording_required_profile_cannot_record"]
  REQP -->|yes| REC
  CHOICE -->|yes| REC["Recording on"]
  CHOICE -->|no| NOREC
  REC --> RTC["WebRTC offers refused, WebRTC viewers moved back to JPEG"]
  RTC --> FILE["API instance holding the agent socket writes AES-256-GCM segments"]
  FILE --> KEY["File key sealed with APP_ENCRYPTION_KEY, covered by rotate-key"]
  FILE --> RET["fleet-recording-retention job deletes expired files"]
  FILE --> PLAY["Playback decrypts one part at a time, audited fleet.recording_viewed"]
  REC --> MARK["Recording mark on the person's session bar, cannot be hidden"]
```

Code: [stream-hub.ts](../../apps/api/src/modules/endpoints/remote-desktop/stream-hub.ts),
[sessions.ts](../../apps/api/src/modules/endpoints/remote-desktop/sessions.ts),
[recording.ts](../../apps/api/src/modules/endpoints/remote-desktop/recording.ts),
[frames.ts](../../apps/api/src/modules/endpoints/remote-desktop/frames.ts),
[Agent rdstream](../../agents/endpoint-agent/internal/rdstream) (`webrtc.go`),
[remotedesktop](../../agents/endpoint-agent/internal/remotedesktop),
[videoenc](../../agents/endpoint-agent/internal/videoenc), [userui](../../agents/endpoint-agent/internal/userui).
Docs: [features/fleet-pro.md](../features/fleet-pro.md). Real here: the consent dialog's 60 s timeout on
Windows and Media Foundation H.264 encoding of a real screen capture. Never run: WebRTC in a real browser
or between two computers.

---

## 5. A router change with read-back and capability refusal

Every router control is an explicit admin request, queued for the site's own Sensor, audited, and
re-read from the router afterwards, so the UI shows what the router really did. A control the driver
does not report as supported is refused before anything is queued, and the Sensor refuses it again if
it ever arrives.

```mermaid
flowchart TD
  ADM["Admin: POST /routers/:id/wifi, rename, reservations, port-forwards or reboot"] --> ROLE{"Role admin?"}
  ROLE -->|no| R403["403"]
  ROLE -->|yes| CAP{"Driver reports the capability as supported?"}
  CAP -->|no| R409["409 unsupported_on_router with the driver's note"]
  CAP -->|yes| SAFE{"API safety checks pass?"}
  SAFE -->|"own_machine, confirm missing"| RSAFE["Refused with the reason"]
  SAFE -->|yes| QUEUE["router_requests and collector_commands rows, audit router.action"]
  QUEUE --> ACK["202 request_id"]
  QUEUE --> SEN["Sensor takes the command on its next heartbeat"]
  SEN --> RULES{"Sensor rules: own Wi-Fi, management ports, LAN subnet, rule still matches?"}
  RULES -->|no| RFAIL["router_result not ok, nothing changed"]
  RULES -->|yes| APPLY["Driver logs in with the sealed credentials over pinned TLS and applies"]
  APPLY --> READ["Driver re-reads the router settings"]
  READ --> RES["router_result: new settings plus change.undo"]
  RES --> STORE["API stores the settings"]
  ACK --> POLL["UI follows GET /router-requests/:id"]
  STORE --> POLL
  RFAIL --> POLL
```

Code: [routers/control.ts](../../apps/api/src/modules/routers/control.ts),
[routers/controls.ts](../../apps/api/src/modules/routers/controls.ts),
[routers/routes.ts](../../apps/api/src/modules/routers/routes.ts),
[Sensor agent/routers.go](../../collectors/lan-collector/internal/agent/routers.go),
[router drivers](../../collectors/lan-collector/internal/router). Docs:
[features/router-controls.md](../features/router-controls.md). Real: the Zyxel VMG3625-T50B (block,
unblock, rename, reserve, port forward, guest Wi-Fi). The other 15 drivers, including the Cisco IOS XE
controls over RESTCONF (IOS XE 16.6+: block, schedule, rate limit, reservations, static-NAT port
forwards), only against pinned-TLS protocol test doubles.

---

## 6. Configuration backup and restore safety

Restore is offered only for vendors whose device rolls a change back by itself: **Juniper Junos**
(`commit confirmed N`) and **Cisco IOS XE** (`configure replace … force revert trigger error timer N`,
then `configure confirm`). Every other vendor shows "Restore not supported". The device's identity is
checked three ways: its pinned SSH host key (a restore never trusts a key on first use), the admin
typing the device name, and the version's own host name, which must match the latest backup's unless
the admin forces it with a second typed confirmation.

```mermaid
flowchart TD
  ASK["Admin: restore version V, typed device name, reason, timer 1 to 10 min"] --> PRE{"Junos or IOS XE, host key pinned, credentials accepted, sealed raw copy, Sensor online, nothing else running?"}
  PRE -->|no| NOT["Restore not supported or not possible now, with the reason"]
  PRE -->|yes| NAME{"Typed name equals the device name?"}
  NAME -->|no| R422["422 confirm_mismatch"]
  NAME -->|yes| HOST{"Host name inside V equals the latest backup's?"}
  HOST -->|"no, not forced"| R409["409 other_device"]
  HOST -->|"yes, or forced with the second typed name"| BK["Fresh backup first"]
  BK -->|fails| F1["Failed: nothing was changed on the device"]
  BK -->|ok| CMD["config_restore command: id only, secrets added in the heartbeat answer"]
  CMD --> LEDGER["Sensor writes the id to its at-most-once ledger, refuses expired commands"]
  LEDGER --> APPLY["Junos: commit confirmed N. IOS XE: SCP, verify md5, configure replace with revert timer N"]
  APPLY --> READBACK["Read back over a second SSH session"]
  READBACK --> MATCH{"Read-back equals the restored text?"}
  MATCH -->|yes| CONFIRM["Confirm: Junos commit, IOS XE configure confirm then write memory"]
  MATCH -->|"no, or session failed"| ROLL["Junos rollback 1, IOS XE configure revert now"]
  CONFIRM --> HASH{"Server: verification version hash equals V?"}
  HASH -->|yes| OK["verified, config_restored event"]
  HASH -->|no| BAD["failed verify_mismatch, config_restore_failed event"]
  ROLL --> BAD2["rolled_back, audited"]
  APPLY -.->|"never confirmed in time"| SELF["Device reverts by itself when timer N ends"]
```

Code: [configbackup/restore.ts](../../apps/api/src/modules/configbackup/restore.ts),
[Sensor configbackup/restore.go](../../collectors/lan-collector/internal/configbackup/restore.go),
[restore_iosxe.go](../../collectors/lan-collector/internal/configbackup/restore_iosxe.go),
[agent/configrestore.go](../../collectors/lan-collector/internal/agent/configrestore.go). Docs:
[features/config-backup.md](../features/config-backup.md). Tested only, against SSH (and SCP) test
doubles of the Junos and IOS XE CLIs; it has never run against a real Junos or IOS XE device.

---

## 7. Signed update flow

Nothing is installed in the background. The manifest is signed with Ed25519; the installer it names is
checked for size, SHA-256 and (when `NIGAFIY_UPDATE_PUBLISHER_THUMBPRINT` is set) its Authenticode
publisher, again at each step. An owner or admin confirms the install.

```mermaid
sequenceDiagram
  autonumber
  participant Rel as Release host, HTTPS
  participant API as API
  actor Admin as Owner or admin
  participant Eng as nigafiy-engine
  participant Help as Update helper
  API->>Rel: GET signed manifest
  API->>API: verify the Ed25519 signature with NIGAFIY_UPDATE_PUBLIC_KEY, newer version?
  Admin->>API: POST /platform/updates/download
  API->>Rel: download over HTTPS, size limit
  API->>API: SHA-256 and publisher check, stage the file
  Admin->>API: POST /platform/updates/install, confirm true
  API->>API: hash again
  API->>Eng: POST /v1/update/apply
  Eng->>Eng: validate, hash and publisher again, copy itself to the helper
  Eng->>Eng: stop Sensor, web, API, database, then exit
  Help->>Help: wait for the engine to exit, hash and publisher once more
  Help->>Help: run the installer silently, write the result
  Help->>Eng: start the service or the desktop app again
```

Code: [platform/updates.ts](../../apps/api/src/modules/platform/updates.ts),
[engine/internal/update](../../engine/internal/update), [scripts/release](../../scripts/release).
Docs: [operations/updates.md](../operations/updates.md). Tested only with signed test manifests: no
update source or signing key exists yet. MSI installs are updated through GPO/Intune instead, and Store
installs by the Store.

---

## 8. Distribution channels

```mermaid
flowchart TD
  SRC["Release build: pnpm release"] --> MSIX["MSIX packages: desktop app, Quick Support"]
  SRC --> MSI["Desktop MSI, per machine"]
  SRC --> AGT["Endpoint agent installer, NSIS"]
  SRC --> NSIS["Desktop NSIS setup .exe"]
  MSIX --> STORE["Microsoft Store: Microsoft re-signs the package"]
  STORE --> PUB["Anyone: no SmartScreen warning"]
  MSI --> OWN["Signed with the organization's free self-signed certificate"]
  AGT --> OWN
  OWN --> GPO["Group Policy or Intune deploys the .cer and the packages"]
  GPO --> ORGPC["Organization computers: no warning"]
  NSIS --> DIRECT["Direct download"]
  DIRECT --> WARN["SmartScreen and Unknown publisher warnings"]
  NSIS --> UPD["In-app updater, flow 7"]
```

Code: [apps/desktop/scripts/build-msix.cjs](../../apps/desktop/scripts/build-msix.cjs),
[scripts/installers](../../scripts/installers), [packaging/endpoint-agent](../../packaging/endpoint-agent),
[scripts/signing](../../scripts/signing). Docs: [operations/installers.md](../operations/installers.md),
[operations/microsoft-store.md](../operations/microsoft-store.md),
[operations/code-signing.md](../operations/code-signing.md). Ran here: NSIS install, upgrade and
uninstall in a scratch folder; MSI, agent installer and MSIX built and signed with a test certificate.
Never run: an MSI install, the agent installer, installing an MSIX package, a Store submission.

---

## 9. Sign-in: local, MFA, SSO and throttling

Local sign-in always runs one scrypt verification, so response time does not reveal whether the
account exists. Credential routes are limited per client IP (10 a minute; counters shared through Redis
when `REDIS_URL` is set). MFA failures are counted **per account**: 5 wrong codes lock the account's MFA
for 15 minutes. SSO is an extra way in per organization, not a replacement.

```mermaid
flowchart TD
  START["Sign-in page"] --> KIND{"Local password or SSO button?"}
  KIND -->|local| LIM{"Under 10 attempts a minute from this IP?"}
  LIM -->|no| R429["429 rate_limited"]
  LIM -->|yes| PW{"scrypt check, dummy hash for unknown emails"}
  PW -->|wrong| R401["401 invalid_credentials"]
  PW -->|ok| MEM{"Active membership?"}
  MEM -->|no| R403["403 no_organization or account_deactivated"]
  MEM -->|yes| HAS{"TOTP enrolled?"}
  HAS -->|yes| TOTP["POST /auth/login/mfa with a 5-minute mfa_token"]
  HAS -->|"no, but the org requires MFA"| ENROL["mfa_setup_required: enrol first"]
  HAS -->|"no, not required"| SESS["Session: ld_session cookie, HttpOnly, only its SHA-256 stored"]
  TOTP --> CODE{"Code valid and not replayed?"}
  CODE -->|no| CNT["Per-account failure count, 5 locks MFA for 15 min"]
  CODE -->|yes| SESS
  ENROL --> SESS
  KIND -->|SSO| SSO["OIDC with PKCE, state and nonce, or SAML 2.0 SP-initiated, bound to the ld_sso cookie"]
  SSO --> VER{"Token or signed assertion verified, email domain allowed, member or JIT?"}
  VER -->|no| ERR["Back to login with sso_error, audited"]
  VER -->|yes| TRUST{"Provider trusts IdP MFA?"}
  TRUST -->|yes| PIN["Session pinned to the provider's organization"]
  TRUST -->|no| HAS
```

Code: [auth/routes.ts](../../apps/api/src/modules/auth/routes.ts),
[auth/mfa.ts](../../apps/api/src/modules/auth/mfa.ts),
[auth/session.ts](../../apps/api/src/modules/auth/session.ts),
[auth/sso](../../apps/api/src/modules/auth/sso) (`oidc.ts`, `saml.ts`),
[rate-limit-store.ts](../../apps/api/src/infrastructure/rate-limit-store.ts). Docs:
[security/model.md](../security/model.md), [features/sso.md](../features/sso.md). SSO has only run
against in-test identity providers.
