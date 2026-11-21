# Nigafiy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn LAN Detective into Nigafiy, a family of Windows programs on one engine plus a download website, without losing or simplifying any feature.

**Architecture:** One engine (embedded PostgreSQL + the one API process + the web UI server + the local Sensor) runs as a Windows service. One UI codebase (`apps/web`) is split into program scopes. Small per-program launchers start one shared Electron runtime with `--program=<id>`. A static site (`apps/site`) publishes downloads and a signed release manifest.

**Tech Stack:** pnpm monorepo, Node 24 (API on plain `node`), Next.js 16 / React 19 / Tailwind 4, Electron 39 + electron-builder (NSIS), Go (collector, agent, service host, launchers), PostgreSQL via `embedded-postgres`.

**Spec:** `docs/superpowers/specs/2026-11-21-nigafiy-platform-design.md` (read it with this plan). Current state: `docs/roadmap/status.md`. Baseline commit: `aa4fa3c`.

## Global Constraints

- No feature may disappear, get simpler, or become a button that does nothing. Every row of spec §5 must be ticked off in the parity audit (Milestone 6).
- 100% real: no mock, demo or simulated data or mode in the product. Test doubles live only in test files.
- Never present a guess as confirmed: show how something was found and how sure it is.
- Every feature has backend, DB, UI, validation, permission checks, audit log, tests and documented prerequisites.
- Design for company networks: several sites, routers and vendors.
- Consent and security steps stay explicit clicks: authorizing a scan range, enrolling a machine, remote sessions, destructive actions, DNS filtering, credentials.
- Remote access stays transparent. No stealth access, keylogging, credential capture or covert interception.
- Arabic and English with full RTL everywhere: programs, installers, website.
- **The owner's installed LAN Detective** (`C:\Program Files\LAN Detective`, ports 47100/47130/47133) is never installed over, attached to or stopped. Before a launcher or desktop test, check those ports and 3100/4100/5433 are free. Use `--user-data-dir=<scratch>`. Stop processes by PID only, never by image name.
- Only scan 192.168.1.0/24. The router admin password is typed only by the owner.
- Dev: embedded PG (dev 5433, tests 5439 or `LD_TEST_PG_PORT`), init with `--encoding=UTF8 --locale=C`. API on 4100 with plain `node` (no `--watch`). Web on 3100.
- Gate for every milestone: `pnpm typecheck`, `pnpm test`, `pnpm test:collector`, `pnpm test:agent`, `pnpm --filter @lan-detective/web build` (later `@nigafiy/web`), and `apps/desktop` tests all pass. `status.md` is updated in the same commit.

## Review Focus

1. **Arabic/RTL on every new screen.** Mirrored layout, Arabic strings present for every key, and addresses, MACs and configs still left-to-right. Each UI task's browser check is run in both languages.
2. **Role limits on the new screens.** A viewer sees no write buttons. A technician gets a 403 on admin-only actions, and the UI shows the server's message instead of failing silently. Each UI task checks this as a viewer.
3. **Empty and error states with real data.** No SSH device, no Wi-Fi adapter, the collector offline, UDP 67 already taken. Each screen states the real reason and the next step, never a blank panel. The collector side reports `error.kind` (`listen_failed`, `not_supported`, `no_interface`) and the UI renders it.
4. **Old links after URL namespacing.** Every pre-Nigafiy URL (bookmarks, links in notification emails, `/devices/<id>`) still opens the right page. Milestone 4 pins this with a test that walks the old route list.
5. **Upgrade safety.** An existing LAN Detective data folder is migrated only on a copy during development. Enrolled collectors and agents that use old names, token prefixes and URLs keep connecting. Milestone 5 pins this with an upgrade test on a copied data folder.

---

## Part A: Milestones (the order of work)

Each milestone ends with the gate above, a `status.md` update and a commit. The owner approves before the next milestone starts only where marked **(owner gate)**.

