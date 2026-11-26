-- Buttons on notifications (UX review 2026-11-26, item 9: "New device joined" with Allow / Pause).
--
-- A notification sent to Telegram, push or email can carry buttons. Pressing one calls
-- POST /api/v1/notification-actions/:token without a session: the token is the authority. So a token
--  * is random (32 bytes) and stored only as its SHA-256 (token_hash);
--  * is bound to one organization, one device and one action (kind);
--  * works once (used_at) and expires 24 hours after it was issued (expires_at);
--  * remembers the channel it was sent to (channel_id), for the audit trail.
-- The action is audited as the organization owner's, with the channel and the caller's address.

CREATE TABLE notification_action_tokens (
  token_hash       text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  device_id        uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('allow_device', 'pause_device')),
  event_id         uuid,
  channel_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  used_ip          text,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX notification_action_tokens_expiry_idx ON notification_action_tokens (expires_at);
CREATE INDEX notification_action_tokens_device_idx ON notification_action_tokens (organization_id, device_id);

ALTER TABLE notification_action_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_action_tokens FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_action_tokens TO lan_app;
