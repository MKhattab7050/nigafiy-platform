# Nigafiy — Hardening, AI Removal & Multi-Vendor Routers Plan

**Created:** 2026-11-21  
**Branch:** `phase-2-network-intelligence` (continuing from commit `3501abe`, right after Milestone 0b)  
**Companion plans:**
- Master plan: `docs/superpowers/plans/2026-11-21-nigafiy-implementation.md`
- Spec: `docs/superpowers/specs/2026-11-21-nigafiy-platform-design.md`
- Milestone 2 (Rename & Brand): `docs/superpowers/plans/2026-11-21-nigafiy-m2-rename.md`

---

## 1. Owner Decisions (2026-11-21)

1. **Keep the brand name `Nigafiy` as decided.** Continue the approved Nigafiy restructuring and Milestone 2 rename & brand plan without changing the name.
2. **Remove the AI Assistant completely.** The platform stays 100% deterministic, local-first, and evidence-backed with no cloud LLM dependency.
   - `Nigafiy Mind` keeps **Knowledge Memory**, **Playbooks** (approval-gated), and **Automation** — no `/assistant` module or `ExplainWithAi` UI.
   - Existing databases upgrade cleanly via forward migration `027_remove_ai_assistant.sql` (drop assistant tables safely without touching `026_ai_assistant.sql`).
3. **Add comprehensive multi-vendor Router Control drivers** (beyond Zyxel). Every driver must implement a real vendor management protocol with strict scope/TLS safety, lockout protection, block ledger semantics, and fake-server unit tests — zero simulated or stub drivers in production.
4. **Work one focused step at a time**, running the full verification gate after each step, and then continue the Nigafiy restructuring milestones right from where Milestone 0b ended.

---

## 2. Standing Safety & Engineering Rules

- **Never touch the owner's installed LAN Detective** (`C:\Program Files\LAN Detective`, ports `47100/47130/47133`). Never stop processes by image name; stop only by PID. Always verify ports before desktop/launcher smoke tests and use `--user-data-dir=<scratch>`.
- **100% real product:** no mock/demo modes or fabricated values in production code. Test doubles live only in test files.
- **No feature regressions:** every existing feature (other than the explicitly removed AI Assistant) must keep full backend, DB, UI, i18n (EN + AR/RTL), RBAC, audit logging, and tests.
- **Verification gate per step:**
  - `pnpm typecheck`
  - `pnpm test` (API integration tests against real PostgreSQL + RLS)
  - `pnpm test:collector` & `pnpm test:agent`
  - `pnpm --filter @lan-detective/web build` (later `@nigafiy/web`)
  - `pnpm --filter @lan-detective/desktop test`
  - Update `docs/roadmap/status.md` in the same step/commit.

---

## 3. Execution Order (Step by Step)

### Track A — Immediate Pre-M2 Changes (before renaming files in Milestone 2)

#### Step A1: Remove AI Assistant Completely
- [x] Add forward migration `apps/api/src/database/migrations/027_remove_ai_assistant.sql` dropping `assistant_messages`, `assistant_conversations`, `assistant_usage`, `assistant_settings`.
- [x] Remove `apps/api/src/modules/assistant/` and unregister `assistantModule` from `apps/api/src/modules/registry.ts`.
- [x] Remove `apps/api/tests/ai-assistant.test.ts`.
- [x] Remove `apps/web/app/(app)/assistant/`, `apps/web/features/assistant/`, the `/assistant` entry in `apps/web/features/registry.tsx`, the `assistant` i18n module in `apps/web/lib/i18n/dictionary.ts`, and `ExplainWithAi` hooks in `doctor-screen.tsx` and `incident-detail-screen.tsx`.
- [x] Update `docs/roadmap/status.md` and `docs/superpowers/specs/2026-11-21-nigafiy-platform-design.md` (Nigafiy Mind row).
- [x] Run full verification gate.

#### Step A2: Multi-Vendor Router Control Drivers (`collectors/lan-collector/internal/router/*`)
Expand beyond `zyxel` so company and home networks across major vendors work with real protocols. Each vendor is added with:
- Real protocol driver implementing `router.Driver` (and `router.RateLimiter` / `router.Scheduler` where genuinely supported by the vendor API).
- Explicit capabilities reporting (unsupported features clearly state why).
- Safe scoped `router.HTTPClient` / TLS pinning / lockout detection / non-destructive block ledger (`AlreadyInEffect` so pre-existing admin rules are never touched).
- Comprehensive Go unit tests with realistic `httptest` fake servers in `*_test.go`.
- Registration in collector `cmd/lan-collector` & `cmd/router-probe`, API `ROUTER_VENDORS` (`apps/api/src/modules/routers/schema.ts`), shared types, API tests, and Web UI vendor selector + EN/AR strings.