| # | Milestone | Deliverable | Owner gate |
| --- | --- | --- | --- |
| 0 | Baseline | Commit `aa4fa3c`, all checks green | done |
| 1 | Design mockups | HTML mockups: Hub home, Radar devices, website home, the icon set (with logo options). Published for review | **yes** (final logo too) |
| 0b | Finish half-built features | Smart checks wired in the collector with tests, plus UI. Config backup UI. Playbooks UI. System self-check screen. Feature docs for each | no |
| 2 | Rename and brand | Nigafiy names, logos, package names `@nigafiy/*`, binaries `nigafiy-sensor.exe` and `nigafiy-agent.exe`. Every persisted or on-the-wire identifier kept or migrated per the decision table (Part C) | no |
| 3 | Engine service + Hub | Go service host `nigafiy-engine.exe` supervising PG, API, web and Sensor. Hub program: sign-in, home dashboard, program launcher, update check | no |
| 4 | Programs | `lib/programs.ts` registry, program-scoped shell and accent, namespaced URLs with redirects, launchers, `nigafiy://` handler, `GET /api/v1/platform/programs`, shared device card with cross-program actions, cross-program notifications | no |
| 4b | Fleet Pro | Everything in `docs/features/fleet-pro.md`: WebRTC streaming with H.264, secure desktop and sign-in screen, unattended access by policy, Quick Support, permission profiles, recording, chat, clipboard, file transfer, PowerShell, scripts and jobs, patches, monitoring, the user's session bar and support activity. Mockups `docs/design/mockups/Fleet*.dc.html` | approved 2026-11-21 |
| 5 | Installers + upgrade | NSIS package per program, the full bundle, the "build your bundle" Hub installer, Agent and Sensor packages. LAN Detective upgrade path tested on a copy | **yes** (code-signing certificate decision) |
| 6 | Parity audit | Every row of spec §5 walked in the running programs, in Arabic and English, and recorded in `status.md` | no |
| 7 | Website | `apps/site` static site in Arabic and English: home, per-program pages with real screenshots, downloads, docs, changelog, security page, signed release manifest | **yes** (domain, hosting, download host) |
| 8 | Existing roadmap | Remaining Phase 5/6 items in `status.md`, now inside the right program | no |

Milestone 1 comes first because it waits on the owner. Milestone 0b runs while the owner looks at the mockups, so no time is lost. Nothing is restyled before the mockups are approved. 0b uses the current look and gets restyled with everything else in Milestone 4.

Milestones 2 to 8 each get their own detailed task plan (`docs/superpowers/plans/2026-11-21-nigafiy-m<N>-<name>.md`), written when the milestone starts. They depend on what the mockups decide and on what the previous milestone produced, so detailing them now would mean writing them twice. Part B details Milestones 1 and 0b.

---

## Part B: Detailed tasks for Milestones 1 and 0b

### Task 1: Design mockups (Milestone 1)

**Files:**
- Create: `docs/design/mockups/index.html` (one page, tabs: Hub home, Radar devices, website home, icon set)
- Create: `docs/design/mockups/README.md` (what each mockup decides and the open choices)

**Interfaces:**
- Produces: the design tokens later milestones copy (`--accent-hub`, `--accent-radar`, … and the shared status colours `--ok`, `--warn`, `--crit`), the program glyph choice per program, and the logo options.

- [ ] **Step 1: Build the mockup page.** Static HTML and CSS, no external data. Light and dark themes following `prefers-color-scheme`, with a toggle. An EN/AR toggle that flips `dir="rtl"`. Accents from spec §8: Hub brand blue, Radar cyan, Watch amber, Guard red, Fleet violet, Mind pink, Toolbox green. Status colours never reuse an accent. Segoe UI Variable for the programs, a web font with good Arabic (e.g. IBM Plex Sans Arabic) for the website mockup. Mica is shown as a translucent window background with a solid fallback.
- [ ] **Step 2: Fill the screens only with labelled placeholder content** (for example "Device name", "192.168.1.x"). No invented statistics presented as real. The page says it is a mockup.
- [ ] **Step 3: Icon set.** One family. Each program glyph sits in a rounded square in its accent. Show three Nigafiy logo options.
- [ ] **Step 4: Verify.** Open in the browser pane at desktop and 375 px width, in light, dark, EN and AR. No horizontal scroll, Arabic renders correctly.
- [ ] **Step 5: Publish for the owner and ask:** which direction and which logo. Record the answers in the README.
- [ ] **Step 6: Commit** `docs/design/mockups/`.

