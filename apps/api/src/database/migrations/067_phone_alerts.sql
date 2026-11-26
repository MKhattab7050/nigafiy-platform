-- Network alerts on admin phones (docs/roadmap/2026-11-26-admin-phones.md).
--
--  * notification_channels kind 'phone': one "Admin phones" channel per organization, made when the
--    first admin phone appears. Important problems only (warning and up), plus the "resolved" event
--    types, which notifications/phone.ts passes on only for a problem the phones were told about.
--    Quiet hours and the other calm-alerts rules apply as for every channel.
--  * phone_alerts: what each admin phone still has to show. The phone collects them with its
--    heartbeat (every 20 s) and they are marked delivered. Read and written by the server process only.

ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_kind_check;
ALTER TABLE notification_channels
  ADD CONSTRAINT notification_channels_kind_check
  CHECK (kind IN ('webhook', 'email', 'telegram', 'slack', 'discord', 'ntfy', 'push', 'phone'));

CREATE TABLE phone_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  event_id        uuid NOT NULL,
  title           text NOT NULL CHECK (length(title) <= 200),
  body            text NOT NULL CHECK (length(body) <= 800),
  path            text NOT NULL CHECK (path LIKE '/%' AND length(path) <= 300),
  tag             text NOT NULL CHECK (length(tag) <= 120),
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  resolved        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX phone_alerts_pending_idx ON phone_alerts (endpoint_id, created_at) WHERE delivered_at IS NULL;