Target vendor drivers (added incrementally, one vendor or clean group per commit):
- [x] **MikroTik RouterOS v7** (`internal/router/mikrotik`): REST API (`/rest/system/resource`, `/rest/ip/dhcp-server/lease`, `/rest/ip/arp`, `/rest/interface/wireless/registration-table` & `/rest/interface/wifi/registration-table`, firewall filter/address-list block tagged with Nigafiy comment, simple queue rate limits).
- [x] **Ubiquiti UniFi Network** (`internal/router/unifi`): UniFi OS & Classic Controller API (`/api/auth/login` + fallback `/api/login`, `/stat/sta`, `/stat/user`, `cmd/stamgr` `block-sta` / `unblock-sta`).
- [x] **OpenWrt** (`internal/router/openwrt`): ubus JSON-RPC (`/ubus` `session.login`, `luci-rpc.getDHCPLeases`, `luci-rpc.getHostHints`, `iwinfo.assoclist`, `uci` firewall block rule tagged for Nigafiy + `uci.commit` + firewall reload).
- [x] **OPNsense** (`internal/router/opnsense`): REST API with API key/secret Basic Auth (`/api/core/firmware/status`, `/api/diagnostics/interface/getArp`, `/api/dhcpv4/leases/searchLease`, firewall alias-based block + reconfigure).
- [x] **pfSense** (`internal/router/pfsense`): pfSense REST API v2 (`/api/v2/system/version`, `/api/v2/diagnostics/arp_table`, `/api/v2/services/dhcp_server/leases`, managed alias block + apply).
- [x] **FortiGate (FortiOS)** (`internal/router/fortigate`): FortiOS REST API (`/api/v2/monitor/system/status`, `/api/v2/monitor/user/device/query`, `/api/v2/monitor/user/banned/select`, `add_users`, `clear_users`).
- [x] **TP-Link Omada Controller** (`internal/router/omada`): Omada Controller Web/Open API (login, site clients, block/unblock client, rate limit).
- [x] **ASUS (Asuswrt / Merlin)** (`internal/router/asus`): Asuswrt HTTP API (`/login.cgi`, `appGet.cgi` client list + DHCP leases, `multifilter` / `MACList` per-device block ledger).
- [x] **Cisco IOS XE RESTCONF** (`internal/router/ciscoxe` — vendor `cisco_xe`, RESTCONF `/restconf/data` ARP/DHCP read-only).
- [x] **Huawei Home / ISP Gateways** (`internal/router/huawei` — vendor `huawei`, DG8045 / HG630 / HG633 / HG8145V5 / WS5200 / AX3, SCRAM-SHA-256 + HostInfo + MAC blacklist).
- [x] **Huawei 4G/5G Home CPE** (`internal/router/huaweilte` — vendor `huawei_lte`, B315 / B525 / B535 / B818 / H122 / H155 — STC/Zain/Mobily/Vodafone/WE, HiLink XML API `password_type=4` + host-list + multi-macfilter).
- [x] **ZTE ZXHN Gateways** (`internal/router/zte` — vendor `zte`, H168N / H188A / F660 / F670L / F680 — WE/Orange/Etisalat/Maroc Telecom, SHA-256 `login_entry` + `accessdev_landev_lua` + `localnet_macfilter_lua`).
- [x] **TP-Link Home / Archer** (`internal/router/tplink` — vendor `tplink_archer`, C6 / C80 / AX10 / AX53 / VR400, RSA-PKCS1v1.5 `/cgi-bin/luci` `stok` + DHCP + Access Control blacklist).
- [x] **D-Link DIR / EXO / COVR** (`internal/router/dlink` — vendor `dlink`, HNAP1 SOAP HMAC-MD5 `Login`, `GetDeviceSettings`, `GetClientInfo`, `GetMACFilters2`/`SetMACFilters2`).
- [x] **Tenda Home Routers** (`internal/router/tenda` — vendor `tenda`, F3 / AC6 / AC10 / AC11 / AC23, `/login/Auth`, `/goform/getQos`, block/unblock + per-device rate limits).

---

### Track B — Architecture, Security & Quality Hardening

