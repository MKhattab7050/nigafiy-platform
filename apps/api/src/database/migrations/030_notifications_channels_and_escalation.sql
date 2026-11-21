-- Multi-channel notifications (Telegram, Slack, Discord, ntfy push) and unacknowledged-incident escalation policies.
--
-- Channel kinds in notification_channels:
--   webhook   url = https://... ; secret_encrypted = signing secret (plain string, as before)
--   email     url = mailto:...  ; config = { host, port, security, username, from } ; secret_encrypted = JSON { password? }
--   telegram  url = telegram://<chat_id> ; config = { chat_id, message_thread_id?, api_base? } ; secret_encrypted = JSON { bot_token }
--   slack     url = slack://<host>/***   ; config = { host } ; secret_encrypted = JSON { webhook_url }
--   discord   url = discord://<host>/*** ; config = { host } ; secret_encrypted = JSON { webhook_url }
--   ntfy      url = <server>/<topic>     ; config = { server_url, topic, username? } ; secret_encrypted = JSON { token?, password? }

ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_kind_check;
ALTER TABLE notification_channels
  ADD CONSTRAINT notification_channels_kind_check
  CHECK (kind IN ('webhook', 'email', 'telegram', 'slack', 'discord', 'ntfy'));

CREATE TABLE notification_escalations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id                 uuid,
  name                    text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  channel_id              uuid NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  min_severity            text NOT NULL DEFAULT 'critical' CHECK (min_severity IN ('info', 'warning', 'critical')),
  delay_minutes           integer NOT NULL CHECK (delay_minutes BETWEEN 1 AND 1440),
  repeat_interval_minutes integer CHECK (repeat_interval_minutes IS NULL OR repeat_interval_minutes BETWEEN 5 AND 1440),
  max_repeats             integer NOT NULL DEFAULT 1 CHECK (max_repeats BETWEEN 1 AND 10),
  enabled                 boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX notification_escalations_org_idx ON notification_escalations (organization_id, enabled);

CREATE TABLE incident_escalations (
  policy_id       uuid NOT NULL REFERENCES notification_escalations (id) ON DELETE CASCADE,
  incident_id     uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  sent_count      integer NOT NULL DEFAULT 1,
  last_sent_at    timestamptz NOT NULL,
  PRIMARY KEY (policy_id, incident_id),
  FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX incident_escalations_incident_idx ON incident_escalations (incident_id);

ALTER TABLE notification_escalations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_escalations FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_escalations TO lan_app;

ALTER TABLE incident_escalations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON incident_escalations FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON incident_escalations TO lan_app;
