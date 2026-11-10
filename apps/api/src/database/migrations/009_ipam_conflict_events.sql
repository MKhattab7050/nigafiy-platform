-- IP conflicts that are currently open, so that each one raises exactly one event when it appears
-- and one when it clears, instead of one per discovery sweep.
CREATE TABLE ipam_open_conflicts (
  site_id         uuid NOT NULL,
  ip              inet NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('duplicate_ip', 'reserved_in_use', 'assignment_mismatch', 'static_in_dhcp_pool')),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  opened_at       timestamptz NOT NULL,
  PRIMARY KEY (site_id, ip, kind),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

ALTER TABLE ipam_open_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ipam_open_conflicts FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON ipam_open_conflicts TO lan_app;
