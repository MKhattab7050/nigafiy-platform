-- LAN Detective — Phase 1 core schema.
-- Conventions:
--   * every tenant-owned table carries organization_id and has Row Level Security enabled;
--   * child rows reference their parent with a composite (organization_id, parent_id) foreign key,
--     so a row can never point at another tenant's parent, even through a bug in application code;
--   * the application connects as the restricted role `lan_app` (created by the migrator).

CREATE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.current_org', true), '')::uuid $$;

-- ───────────────────────── identity (not readable by lan_app) ─────────────────────────

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  locale        text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE organizations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  -- 'msp' organizations own 'customer' organizations (parent_organization_id). Phase 1 creates 'standalone'.
  kind                   text NOT NULL DEFAULT 'standalone' CHECK (kind IN ('standalone', 'msp', 'customer')),
  parent_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  metric_retention_days  integer NOT NULL DEFAULT 30 CHECK (metric_retention_days BETWEEN 1 AND 3650),
  event_retention_days   integer NOT NULL DEFAULT 365 CHECK (event_retention_days BETWEEN 1 AND 3650),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'technician', 'viewer')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);
CREATE INDEX memberships_org_idx ON memberships (organization_id);

CREATE TABLE sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash             text NOT NULL UNIQUE,
  active_organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  ip                     inet,
  user_agent             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ───────────────────────── infrastructure ─────────────────────────

CREATE TABLE sites (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name                       text NOT NULL,
  timezone                   text NOT NULL DEFAULT 'UTC',
  discovery_interval_seconds integer NOT NULL DEFAULT 300 CHECK (discovery_interval_seconds BETWEEN 60 AND 86400),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);

-- A range the customer has explicitly declared they own / are authorized to monitor.
-- Collectors never probe anything outside enabled scopes of their own site.
CREATE TABLE network_scopes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  site_id               uuid NOT NULL,
  cidr                  cidr NOT NULL,
  label                 text,
  enabled               boolean NOT NULL DEFAULT true,
  authorized_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  authorized_by_name    text,
  authorized_at         timestamptz NOT NULL DEFAULT now(),
  last_run_finished_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  UNIQUE (site_id, cidr)
);

CREATE TABLE collectors (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  site_id                uuid NOT NULL,
  name                   text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  connection_state       text NOT NULL DEFAULT 'never' CHECK (connection_state IN ('never', 'online', 'offline')),
  enrollment_token_hash  text UNIQUE,
  enrollment_expires_at  timestamptz,
  credential_hash        text,
  hostname               text,
  version                text,
  os                     text,
  arch                   text,
  gateway_ip             inet,
  interfaces             jsonb NOT NULL DEFAULT '[]',
  spool_depth            integer,
  last_heartbeat_at      timestamptz,
  last_ip                inet,
  created_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  revoked_at             timestamptz,
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id)
);
CREATE INDEX collectors_site_idx ON collectors (site_id);
CREATE INDEX collectors_heartbeat_idx ON collectors (last_heartbeat_at) WHERE status = 'active';

CREATE TABLE collector_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  collector_id    uuid NOT NULL,
  -- Closed list. There is deliberately no "run arbitrary command" kind.
  kind            text NOT NULL CHECK (kind IN ('run_discovery')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'completed')),
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  completed_at    timestamptz,
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX collector_commands_pending_idx ON collector_commands (collector_id) WHERE status <> 'completed';

-- Idempotency ledger for telemetry batches (at-least-once delivery from collectors).
CREATE TABLE ingest_batches (
  collector_id    uuid NOT NULL,
  batch_id        uuid NOT NULL,
  organization_id uuid NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collector_id, batch_id),
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX ingest_batches_received_idx ON ingest_batches (received_at);

-- ───────────────────────── devices ─────────────────────────

CREATE TABLE devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  site_id           uuid NOT NULL,
  -- 'mac': identity follows the MAC address across IP changes.
  -- 'ip' : no MAC could be observed (e.g. routed subnet); identity is the IP address only.
  identity_basis    text NOT NULL CHECK (identity_basis IN ('mac', 'ip')),
  primary_mac       macaddr,
  mac_randomized    boolean NOT NULL DEFAULT false,
  current_ip        inet,
  hostname          text,
  display_name      text,
  vendor            text,
  device_type       text NOT NULL DEFAULT 'unknown',
  type_source       text NOT NULL DEFAULT 'none' CHECK (type_source IN ('none', 'inferred', 'manual')),
  type_evidence     text,
  status            text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline', 'unknown')),
  missed_sweeps     integer NOT NULL DEFAULT 0,
  is_critical       boolean NOT NULL DEFAULT false,
  owner             text,
  notes             text,
  discovery_sources text[] NOT NULL DEFAULT '{}',
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id),
  CHECK ((identity_basis = 'mac') = (primary_mac IS NOT NULL))
);
CREATE UNIQUE INDEX devices_site_mac_key ON devices (site_id, primary_mac) WHERE primary_mac IS NOT NULL;
CREATE UNIQUE INDEX devices_site_ip_only_key ON devices (site_id, current_ip) WHERE primary_mac IS NULL;
CREATE INDEX devices_site_ip_idx ON devices (site_id, current_ip);
CREATE INDEX devices_org_status_idx ON devices (organization_id, status);

