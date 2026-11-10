-- LAN Detective — Phase 2: incidents, Network Doctor diagnoses, long-term roll-ups.

ALTER TABLE organizations
  ADD COLUMN rollup_retention_days integer NOT NULL DEFAULT 730 CHECK (rollup_retention_days BETWEEN 30 AND 3650);

-- New collector command: run every monitoring check immediately (used by "Run diagnostics now").
ALTER TABLE collector_commands DROP CONSTRAINT collector_commands_kind_check;
ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check CHECK (kind IN ('run_discovery', 'run_checks'));

-- ───────────────────────── incidents ─────────────────────────

-- Human-friendly, per-organization incident numbers (INC-1, INC-2, …).
CREATE TABLE incident_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  last_number     integer NOT NULL
);

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id          uuid,
  number           integer NOT NULL,
  -- network: the gateway / internet / DNS path of a site.  service: one service check.
  -- collector: a collector lost contact.                   device: a critical device went offline.
  kind             text NOT NULL CHECK (kind IN ('network', 'service', 'collector', 'device')),
  -- What ties events together. At most one unresolved incident per key (see unique index).
  correlation_key  text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title            text NOT NULL,
  check_id         uuid,
  device_id        uuid,
  collector_id     uuid,
  opened_at        timestamptz NOT NULL,
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  resolution_kind  text CHECK (resolution_kind IN ('auto', 'manual')),
  resolution_note  text,
  assigned_to      uuid REFERENCES users (id) ON DELETE SET NULL,
  assigned_to_name text,
  -- Latest Network Doctor result (rule id, evidence, confidence, steps). See modules/doctor.
  diagnosis        jsonb,
  diagnosed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, check_id) REFERENCES monitoring_checks (organization_id, id) ON DELETE SET NULL (check_id),
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id),
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE SET NULL (collector_id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, number)
);
CREATE UNIQUE INDEX incidents_one_active_per_key ON incidents (organization_id, correlation_key) WHERE status <> 'resolved';
CREATE INDEX incidents_org_time_idx ON incidents (organization_id, opened_at DESC);
CREATE INDEX incidents_site_domain_idx ON incidents (site_id, (diagnosis ->> 'fault_domain')) WHERE status = 'resolved';

CREATE TABLE incident_events (
  incident_id     uuid NOT NULL,
  event_id        uuid NOT NULL,
  organization_id uuid NOT NULL,
  PRIMARY KEY (incident_id, event_id),
  FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, event_id) REFERENCES network_events (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX incident_events_event_idx ON incident_events (event_id);

-- Comments by people and system entries (opened / acknowledged / assigned / resolved) in one stream.
CREATE TABLE incident_activity (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  incident_id     uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('comment', 'opened', 'acknowledged', 'assigned', 'resolved', 'diagnosis')),
  user_id         uuid,
  user_name       text,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX incident_activity_idx ON incident_activity (incident_id, created_at);

-- ───────────────────────── long-term metrics ─────────────────────────

-- Hourly aggregates of check_results. Raw samples are kept for metric_retention_days,
-- roll-ups for rollup_retention_days: this is what makes month/quarter views affordable.
CREATE TABLE check_results_hourly (
  check_id        uuid NOT NULL,
  bucket          timestamptz NOT NULL,
  organization_id uuid NOT NULL,
  samples         integer NOT NULL,
  ok_samples      integer NOT NULL,
  latency_avg     real,
  latency_max     real,
  loss_avg        real,
  jitter_avg      real,
  PRIMARY KEY (check_id, bucket),
  FOREIGN KEY (organization_id, check_id) REFERENCES monitoring_checks (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX check_results_hourly_bucket_brin ON check_results_hourly USING brin (bucket);

-- ───────────────────────── RLS + grants ─────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incident_counters', 'incidents', 'incident_events', 'incident_activity', 'check_results_hourly'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;
