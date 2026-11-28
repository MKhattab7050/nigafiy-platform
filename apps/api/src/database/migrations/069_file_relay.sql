-- File transfers, speed round (docs/roadmap/2026-11-28-file-transfer-speed.md).
--
-- What an agent says it can do, from its command poll (["fs_relay"]: file bytes through the
-- binary side channel below instead of base64 inside the command).
ALTER TABLE endpoints ADD COLUMN agent_features text[] NOT NULL DEFAULT '{}';

-- The bytes of one transfer piece on their way between the browser and an agent. Unlogged: no WAL,
-- gone after a crash (the transfer simply asks for the piece again). A row lives seconds: it is
-- deleted when read (download) or when its command ends (upload); a sweep removes leftovers.
CREATE UNLOGGED TABLE file_relay (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL,
  -- 'up': browser → agent (an upload piece, referenced by the command's data_ref);
  -- 'down': agent → browser (a download piece, the result of command_id).
  direction       text NOT NULL CHECK (direction IN ('up', 'down')),
  command_id      uuid,
  created_by      uuid,
  data            bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_relay_command ON file_relay (command_id) WHERE command_id IS NOT NULL;
CREATE INDEX file_relay_age ON file_relay (created_at);

ALTER TABLE file_relay ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON file_relay FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, DELETE ON file_relay TO lan_app;
