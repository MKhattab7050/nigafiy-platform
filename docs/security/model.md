# Security model (Phase 1)

| Control | Implementation |
| --- | --- |
| Passwords | scrypt (N=2¹⁵, r=8), per-user salt, constant-time compare; login timing is uniform for unknown users |
| Sessions | 256-bit opaque token in an `HttpOnly`, `SameSite=Lax` (`Secure` in production) cookie; only its SHA-256 is stored; membership re-checked on every request |
| CSRF | Custom header required on all state-changing requests + `Origin` check; no CORS allowances |
| Authorization | Role check middleware on the server for every mutating route; frontend hiding is cosmetic |
| Tenant isolation | PostgreSQL RLS + composite foreign keys + API scoping (see architecture overview §4) |
| Collector enrollment | Single-use, expiring token; hash stored; atomic consumption; rate limited |
| Collector auth | Per-collector 256-bit credential, hash stored, immediate revocation |
| Endpoint agent enrollment & auth | Separate per-machine enrollment token (`ldet_...`) → per-endpoint 256-bit credential (`lda_<id>.<secret>`), SHA-256 hash stored, immediate revocation; supports Go agent (`windows`, `linux`, `macos`) and mobile MDM check-ins (`android`, `ios`) |
| Endpoint remote actions & capability enforcement | Strictly typed closed allow-list (`refresh_inventory`, `kill_process`, `service_action`, `power_action`, `notify_user`, `fs_op`, `rd_capture`, `rd_input`, `software_action`, `fetch_logs`, `diagnostic_command`, `mdm_action`) validated against the endpoint's **Dynamic Capability Matrix** (`modules/endpoints/capabilities.ts`); RBAC enforced (`admin` required for `restart`/`shutdown`/`wipe_device`, `technician`+ for file manager, remote desktop, process/service/session/diagnostics); every command and result recorded in `audit_logs` |
| Remote File Manager safety | Canonical path resolution (`filepath.Clean` + symlink resolution), directory traversal rejection (`..`), null-byte rejection, hard-coded denylist of credential stores (`SAM`, `SECURITY`, `/etc/shadow`, `/etc/gshadow`, `/Library/Keychains`) and critical OS system directories (`C:\Windows\System32`, `/boot`, `/proc`, `/sys`, `/System`), optional per-endpoint policy `allowed_roots`, chunked SHA-256 verified transfers, and mandatory `confirm_destructive: true` for deletion |
| Remote Desktop transparency | Requires explicit active session initiation (`/remote-desktop/start`) before frames or input are accepted, records operator identity and reason in `audit_logs` and `network_events`, supports configurable user consent policy, and triggers an on-screen transparency notification when an administrator connects |
| Input validation | Every payload validated with strict zod schemas; unknown fields rejected |
| Secrets at rest | Webhook signing secrets, SNMP credentials, and SMTP passwords encrypted with AES-256-GCM (`APP_ENCRYPTION_KEY`); never returned after creation |
| Logging | Structured; method/path/status only; credential-bearing fields redacted at the logger |
| Rate limiting | Per-IP limits on login/registration, enrollment, collector API and user API |
| Outbound webhooks | https only, destination resolved and pinned, private/loopback/link-local refused, no redirects, 8 s timeout |
| Error handling | Unexpected errors return a generic message + request id; details stay in server logs |
| Audit | Append-only `audit_logs` (the app role has no UPDATE/DELETE), written in the same transaction as the action |
| Monitoring safety | Scopes: private IPv4 only, ≤ /20, explicit attestation recorded with the administrator's identity; collector re-validates and has compiled-in ceilings |

## Not implemented yet

- MFA, SSO, password reset by email, account lockout beyond rate limiting
- Member invitation UI (memberships exist; additional members are currently added in the database)
- Mutual TLS for collectors (path described in the protocol document)
- Key rotation tooling for `APP_ENCRYPTION_KEY`
- Rate limits are in-memory per API instance (move to a shared store with multiple instances)
- A Content-Security-Policy for the web app
- Independent security review / penetration test

## Deliberately absent

No exploitation, credential harvesting, stealth scanning or packet payload capture exists anywhere in
the codebase. The network collector (`collectors/lan-collector`) remains strictly an observer/prober
and has no remote command execution capability. Remote IT administration of company machines is
performed exclusively through the explicitly enrolled per-machine endpoint agent
(`agents/endpoint-agent`) using a closed allow-list of structured actions (`kill_process`,
`service_action`, `power_action`, `notify_user`, `refresh_inventory`) with role checks and full audit logging.
