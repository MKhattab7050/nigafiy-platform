-- Optional AI assistant (Phase 6). OFF by default; an administrator turns it on per organization with
-- the organization's own Anthropic API key and an explicit disclosure confirmation.
--
--  * assistant_settings       one row per organization (absent = off). The API key is sealed with the
--                             application key (AES-256-GCM, common/crypto.ts) and never returned.
--  * assistant_usage          one row per assistant request (a chat turn, an "explain", a key test):
--                             drives the per-organization daily budget, the per-user rate limit and the
--                             token usage shown in the UI. No question or answer text is stored here.
--  * assistant_conversations  stored only while the organization's "keep transcripts" setting is on;
--  * assistant_messages       the text is sealed like the key. Each user only ever reads their own.

CREATE TABLE assistant_settings (
  organization_id          uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  enabled                  boolean NOT NULL DEFAULT false,
  api_key_sealed           text,
  api_key_updated_at       timestamptz,
  model                    text NOT NULL DEFAULT 'claude-opus-5-5'
                             CHECK (model IN ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5')),
  daily_request_budget     integer NOT NULL DEFAULT 200 CHECK (daily_request_budget BETWEEN 1 AND 10000),
  user_requests_per_hour   integer NOT NULL DEFAULT 30 CHECK (user_requests_per_hour BETWEEN 1 AND 600),
  keep_transcripts         boolean NOT NULL DEFAULT false,
  disclosure_version       text,
  disclosure_accepted_at   timestamptz,
  disclosure_accepted_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  disclosure_accepted_name text,
  last_test_at             timestamptz,
  last_test_ok             boolean,
  last_test_error          text,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Enabled only with a key and an accepted disclosure.
  CHECK (NOT enabled OR (api_key_sealed IS NOT NULL AND disclosure_accepted_at IS NOT NULL))
);

CREATE TABLE assistant_usage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  conversation_id uuid,
  kind            text NOT NULL CHECK (kind IN ('ask', 'explain_incident', 'explain_doctor', 'test')),
  model           text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'refused', 'error')),
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  api_calls       integer NOT NULL DEFAULT 0,
  tool_calls      integer NOT NULL DEFAULT 0,
  error_code      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX assistant_usage_org_time_idx ON assistant_usage (organization_id, created_at DESC);
CREATE INDEX assistant_usage_user_time_idx ON assistant_usage (organization_id, user_id, created_at DESC);

CREATE TABLE assistant_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title_sealed    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX assistant_conversations_user_idx ON assistant_conversations (organization_id, user_id, updated_at DESC);

CREATE TABLE assistant_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  -- Sealed JSON: { text, citations?, lookups? }.
  content_sealed  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, conversation_id) REFERENCES assistant_conversations (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX assistant_messages_conv_idx ON assistant_messages (conversation_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_settings', 'assistant_usage', 'assistant_conversations', 'assistant_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;
