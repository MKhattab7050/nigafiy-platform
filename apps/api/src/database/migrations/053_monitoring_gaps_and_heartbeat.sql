-- UX review item 2: "When the PC is off everything stops silently".
--
--  * monitor_alive: one installation-wide row, touched every 30 s by the running API
--    (collectors/monitor-gaps.ts). On start the API reads it: a long silence means Nigafiy itself
--    was not running, and that period is recorded below.
--  * monitoring_gaps: periods when nothing was watching. kind 'api' = the Nigafiy server was not
--    running (site_id NULL: every site of the organization); kind 'collector' = a Sensor's
--    heartbeats stopped and later resumed (its site only). Device history reads these so that
--    "the monitor was off" is never counted as "the device was down".
--  * monitor_heartbeat: optional outside heartbeat per organization. While monitoring runs the API
--    sends a plain GET to this push URL (healthchecks.io, Uptime Kuma push monitor) about once a
--    minute; when the pings stop, that outside service alerts the owner. The URL often carries a
--    secret token, so it is sealed; only its host is stored in clear.

CREATE TABLE monitor_alive (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_alive_at timestamptz NOT NULL
);

CREATE TABLE monitoring_gaps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid,
  collector_id    uuid REFERENCES collectors (id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('api', 'collector')),
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at > started_at),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX monitoring_gaps_org_time ON monitoring_gaps (organization_id, ended_at DESC);

ALTER TABLE monitoring_gaps ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON monitoring_gaps FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT ON monitoring_gaps TO lan_app;

CREATE TABLE monitor_heartbeat (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  url_sealed      text NOT NULL,
  url_host        text NOT NULL,
  last_ping_at    timestamptz,
  last_status     integer,
  last_error      text,
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE monitor_heartbeat ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON monitor_heartbeat FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_heartbeat TO lan_app;
