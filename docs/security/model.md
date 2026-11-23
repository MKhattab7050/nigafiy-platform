# Security model

| Control | Implementation |
| --- | --- |
| Passwords | `scrypt` (N=2¹⁵, r=8), per-user salt, constant-time compare; login timing is uniform for unknown users; changing or resetting a password revokes other sessions |
| Multi-factor authentication (TOTP) | RFC 6238 TOTP secrets encrypted at rest with AES-256-GCM (`APP_ENCRYPTION_KEY`), replay protection (`mfa_last_step`), brute-force lockout (`mfa_locked_until`), single-use SHA-256 hashed recovery codes (`user_recovery_codes`), and organization policy (`mfa_required`: `off`, `admins`, `all`) |
| Team invitations & password reset | Single-purpose, single-use expiring tokens stored as SHA-256 hashes (`invitations`, `auth_tokens`); member deactivation (`memberships.status = 'deactivated'`) immediately blocks access; account emails are sent only over SMTP channels explicitly opted in via `use_for_account_emails` |
| Sessions | 256-bit opaque token in an `HttpOnly`, `SameSite=Lax` (`Secure` in production) cookie; only its SHA-256 is stored; active membership re-checked on every request |
| CSRF | Custom header (`X-LD-CSRF`) required on all state-changing requests + `Origin` check; no CORS allowances |
| Authorization | Role check middleware (`owner`, `admin`, `technician`, `viewer`) on the server for every mutating route; frontend hiding is cosmetic |
| Tenant isolation | PostgreSQL RLS + composite foreign keys + API scoping (see architecture overview §4) |
| Collector enrollment & auth | Single-use, expiring token (`lde_…`) → per-collector 256-bit credential (`ldc_<id>.<secret>`), SHA-256 hash stored, atomic consumption, immediate revocation, rate limited |
| Endpoint agent enrollment & auth | Separate per-machine enrollment token (`ldea_…`) → per-endpoint 256-bit credential (`lda_<id>.<secret>`), SHA-256 hash stored, immediate revocation; Go agent on `windows`, `linux` and `macos` only (no mobile/MDM enrollment path exists) |
| Endpoint remote actions & capability enforcement | Strictly typed closed allow-list (`refresh_inventory`, `kill_process`, `service_action`, `power_action`, `notify_user`, `fs_op`, `rd_capture`, `rd_input`, `software_action`, `fetch_logs`, `diagnostic_command`) checked against the endpoint's platform (`modules/endpoints/capabilities.ts`, `validateCommandForPlatform`); values passed to programs (service names, package ids, DNS targets) must start with a letter or digit so they cannot become options; RBAC enforced (`admin` for restart/shutdown, software changes, file delete and upload; `technician`+ for other file operations, remote desktop, process/service/session/diagnostics); every command recorded in `audit_logs` with typed text and file contents redacted |
| Remote File Manager safety | Canonical path resolution (`filepath.Clean` + symlink resolution), directory traversal rejection (`..`), null-byte rejection, hard-coded denylist of credential stores (`SAM`, `SECURITY`, `/etc/shadow`, `/etc/gshadow`, `/Library/Keychains`) and critical OS system directories (`C:\Windows\System32`, `/boot`, `/proc`, `/sys`, `/System`), optional per-endpoint policy `allowed_roots`, chunked SHA-256 verified transfers, and mandatory `confirm_destructive: true` for deletion |
| Remote Desktop transparency | Requires explicit active session initiation (`/remote-desktop/start`) before frames or input are accepted, records operator identity and reason in `audit_logs` and `network_events`, supports configurable user consent policy, and triggers an on-screen transparency notification when an administrator connects |
| Router control safety | Router credentials (`site_routers.secret_enc`) are write-only and encrypted with AES-256-GCM; explicit transport trust (`https`, `https-pinned` SHA-256 certificate fingerprint confirmed by admin, or explicit `http`); lockout protection (`login_paused_until`) halts login attempts after credential failure; `router_blocks` ledger records pre-existing router blocks and never lifts blocks not applied by Nigafiy |
| Input validation | Every payload validated with strict zod schemas; unknown fields rejected |
| Secrets at rest | Webhook signing secrets, SNMP credentials, SMTP passwords, router credentials, and TOTP MFA secrets encrypted with AES-256-GCM (`APP_ENCRYPTION_KEY`); never returned after creation |
| Logging | Structured; method/path/status only; credential-bearing fields redacted at the logger and desktop collector panel |
| Rate limiting | Per-IP and per-account limits on login/registration, MFA verification, password reset, enrollment, collector API and user API |
| Outbound webhooks & SMTP | Webhooks require `https://`, resolve and pin destination IP, refuse private/loopback/link-local addresses (unless `ALLOW_PRIVATE_WEBHOOKS=true` in dev), no redirects, 8 s timeout |
| Error handling | Unexpected errors return a generic message + request id; details stay in server logs |
| Audit | Append-only `audit_logs` (the app role has no `UPDATE`/`DELETE`), recording `actor` (`user`, `system`, `collector`) in the same transaction as the action |
| Monitoring safety | Scopes: private IPv4 only, ≤ /20, explicit attestation recorded with the administrator's identity; collector re-validates and has compiled-in ceilings |

| Encryption-key rotation | `pnpm --filter ./apps/api rotate-key` re-encrypts every sealed column (`apps/api/src/ops/sealed-columns.ts`) from the old to a new `APP_ENCRYPTION_KEY` in one transaction; refuses on a wrong old key, an unknown sealed-looking column or a connected API; keys only from files/env, never printed; audited with key ids (docs/operations/backup-restore-and-key-rotation.md) |
| Rate limits across instances | Optional `REDIS_URL`: counters shared through Redis; while Redis is unreachable each instance counts in its own memory (never fails open or closed). Unset: per-instance memory |
| Remote desktop frames | Screen images are never written to PostgreSQL: only frame metadata is kept on `endpoint_commands`; images pass through memory and `pg_notify` between API instances and are dropped when the session ends. Session start/stop stay audited |

## Not implemented yet

- External SSO (SAML / OIDC)
- Mutual TLS for collectors and endpoint agents (path described in the protocol document)
- A Content-Security-Policy header on the Next.js web app (the desktop panel page has a strict CSP)
- Independent security review / penetration test

## Deliberately absent

No exploitation, credential harvesting, stealth scanning or packet payload capture exists anywhere in
the codebase. The network collector (`collectors/lan-collector`) remains strictly an observer/prober
(plus explicit, audited router API calls when configured) and has no arbitrary command execution
capability. Remote IT administration of company machines is performed exclusively through the explicitly
enrolled per-machine endpoint agent (`agents/endpoint-agent`) using a closed allow-list of structured
actions with role checks and full audit logging.
