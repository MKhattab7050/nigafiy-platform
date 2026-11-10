-- IT Toolbox: on-demand network measurements (ping, TCP port check, DNS lookup, reverse DNS,
-- traceroute) run from a site's collector. Closed list of tools with validated targets.

CREATE TABLE toolbox_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  collector_id    uuid NOT NULL,
  tool            text NOT NULL CHECK (tool IN ('ping', 'tcp', 'ports', 'dns', 'rdns', 'traceroute')),
  target          text NOT NULL CHECK (length(target) BETWEEN 1 AND 253),
  port            integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  output          jsonb,
  error           text,
  duration_ms     integer,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX toolbox_runs_site_created_idx ON toolbox_runs (organization_id, site_id, created_at DESC);

ALTER TABLE toolbox_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON toolbox_runs FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON toolbox_runs TO lan_app;

ALTER TABLE collector_commands DROP CONSTRAINT collector_commands_kind_check;
ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check
  CHECK (kind IN ('run_discovery', 'run_checks', 'wake_device', 'poll_snmp', 'run_tool'));
