# Database design

PostgreSQL. Migrations are plain SQL in `apps/api/src/database/migrations`, applied in order inside a
transaction each, serialized with an advisory lock, recorded in `schema_migrations`.

## Implemented in Phase 1 (`001_phase1_core.sql`)

| Group | Tables |
| --- | --- |
| Identity (not readable by the app role) | `users`, `sessions` |
| Tenancy | `organizations` (`kind`: standalone / msp / customer, `parent_organization_id`), `memberships` (role) |
| Infrastructure | `sites`, `network_scopes`, `collectors`, `collector_commands`, `ingest_batches` |
| Devices | `devices`, `device_tags`, `device_ip_history`, `availability_history`, `discovery_runs` |
| Monitoring | `monitoring_checks`, `check_results` (time series) |
| Events & notifications | `network_events`, `notification_channels`, `notification_deliveries` |
| Governance | `audit_logs` (append-only for the app role) |

Conventions:

- Every tenant table has `organization_id`, RLS enabled, and a `tenant_isolation` policy.
- Children reference parents with `(organization_id, parent_id)` composite foreign keys.
- Addresses use native types: `inet`, `cidr`, `macaddr`.
- Idempotency keys: `ingest_batches (collector_id, batch_id)`, `discovery_runs (collector_id, run_id)`,
  `check_results (check_id, ts)`.
- Secrets: session tokens, enrollment tokens and collector credentials are stored as SHA-256 hashes
  (they are 256-bit random values); passwords with scrypt; webhook signing secrets AES-256-GCM encrypted.

## Time series

`check_results` is one narrow table per measurement family (not a generic telemetry table), primary
key `(check_id, ts)`, BRIN index on `ts`. Charts aggregate with `date_bin()` into at most a few
hundred buckets. Retention is per organization (`metric_retention_days`, `event_retention_days`) and
enforced hourly.

With TimescaleDB available:

```sql
SELECT create_hypertable('check_results', 'ts', migrate_data => true);
```

plus continuous aggregates for hourly/daily roll-ups — planned together with Time Machine (Phase 2),
where long retention makes roll-ups necessary.

## Planned tables by phase (not created yet)

| Phase | Tables |
| --- | --- |
| 2 | `incidents`, `incident_events`, `incident_comments`, `incident_assignments`, `maintenance_windows`, `topology_nodes`, `topology_edges`, `topology_observations`, `check_results_hourly`, `ai_diagnostic_records` |
| 3 | `device_interfaces`, `device_identifiers`, `metric_definitions`, `metric_samples`, `interface_samples`, `ip_allocations`, `vlans`, `network_services`, `config_backups`, `config_versions`, `integrations` (encrypted credentials) |
| 4 | `security_events`, `device_risk_factors`, `security_policies`, `knowledge_articles`, `incident_resolutions`, `device_relationships` |
| 5 | `workflows`, `workflow_nodes`, `workflow_edges`, `workflow_executions`, `approval_requests`, `subscription_plans`, `subscriptions`, `usage_records`, `invoices`, `roles`, `permissions`, `alert_policies` |

`roles`/`permissions` as tables arrive with custom roles (Enterprise); Phase 1 uses four fixed roles.