### Task 2: Wire smart checks into the collector (Milestone 0b)

The API side (`modules/security`, protocol `apps/api/src/common/smart-check-protocol.ts`, heartbeat key `smart_checks` built by `buildSmartCheckConfig`) and the Go library `internal/smart` exist. Missing: the collector never reads `smart_checks`, never runs the checks, never sends `smart_check` items, and has no banner probe or DHCP fingerprint report.

**Files:**
- Modify: `collectors/lan-collector/internal/cloud/client.go` (add `SmartChecks json.RawMessage \`json:"smart_checks,omitempty"\`` to `RemoteConfig`. Not secret, may be cached)
- Create: `collectors/lan-collector/internal/agent/smartchecks.go` (config decode, per-check scheduler, run-now handling, item building)
- Create: `collectors/lan-collector/internal/agent/smartchecks_test.go`
- Create: `collectors/lan-collector/internal/smart/banner.go` + `banner_test.go` (HTTP/HTTPS banner probe)
- Create: `collectors/lan-collector/internal/smart/fingerprint.go` + `fingerprint_test.go` (option 55/60/12/54 report from the passive DHCP listener)
- Create: `collectors/lan-collector/internal/smart/dhcpprobe_test.go`, `upnp_test.go`, `wifi_test.go` (parsers: `ParseOffer`, `BuildDiscover`, `ParseSSDPLocation`, `ParseIGDDescription`, `MappingFromFields`, `ChannelOf`, `SecurityFromIEs`, `ParseNmcliWifi`)
- Modify: `collectors/lan-collector/internal/dhcp/dhcp.go` (keep option 55 and option 54 on `ClientMessage`)
- Modify: `collectors/lan-collector/internal/agent/agent.go` (new `Deps` fields, start the smart scheduler)

**Interfaces:**
- Consumes: the `smart_checks` JSON shape of `SmartCheckConfig` (`apps/api/src/modules/security/config.ts`), the `smart_check` item schema, `smart.DHCPProbe`, `smart.AuditUPnP`, `smart.ReadWiFi`.
- Produces (Deps, nil disables each one, the same pattern as `ConfigBackup`):
  - `SmartDHCP func(ctx context.Context, ifaces []smart.DHCPInterface, listen time.Duration) []smart.DHCPInterfaceResult`
  - `SmartUPnP func(ctx context.Context, locals []netip.Addr, allowed []netip.Prefix) []smart.UPnPGateway`
  - `SmartWiFi func(ctx context.Context) (smart.WiFiReport, error)`
  - `SmartBanners func(ctx context.Context, targets []netip.Addr, ports []int, allowed []netip.Prefix) smart.BannerReport`
  - `smart.FingerprintTable` with `Observe(m dhcp.ClientMessage)` and `Drain(since time.Time) []smart.Fingerprint`

