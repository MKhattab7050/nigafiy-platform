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
| Input validation | Every payload validated with strict zod schemas; unknown fields rejected |
| Secrets at rest | Webhook signing secrets AES-256-GCM with `APP_ENCRYPTION_KEY`; never returned after creation |
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

No exploitation, credential harvesting, stealth scanning, packet payload capture or remote command
execution exists anywhere in the codebase, and the collector protocol has no field that could carry one.
