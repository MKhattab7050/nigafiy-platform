-- Telegram by QR (UX review 2026-11-26, item 10): no chat ID to look up any more.
--
-- The owner still makes a bot with @BotFather (there is no central Nigafiy server to host a shared
-- bot), but then scans a QR code: https://t.me/<bot>?start=<one-time code>. The API reads the
-- bot's updates (getUpdates), and a "/start <code>" binds that chat to the channel.
--
--  * telegram_link_codes: one-time codes behind the QR. Only the SHA-256 of a code is stored; a code
--    works once (used_at) and for 15 minutes (expires_at). chat_row_id says which chat it bound.
--  * telegram_chats: the chats bound to a channel (the owner, family members, a group). Messages go
--    to every bound chat; button presses (callback queries) are accepted only from these chats.
--    language: the reply and button language of that chat.
--  * telegram_poll_state: where the update stream of a channel's bot was read up to, and the last
--    polling error to show in Settings.
-- Legacy channels made with a typed chat ID keep config.chat_id; it counts as one more bound chat.

CREATE TABLE telegram_chats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  chat_id         bigint NOT NULL,
  chat_type       text NOT NULL CHECK (chat_type IN ('private', 'group', 'supergroup', 'channel')),
  title           text NOT NULL CHECK (length(title) <= 80),
  language        text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, chat_id),
  FOREIGN KEY (organization_id, channel_id) REFERENCES notification_channels (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX telegram_chats_org_idx ON telegram_chats (organization_id, channel_id);

CREATE TABLE telegram_link_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  code_hash       text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  language        text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  chat_row_id     uuid REFERENCES telegram_chats (id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id, channel_id) REFERENCES notification_channels (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX telegram_link_codes_channel_idx ON telegram_link_codes (channel_id, expires_at);

CREATE TABLE telegram_poll_state (
  channel_id      uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  next_offset     bigint NOT NULL DEFAULT 0,
  last_poll_at    timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, channel_id) REFERENCES notification_channels (organization_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telegram_chats', 'telegram_link_codes', 'telegram_poll_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;