- [ ] **Step 1: Parser tests first** for the existing `internal/smart` functions, with captured packet and command-output fixtures in `testdata/`. Example: `TestParseOfferReadsServerAndOptions` builds a DHCPOFFER with option 54 `192.168.1.2`, option 3 `192.168.1.2`, option 6 `192.168.1.2,1.1.1.1`, lease 86400, and expects those values in `DHCPOffer`. Also `TestParseOfferRejectsWrongXID`, `TestParseNmcliWifiEscapedColons`, `TestChannelOf` (2412→1 "2.4 GHz", 5180→36 "5 GHz", 5955→1 "6 GHz").
- [ ] **Step 2: Run** `cd collectors/lan-collector && go test ./internal/smart/`. Fix the library where tests expose bugs.
- [ ] **Step 3: Banner probe test** `TestBannerProbeOnlyInsideAllowedScopes`: an `httptest` server on 127.0.0.1. A target outside `allowed` is never dialled and is not in `probed`. A target inside returns `status`, `title` (from `<title>`, trimmed, max 120 chars, control characters removed), `server` header, and TLS subject, issuer and `tls_self_signed` for https. Ports come only from config (the API fixes them to 80/443/8080/8443). One GET of `/`, no redirects followed, 3 s timeout, at most 64 KiB read.
- [ ] **Step 4: Implement** `smart.ProbeBanners(ctx, targets []netip.Addr, ports []int, allowed []netip.Prefix) BannerReport`. TLS verification is skipped only to *read* the certificate and the result is labelled `tls_self_signed`. Nothing is ever sent beyond the GET.
- [ ] **Step 5: Fingerprint test** `TestFingerprintTableKeepsOrderAndDedupes`: two DHCPREQUESTs from one MAC with option 55 `1,3,6,15,119,252`. `Drain` returns one client with `prl "1,3,6,15,119,252"`, its vendor class, hostname and `server_id` (option 54), with `seen_at` the last time. At most 1024 clients.
- [ ] **Step 6: Implement** the table, and feed it from the existing passive listener in `internal/dhcp` (receive-only, unchanged behaviour).
- [ ] **Step 7: Agent test** `TestSmartChecksScheduleAndRunNow` (fake Deps, fake clock): with `rogue_dhcp.enabled=true, interval_seconds=3600`, one run happens at start and the next only after 3600 s. A `run_now` entry with `requested_at` T runs once with `trigger:"manual"`, and the same entry does not run again. A disabled check never runs. Each run produces exactly one `smart_check` item whose block matches `check`, a fresh `run_id` UUID and `duration_ms`. A Dep that returns an error produces `ok:false` with `error.kind` (`listen_failed` when UDP 68 cannot be opened, `not_supported` for Wi-Fi off Windows/Linux).
- [ ] **Step 8: Test** `TestSmartChecksNotCachedWhenAbsent`: a heartbeat without `smart_checks` stops every scheduled check.
- [ ] **Step 9: Implement** `smartchecks.go` and wire it in `agent.go` and `SystemDeps()`. Rogue-DHCP sends one DHCPDISCOVER per allowed interface (the documented exception to receive-only, already in `internal/smart`) and never answers.
- [ ] **Step 10: Run** `pnpm test:collector`, `go vet ./...`, `pnpm build:collector`. Then run the real binary against the dev stack on 192.168.1.0/24, press "run now" for each check, and confirm `security_findings` / `GET /api/v1/security` show real results (or a real error kind).
- [ ] **Step 11: Write** `docs/features/smart-checks.md`: what each check does and sends, its prerequisites (UDP 68 free, a Wi-Fi adapter, `netsh`/`nmcli`), its limits, and what was verified on real hardware. Commit.

### Task 3: Smart checks screen (Milestone 0b)

**Files:**
- Create: `apps/web/features/security/{index.ts,strings.ts,types.ts,widget.tsx}`, `screens/security-screen.tsx`, `components/{finding-row.tsx,expected-list.tsx,check-status.tsx}`
- Create: `apps/web/app/(app)/security/page.tsx`
- Modify: `apps/web/features/registry.tsx` (feature `security`, placement `network`, icon `ShieldCheck`, widget with `attention: true`)
- Modify: `apps/web/lib/i18n` dictionaries (EN + AR keys `nav.security`, `security.*`)

**Interfaces:**
- Consumes: `GET /security`, `GET /security/findings`, `GET /security/schedule`, `POST /security/run`, `POST /security/findings/:id/{acknowledge,resolve,expected}`, `POST /security/expected`, `DELETE /security/expected/:id`.

- [ ] **Step 1:** Screen: per-check status cards (last run, result, error kind with the next step, "Run now" for technician+). Findings table with severity, evidence and how it was found ("observed" vs "inferred"), and filters. Acknowledge, resolve, and "this is expected" (e.g. a second DHCP server the admin knows about). The expected list can be deleted by an admin. The schedule is shown with a link to automation settings (one place to change it). All untrusted text (SSIDs, titles, UPnP descriptions) is rendered as plain text.
- [ ] **Step 2:** Widget for "Needs your attention": open high/critical findings.
- [ ] **Step 3: Verify:** `pnpm typecheck` and the web build. In the browser against the dev stack with the real collector: EN and AR, viewer vs technician vs admin, the empty state before any run, and an error state.
- [ ] **Step 4: Commit.**

