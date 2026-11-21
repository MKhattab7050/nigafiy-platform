# Database design

PostgreSQL. Migrations (`001`–`020`) are plain SQL in `apps/api/src/database/migrations`, applied in
order inside a transaction each, serialized with an advisory lock, and recorded in `schema_migrations`.

## Implemented schema (`001`–`020`)

| Group | Migration(s) | Tables & key objects |
| --- | --- | --- |
| Identity & auth (owner pool only, unreadable by `lan_app`) | `001`, `018` | `users` (incl. TOTP MFA & lockout columns), `sessions`, `user_recovery_codes`, `invitations`, `auth_tokens` |
| Tenancy | `001`, `018` | `organizations` (`kind`: standalone / msp / customer, `mfa_required`, retention settings), `memberships` (`role`, `status`: active / deactivated) |
| Sites & collectors | `001`, `004` | `sites`, `network_scopes`, `collectors`, `collector_commands`, `ingest_batches` |
| Devices & discovery | `001`, `003`, `004`, `020` | `devices` (identification evidence, classification, trust, mute, access rules), `device_tags`, `device_ip_history`, `availability_history`, `discovery_runs` |
| Monitoring & roll-ups | `001`, `002`, `004` | `monitoring_checks`, `check_results` (raw time series), `check_results_hourly` (long-term hourly roll-ups) |
| Incidents & Doctor | `002` | `incident_counters`, `incidents` (with `diagnosis` JSONB), `incident_events`, `incident_activity` |
| Access control (DNS filter) | `005` | `site_access`, `access_profiles`, `dns_stats` |
| Port Detective (SNMP switches) | `006`, `008` | `snmp_targets` (encrypted credentials), `switch_ports`, `switch_fdb`, `switch_port_samples` (traffic & error rate time series) |
| IPAM | `007`, `009` | `ipam_subnets`, `ipam_addresses`, `ipam_open_conflicts` |
| IT Toolbox | `011` | `toolbox_runs` (`ping`, `tcp`, `ports`, `dns`, `rdns`, `traceroute`) |
| Endpoint management & remote admin | `012`–`015` | `endpoints` (`windows`, `linux`, `macos`), `endpoint_samples` (CPU/RAM/disk time series), `endpoint_commands` |
| Smart defaults & automation | `016` | `automation_settings`, `audit_logs.actor` (`user`, `system`, `collector`) |
| Router control | `017` | `site_routers` (encrypted credentials, TOFU cert pin, lockout pause), `router_clients`, `router_requests`, `router_blocks` (ledger protecting pre-existing blocks) |
| Maintenance windows | `019` | `maintenance_windows`, `maintenance_runs`, `maintenance_occurrence()` and `maintenance_next_occurrence()` SQL functions, `network_events.in_maintenance` |
| Events, notifications & governance | `001`, `010`, `018` | `network_events`, `notification_channels` (`webhook` and `email`, `use_for_account_emails`), `notification_deliveries`, `audit_logs` (append-only for `lan_app`) |
| Global search | `020` | `pg_trgm` extension (when available) and GIN trigram / prefix indexes across `devices`, `endpoints`, `incidents`, and `device_tags` |

Conventions:

- Every tenant table has `organization_id`, RLS enabled, and a `tenant_isolation` policy (`organization_id = app_current_org()`).
- Children reference parents with `(organization_id, parent_id)` composite foreign keys.
- Addresses use native types: `inet`, `cidr`, `macaddr`.
- Idempotency keys: `ingest_batches (collector_id, batch_id)`, `discovery_runs (collector_id, run_id)`,
  `check_results (check_id, ts)`, `switch_port_samples (target_id, if_index, ts)`, `endpoint_samples (endpoint_id, ts)`.
- Secrets: session tokens, enrollment tokens (`lde_`, `ldea_`), collector/agent credentials (`ldc_`, `lda_`),
  invitation/reset/MFA tokens, and recovery codes are stored as SHA-256 hashes; passwords with `scrypt`;
  webhook signing secrets, SNMP credentials, SMTP passwords, router credentials, and TOTP MFA secrets are
  encrypted with AES-256-GCM (`APP_ENCRYPTION_KEY`).

## Time series

`check_results`, `switch_port_samples`, and `endpoint_samples` are narrow tables per measurement family,
indexed with BRIN on `ts`. Charts aggregate recent windows with `date_bin()` and long windows (up to
`rollup_retention_days`, default 730 days) from `check_results_hourly`. Raw retention (`metric_retention_days`,
`event_retention_days`) is per organization and enforced hourly by the background scheduler (`infrastructure/scheduler.ts`).

With TimescaleDB available:

```sql
SELECT create_hypertable('check_results', 'ts', migrate_data => true);
```
