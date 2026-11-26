-- Installable web app with push notifications (UX review 2026-11-26, item 11).
--
-- Web Push (RFC 8030 / 8291 / 8292) needs no outside account: the browser's own push service
-- (Google, Mozilla, Apple, Microsoft) carries an encrypted message that only that browser can read.
--
--  * webpush_vapid: the installation's VAPID key pair (one row). The private key is sealed with
--    APP_ENCRYPTION_KEY; the public key is handed to browsers when they subscribe. Never reachable by
--    the application role: only the server process (system pool) reads it.
--  * notification_channels kind 'push': one "Phones (push)" channel per organization, created the first
--    time someone turns on push on a phone or browser. It has the usual severity and event-type
--    filters; a delivery goes to every subscription of that channel.
--  * webpush_subscriptions: one row per browser that said yes. The endpoint URL and the browser's
--    keys are sealed (the endpoint is a capability, the auth secret is a secret); endpoint_hash keeps a
--    browser from being stored twice, endpoint_host is what Settings shows. A subscription the push
--    service reports gone (404 / 410) is deleted.

CREATE TABLE webpush_vapid (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  public_key         text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  private_key_sealed text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_kind_check;
ALTER TABLE notification_channels
  ADD CONSTRAINT notification_channels_kind_check
  CHECK (kind IN ('webhook', 'email', 'telegram', 'slack', 'discord', 'ntfy', 'push'));

CREATE TABLE webpush_subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  channel_id          uuid NOT NULL,
  user_id             uuid REFERENCES users (id) ON DELETE CASCADE,
  endpoint_hash       text NOT NULL CHECK (endpoint_hash ~ '^[0-9a-f]{64}$'),
  endpoint_host       text NOT NULL CHECK (length(endpoint_host) BETWEEN 1 AND 255),
  subscription_sealed text NOT NULL,
  language            text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  label               text CHECK (label IS NULL OR length(label) <= 120),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_success_at     timestamptz,
  last_error          text,
  FOREIGN KEY (organization_id, channel_id) REFERENCES notification_channels (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, endpoint_hash)
);
CREATE INDEX webpush_subscriptions_channel_idx ON webpush_subscriptions (channel_id);

ALTER TABLE webpush_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webpush_subscriptions FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON webpush_subscriptions TO lan_app;