CREATE TABLE device_tags (
  device_id       uuid NOT NULL,
  organization_id uuid NOT NULL,
  tag             text NOT NULL CHECK (length(tag) BETWEEN 1 AND 40),
  PRIMARY KEY (device_id, tag),
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE device_ip_history (
  device_id       uuid NOT NULL,
  organization_id uuid NOT NULL,
  ip              inet NOT NULL,
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  PRIMARY KEY (device_id, ip),
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE availability_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  device_id       uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('online', 'offline', 'unknown')),
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX availability_device_idx ON availability_history (device_id, started_at DESC);
CREATE UNIQUE INDEX availability_open_key ON availability_history (device_id) WHERE ended_at IS NULL;

CREATE TABLE discovery_runs (
  collector_id    uuid NOT NULL,
  run_id          uuid NOT NULL,
  organization_id uuid NOT NULL,
  site_id         uuid NOT NULL,
  scope_id        uuid REFERENCES network_scopes (id) ON DELETE SET NULL,
  cidr            cidr NOT NULL,
  trigger         text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  hosts_probed    integer NOT NULL,
  hosts_responded integer NOT NULL,
  hosts_rejected  integer NOT NULL DEFAULT 0,
  -- false when the run arrived late (buffered) and was older than data already applied:
  -- it is kept for history but did not change live device status.
  applied         boolean NOT NULL,
  PRIMARY KEY (collector_id, run_id),
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX discovery_runs_site_idx ON discovery_runs (site_id, finished_at DESC);

-- ───────────────────────── monitoring ─────────────────────────

CREATE TABLE monitoring_checks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  site_id              uuid NOT NULL,
  name                 text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('icmp', 'tcp', 'dns')),
  role                 text NOT NULL DEFAULT 'service' CHECK (role IN ('gateway', 'internet', 'dns', 'service')),
  target               text NOT NULL,
  port                 integer CHECK (port BETWEEN 1 AND 65535),
  interval_seconds     integer NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 15 AND 3600),
  failure_threshold    integer NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 1 AND 20),
  latency_warn_ms      real,
  loss_warn_pct        real,
  enabled              boolean NOT NULL DEFAULT true,
  state                text NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'ok', 'degraded', 'down')),
  state_changed_at     timestamptz,
  pending_state        text,
  pending_count        integer NOT NULL DEFAULT 0,
  last_result_at       timestamptz,
  last_latency_ms      real,
  last_loss_pct        real,
  last_error           text,
  last_resolved_target text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id),
  CHECK ((kind = 'tcp') = (port IS NOT NULL))
);
CREATE INDEX monitoring_checks_site_idx ON monitoring_checks (site_id);

-- Raw time series. Narrow rows, one table per measurement family (not one giant telemetry table).
-- On TimescaleDB this table becomes a hypertable (see docs/architecture/database.md).
CREATE TABLE check_results (
  check_id        uuid NOT NULL,
  ts              timestamptz NOT NULL,
  organization_id uuid NOT NULL,
  ok              boolean NOT NULL,
  latency_ms      real,
  loss_pct        real,
  jitter_ms       real,
  error           text,
  PRIMARY KEY (check_id, ts),
  FOREIGN KEY (organization_id, check_id) REFERENCES monitoring_checks (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX check_results_ts_brin ON check_results USING brin (ts);

-- ───────────────────────── events & notifications ─────────────────────────

CREATE TABLE network_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid,
  device_id       uuid,
  check_id        uuid,
  collector_id    uuid,
  type            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title           text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  source          text NOT NULL CHECK (source IN ('collector', 'platform')),
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, check_id) REFERENCES monitoring_checks (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id)
);
CREATE INDEX network_events_org_time_idx ON network_events (organization_id, occurred_at DESC, id);
CREATE INDEX network_events_device_idx ON network_events (device_id, occurred_at DESC) WHERE device_id IS NOT NULL;

CREATE TABLE notification_channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('webhook')),
  name             text NOT NULL,
  url              text NOT NULL,
  secret_encrypted text NOT NULL,
  min_severity     text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info', 'warning', 'critical')),
  event_types      text[],
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  channel_id      uuid NOT NULL,
  event_id        uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  FOREIGN KEY (organization_id, channel_id) REFERENCES notification_channels (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, event_id) REFERENCES network_events (organization_id, id) ON DELETE CASCADE,
  UNIQUE (channel_id, event_id)
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid,
  user_email      text,
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  ip              inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (organization_id, created_at DESC);

-- ───────────────────────── tenant isolation: RLS + grants ─────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sites', 'network_scopes', 'collectors', 'collector_commands', 'ingest_batches',
    'devices', 'device_tags', 'device_ip_history', 'availability_history', 'discovery_runs',
    'monitoring_checks', 'check_results', 'network_events',
    'notification_channels', 'notification_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;

-- Audit log is append-only for the application role.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT ON audit_logs TO lan_app;

-- The app role may read (not create or delete) only its own organization and its member list.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations FOR SELECT TO lan_app USING (id = app_current_org());
GRANT SELECT ON organizations TO lan_app;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships FOR SELECT TO lan_app USING (organization_id = app_current_org());
GRANT SELECT ON memberships TO lan_app;

-- users and sessions: no grants at all for lan_app.
GRANT EXECUTE ON FUNCTION app_current_org() TO lan_app;