### Task 4: Config backup screen (Milestone 0b)

**Files:**
- Create: `apps/web/features/config-backup/{index.ts,strings.ts,types.ts,widget.tsx}`, `screens/{config-backup-screen.tsx,config-target-screen.tsx}`, `components/{target-form.tsx,credentials-form.tsx,host-key-panel.tsx,version-list.tsx,diff-view.tsx}`
- Create: `apps/web/app/(app)/config-backup/page.tsx`, `apps/web/app/(app)/config-backup/[id]/page.tsx`
- Modify: `registry.tsx` (feature `config-backup`, placement `network`, icon `History`), i18n EN + AR
- Modify: device detail screen: a "Configuration backup" card linking to the target or offering "Back up this device" when `GET /config-backup/suggestions` lists it
- Create: `docs/features/config-backup.md`

**Interfaces:**
- Consumes: all `/config-backup/*` routes listed in `modules/configbackup/routes.ts`.

- [ ] **Step 1:** List screen: targets with vendor (detected vs manual, with confidence), last result and schedule. Auto-detected suggestions ("these devices answer SSH") with one-click add. "Probe" runs `POST /config-backup/probe` and shows the result.
- [ ] **Step 2:** Target screen: credentials form (write-only, the password is never shown back, "saved" state only). Host key panel: show the fingerprint the collector saw, and require an explicit "Trust this key" click (TOFU); "Forget" asks for confirmation. "Back up now". Version list. Side-by-side and inline diff of any two versions (monospace, LTR even in Arabic). Download of a version.
- [ ] **Step 3: Verify** as in Task 3. Without an SSH device on the LAN, check the probe's "no SSH" result and the empty states for real. The diff view is checked through the API tests' fixtures loaded in the dev DB (a test-only path, never in the product).
- [ ] **Step 4:** Write `docs/features/config-backup.md` (vendors, prerequisites, what is stored and encrypted, what is not verified). Commit.

### Task 5: Playbooks screens (Milestone 0b)

**Files:**
- Keep and use: `apps/web/features/playbooks/{types.ts,text.ts,strings.ts,components/common.tsx,components/trigger-editor.tsx}`
- Create: `features/playbooks/{index.ts,widget.tsx}`, `screens/{playbooks-screen.tsx,playbook-editor-screen.tsx,runs-screen.tsx,run-detail-screen.tsx}`, `components/{step-editor.tsx,approval-card.tsx,settings-card.tsx}`
- Create: `apps/web/app/(app)/playbooks/page.tsx`, `playbooks/[id]/page.tsx`, `playbooks/runs/page.tsx`, `playbooks/runs/[id]/page.tsx`
- Modify: `registry.tsx` (feature `playbooks`, placement `tools`, icon `GitBranch`, badge = pending approvals from `GET /playbook-approvals`), i18n EN + AR
- Create: `docs/features/playbooks.md`

**Interfaces:**
- Consumes: `/playbooks`, `/playbooks/catalog`, `/playbooks/from-template`, `/playbooks/settings`, `/playbooks/:id/run`, `/playbook-runs`, `/playbook-runs/:id`, `/playbook-runs/:id/cancel`, `/playbook-runs/:id/steps/:stepId/decision`, `/playbook-approvals`.

- [ ] **Step 1:** List: playbooks, templates ("start from a template"), enable/disable (admin).
- [ ] **Step 2:** Editor: trigger (existing `trigger-editor.tsx`), steps chosen from the catalogue, each showing whether it is disruptive and needs approval. The server's validation errors show next to the field.
- [ ] **Step 3:** Runs and run detail: a timeline of steps with status, output and the honest effect note (e.g. "DNS filter is off, so the pause has no effect"). Approve/reject with comment. The server's `self_approval` and two-person-rule refusals are shown as such. Cancel follows the role rules.
- [ ] **Step 4:** Settings card (admin): two-person rule, approval TTL in minutes. Approvals inbox widget.
- [ ] **Step 5: Verify** as in Task 3, including a real run against a real device on the LAN with a non-disruptive step, and an approval flow with two accounts. Commit with the doc.

