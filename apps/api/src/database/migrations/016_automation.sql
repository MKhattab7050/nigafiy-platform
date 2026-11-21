-- Smart defaults / automation.
--
--  * audit_logs.actor: who performed an action. 'user' for everything a person did (all existing
--    rows), 'system' for automatic actions taken by LAN Detective itself (metadata.automation names
--    the automation key), 'collector' for actions a collector's report triggered.
--  * automation_settings: per-organization (site_id NULL) and per-site overrides of the automation
--    catalogue defaults that live in code (modules/automation/catalogue.ts).

ALTER TABLE audit_logs
  ADD COLUMN actor text NOT NULL DEFAULT 'user' CHECK (actor IN ('user', 'system', 'collector'));

-- "Last effect" of an automation and its rate limits read the system entries by key, newest first.
CREATE INDEX audit_logs_automation_idx ON audit_logs (organization_id, (metadata ->> 'automation'), created_at DESC)
  WHERE actor <> 'user';

CREATE TABLE automation_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- NULL = the organization default; a site row overrides it for that site.
  site_id         uuid,
  key             text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(key) <= 80),
  enabled         boolean NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}',
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX automation_settings_org_key ON automation_settings (organization_id, key) WHERE site_id IS NULL;
CREATE UNIQUE INDEX automation_settings_site_key ON automation_settings (organization_id, site_id, key) WHERE site_id IS NOT NULL;

ALTER TABLE automation_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_settings FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_settings TO lan_app;
