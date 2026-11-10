-- Email as a second notification channel.
--
-- For kind = 'email':
--   url              "mailto:" followed by the comma-separated recipients (shown in the UI)
--   config           non-secret SMTP settings: { host, port, security, username, from }
--   secret_encrypted AES-256-GCM JSON: { password } (an empty object when the relay needs no login)
ALTER TABLE notification_channels ADD COLUMN config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE notification_channels DROP CONSTRAINT notification_channels_kind_check;
ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_kind_check CHECK (kind IN ('webhook', 'email'));