#### Step B1: Foundations (CI, Linting, CSP, Go Alignment, Frontend Tests, Git Hygiene)
- [ ] Align Go toolchain version across `collectors/lan-collector/go.mod` and `agents/endpoint-agent/go.mod`.
- [ ] Add `Content-Security-Policy` header in `apps/web/next.config.ts` and verify zero CSP console errors across EN/AR pages.
- [ ] Add Biome (`biome.json`) + `pnpm lint` across the monorepo.
- [ ] Add GitHub Actions CI (`.github/workflows/ci.yml`) running `typecheck`, `lint`, API integration tests, Go tests (`collector` + `agent`), desktop tests, and `web` build.
- [ ] Add frontend E2E / component smoke tests in `apps/web` covering Auth, Dashboard, Devices, Routers, Monitoring, Incidents, Endpoints, and Settings (EN + AR/RTL).
- [ ] Clean up `master` vs `phase-2-network-intelligence` divergence (with owner approval before merging/fast-forwarding `master`).

#### Step B2: Multi-Instance Reliability, Secrets Lifecycle & Remote Desktop Pre-WebRTC Fixes
- [ ] Replace in-memory `commandEvents` (`EventEmitter` in `apps/api/src/modules/endpoints/repo.ts`) with PostgreSQL `LISTEN/NOTIFY` so interactive endpoint commands work across multiple API instances.
- [ ] Add optional `REDIS_URL` store for `express-rate-limit` in `apps/api/src/app.ts` (falling back cleanly to memory store in single-node/local mode).
- [ ] Add `APP_ENCRYPTION_KEY` key rotation CLI (`rotate-key`) re-encrypting all sealed columns in a single transaction + integration test.
- [ ] Add documented DB Backup / Restore CLI (`pg_dump` / `pg_restore`) working with both `embedded-postgres` and external PostgreSQL.
- [ ] Improve current Remote Desktop fallback path before Milestone 4b WebRTC:
  - Stop persisting full Base64 JPEG frame payloads in PostgreSQL `endpoint_commands` (stream binary frames over WebSocket or keep transient in-memory/stream channel while preserving session audit logs).
  - Replace `resizeNearest` in `agents/endpoint-agent/internal/remotedesktop/remotedesktop.go` with higher-quality downscaling + unchanged-frame skipping.
- [ ] Harden DNS Access Control UX: show explicit protection mode (`DNS-only` vs `Router-enforced`) and flag known DoH bypass indicators when observed.

---

### Track C — Continue Nigafiy Restructuring Milestones (Master Plan)

Resuming right after Milestone 0b (`3501abe`) following `docs/superpowers/plans/2026-11-21-nigafiy-implementation.md`:

- [ ] **Milestone 2 — Rename and Brand** (`docs/superpowers/plans/2026-11-21-nigafiy-m2-rename.md`):
  - Task 1: `@nigafiy/brand` assets & multi-size `.ico` generator
  - Task 2: `NIGAFIY_*` / `NIGAFIY_SENSOR_*` env vars with legacy `LD_*` / `LAN_COLLECTOR_*` fallback
  - Task 3: `@lan-detective/*` → `@nigafiy/*` npm scope rename
  - Task 4: Go modules, binary names (`nigafiy-sensor.exe`, `nigafiy-agent.exe`), User-Agents
  - Task 5: Visible product name, logos, and `resolveDataDir` legacy profile lookup
  - Task 6: `docs/architecture/naming.md`, `check:brand` script, full gate + packaged smoke test
- [ ] **Milestone 3 — Engine Service + Hub** (`nigafiy-engine.exe` Windows service + Hub launcher & update check)
- [ ] **Milestone 4 — Programs** (`lib/programs.ts`, namespaced URLs + redirects, per-program Go launchers, `nigafiy://`, shared device card)
- [ ] **Milestone 4b — Fleet Pro** (DXGI + H.264 WebRTC via `pion/webrtc` + TURN relay, secure desktop/Winlogon, Quick Support, recording, clipboard, PowerShell, scripts, patches)
- [ ] **Milestone 5 — Installers + LAN Detective Upgrade Path** *(owner gate: code-signing certificate)*
- [ ] **Milestone 6 — Parity Audit** (EN + AR/RTL across all programs, minus removed AI Assistant)
- [ ] **Milestone 7 — Website (`apps/site`)** *(owner gate: domain & download host)*
- [ ] **Milestone 8 — Remaining Roadmap**