### Task 6: System self-check screen (Milestone 0b)

**Files:**
- Create: `apps/web/features/settings/components/system-health.tsx`
- Modify: `apps/web/features/settings/screens/*` (a "System" section), i18n EN + AR
- Modify: `docs/roadmap/status.md` (the `/system` wording)

- [ ] **Step 1:** Render `GET /system/modules`: each module, its background jobs, last run, last error and whether it is overdue. Readable by any role, as the API allows.
- [ ] **Step 2: Verify** in the browser in EN and AR, and with a stopped job (the API test fixture state) showing as overdue. Commit.

### Task 7: Close Milestone 0b

- [ ] Run the full gate. Run the packaged-app local smoke with a scratch profile (as in the baseline). Update `status.md` (the table rows become "built", plus what was verified on real hardware and what was not). Commit.

---

## Part C: Decisions taken by the builder (spec §11)

| Topic | Decision | Why |
| --- | --- | --- |
| Service wrapper | A small Go service host `nigafiy-engine.exe` (`golang.org/x/sys/windows/svc`). It starts and supervises PG, API, web and Sensor the way `local-stack.cjs` does today, restarts crashed children with backoff, and logs to the data folder | Go is already in the toolchain. No third-party wrapper binary to ship or sign. The Sensor needs the service's privileges anyway |
| Launchers | One tiny Go `.exe` per program, built with its own icon and version resource (`go-winres`). It starts the shared runtime with `--program=<id>` and its AppUserModelID. Each is a few MB | Small, signable, own taskbar identity |
| URL scheme | `/<program>/<page>` (e.g. `/radar/devices/123`, `/fleet/endpoints/7`). Old URLs answer with a permanent redirect from one route map that tests also read. `nigafiy://<program>/<path>` maps 1:1 to it | One table serves redirects, deep links and tests |
| Updates | Check the signed manifest once a day and at Hub start. Download in the background. Install on the admin's click. Scheduled install is off by default and can be set to a nightly window | Nothing changes under the admin without a click |
| Internal identifiers | **Kept on the wire and on disk:** token prefixes `lde_`, `ldc_`, `ldea_`, `lda_`; the CSRF header `X-LD-CSRF`; DB names and roles (`lan_app`); the collector and agent protocol paths. **Renamed with a fallback:** env vars become `NIGAFIY_*` with `LD_*` still read; data and state folders move during upgrade with the old path still found; package names `@lan-detective/*` → `@nigafiy/*`; binaries `lan-collector.exe` → `nigafiy-sensor.exe`, `endpoint-agent.exe` → `nigafiy-agent.exe` (old service names are migrated by the installers) | Enrolled agents and collectors in the field must keep connecting |
| Fleet streaming | DXGI Desktop Duplication capture, H.264 through Windows Media Foundation (hardware encoder when present), WebRTC via `pion/webrtc` in the agent, decoded by Chromium in the Fleet program. Peer-to-peer on the LAN; between sites through a TURN relay (`pion/turn`) inside the engine. The JPEG frame path stays as the fallback | Works on every Windows 10/11 machine without shipping a codec; no third-party relay; the relay never sees the picture (DTLS-SRTP) |
| Fleet Quick Support | A separate small Go program `nigafiy-support.exe`: no install, attended only, 9-digit code plus one-time PIN, exits and deletes its temp files when the session ends | AnyDesk-style help for computers that are not enrolled, without a hidden install |
| Fleet transparency | Session bar, privacy-screen text, recording mark, audit and the user's support activity cannot be turned off by any policy. The user can end any session, including from the privacy screen with Ctrl+Alt+Shift+E | Spec §2 anti-goal: remote access never becomes less transparent |
| Website framework | Next.js static export (`output: 'export'`) in `apps/site`, sharing the i18n approach and design tokens with `apps/web` | Same stack, no server to run |

## Part D: Owner decisions still open (spec §11)

Asked when the work reaches them: the final logo (Milestone 1), the code-signing certificate (Milestone 5), and the website domain, hosting and download host (Milestone 7).
