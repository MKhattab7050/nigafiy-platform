-- UX review 2026-11-26 item 12: calm alerts by default.
--
--  * notification_settings: one row per organization. Organizations WITHOUT a row keep the old
--    behaviour (every matching event sent at once, no quiet hours, no weekly summary), so existing
--    users' settings never change silently. A trigger gives NEW organizations the calm defaults:
--    info → weekly summary, warning → immediate but repeats of the same device + type within
--    30 minutes collapse, critical → always immediate.
--  * Quiet hours (wall-clock time in `timezone`, else the organization's first site's time zone):
--    only critical goes out; everything else is held and sent as one summary per channel when quiet
--    hours end.
--  * notification_mutes: mute a device, an event type, or one type for one device, for a while
--    (until) or for good (until NULL).
--  * notification_holds: every delivery the policy did not send at once, with the reason, so
--    summaries can list them and nothing disappears without a trace. 'quiet' and 'weekly' rows are
--    released into a summary; 'muted' and 'duplicate' rows are a record only (counted in the weekly
--    summary). Held items keep only their 'open' action links: single-use action tokens would be stale.
--  * notification_deliveries.policy_at: when the calm policy looked at the delivery (NULL = not yet;
--    the dispatcher sends only deliveries the policy has passed). .actions: optional buttons
--    (packages/shared-types/src/notification-actions.ts) passed unchanged to the channel renderers.

CREATE TABLE notification_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  info_mode       text NOT NULL DEFAULT 'immediate' CHECK (info_mode IN ('immediate', 'weekly')),
  warning_mode    text NOT NULL DEFAULT 'immediate' CHECK (warning_mode IN ('immediate', 'weekly')),
  dedup_minutes   integer NOT NULL DEFAULT 0 CHECK (dedup_minutes BETWEEN 0 AND 1440),
  quiet_enabled   boolean NOT NULL DEFAULT false,
  quiet_start     time NOT NULL DEFAULT '22:00',
  quiet_end       time NOT NULL DEFAULT '07:00',
  timezone        text CHECK (timezone IS NULL OR length(timezone) BETWEEN 1 AND 64),
  weekly_summary  boolean NOT NULL DEFAULT false,
  -- 0 = Sunday … 6 = Saturday, local hour 0–23.
  weekly_day      smallint NOT NULL DEFAULT 0 CHECK (weekly_day BETWEEN 0 AND 6),
  weekly_hour     smallint NOT NULL DEFAULT 9 CHECK (weekly_hour BETWEEN 0 AND 23),
  last_weekly_at  timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_settings FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON notification_settings TO lan_app;

-- Calm defaults for organizations created from now on (existing ones get no row: unchanged).
CREATE FUNCTION notification_settings_calm_defaults() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO notification_settings (organization_id, info_mode, warning_mode, dedup_minutes, weekly_summary)
  VALUES (NEW.id, 'weekly', 'immediate', 30, true)
  ON CONFLICT (organization_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_calm_notification_defaults AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION notification_settings_calm_defaults();

CREATE TABLE notification_mutes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  device_id       uuid,
  event_type      text CHECK (event_type IS NULL OR event_type ~ '^[a-z0-9_]{1,60}$'),
  until           timestamptz,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (device_id IS NOT NULL OR event_type IS NOT NULL),
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX notification_mutes_org_idx ON notification_mutes (organization_id);

ALTER TABLE notification_mutes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_mutes FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_mutes TO lan_app;

CREATE TABLE notification_holds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  channel_id      uuid NOT NULL,
  event_id        uuid NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('quiet', 'weekly', 'muted', 'duplicate')),
  actions         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  FOREIGN KEY (organization_id, channel_id) REFERENCES notification_channels (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, event_id) REFERENCES network_events (organization_id, id) ON DELETE CASCADE,
  UNIQUE (channel_id, event_id)
);
CREATE INDEX notification_holds_open_idx ON notification_holds (organization_id, reason) WHERE released_at IS NULL;
CREATE INDEX notification_holds_time_idx ON notification_holds (organization_id, created_at DESC);

ALTER TABLE notification_holds ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_holds FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT ON notification_holds TO lan_app;

ALTER TABLE notification_deliveries ADD COLUMN policy_at timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN actions jsonb;
-- Deliveries queued before this migration were decided under the old rules.
UPDATE notification_deliveries SET policy_at = created_at;
CREATE INDEX notification_deliveries_policy_idx ON notification_deliveries (created_at) WHERE policy_at IS NULL;
