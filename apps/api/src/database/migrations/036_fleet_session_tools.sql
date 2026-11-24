-- Fleet Pro: in-session tools, session recording, several operators, Wake-on-LAN then connect
-- (docs/features/fleet-pro.md "Built: in-session tools, recording, operators").
--
--  * fleet_groups               recording policy per group (off / optional / required), how long
--                               recordings are kept, and whether the person at the computer may watch
--                               past recordings of it (stored for the tray app; nothing hides a
--                               recording from them).
--  * fleet_recordings           one row per recorded session: the file lives in the server's data
--                               folder (<data>/recordings/<org>/<id>/), encrypted with AES-256-GCM
--                               under a per-recording key. That key is sealed with APP_ENCRYPTION_KEY
--                               (key_sealed, listed in ops/sealed-columns.ts, so rotate-key covers
--                               it). Rows are never deleted by the app: the retention job removes the
--                               file and marks the row deleted.
--  * fleet_session_participants every operator of a session: the one who holds it (owner / holder),
--                               invited colleagues (each passes the access policy for their own role,
--                               address and MFA before joining), hand-overs, per-operator permissions
--                               (never more than the session's).
--  * fleet_wake_requests        "computer offline → Wake-on-LAN through the site's Sensor → connect
--                               when the agent comes online", with a timeout and clear states.
--
-- Nothing here can hide the session banner, the recording mark, the privacy-screen text or the
-- audit: there is no column for that on purpose.

-- ── Group policy: recording ─────────────────────────────────────────────────────────────────────
ALTER TABLE fleet_groups
  -- off: never recorded; optional: the operator may record when the profile has "record";
  -- required: every session of the group is recorded from its first frame (and refused when the
  -- profile cannot record).
  ADD COLUMN recording_mode           text    NOT NULL DEFAULT 'optional' CHECK (recording_mode IN ('off', 'optional', 'required')),
  ADD COLUMN recording_retention_days integer NOT NULL DEFAULT 30 CHECK (recording_retention_days BETWEEN 1 AND 3650),
  ADD COLUMN user_may_view_recordings boolean NOT NULL DEFAULT false;

-- ── Sessions ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE fleet_sessions
  ADD COLUMN recording_mode    text NOT NULL DEFAULT 'off' CHECK (recording_mode IN ('off', 'optional', 'required')),
  ADD COLUMN recording_id      uuid,
  -- Tools used in the session (counts only; never what was typed, drawn, said or sent).
  ADD COLUMN chat_messages     integer NOT NULL DEFAULT 0,
  ADD COLUMN files_transferred integer NOT NULL DEFAULT 0,
  ADD COLUMN wake_request_id   uuid;

-- ── Recordings ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_recordings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id       uuid NOT NULL,
  fleet_session_id  uuid NOT NULL REFERENCES fleet_sessions (id) ON DELETE CASCADE,
  session_public_id text NOT NULL,
  -- AES-256-GCM key of this recording's file(s), sealed with APP_ENCRYPTION_KEY. Never returned.
  key_sealed        text NOT NULL,
  state             text NOT NULL DEFAULT 'recording' CHECK (state IN ('recording', 'complete', 'failed', 'deleted')),
  started_by_email  text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  frames            bigint NOT NULL DEFAULT 0,
  input_events      bigint NOT NULL DEFAULT 0,
  bytes             bigint NOT NULL DEFAULT 0,
  segments          integer NOT NULL DEFAULT 0,
  retention_days    integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  retention_until   timestamptz NOT NULL,
  error             text CHECK (error IS NULL OR length(error) <= 300),
  deleted_at        timestamptz,
  delete_reason     text CHECK (delete_reason IS NULL OR delete_reason IN ('retention', 'admin')),
  deleted_by_email  text,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_recordings_session_idx ON fleet_recordings (fleet_session_id);
CREATE INDEX fleet_recordings_org_time_idx ON fleet_recordings (organization_id, started_at DESC);
CREATE INDEX fleet_recordings_retention_idx ON fleet_recordings (retention_until) WHERE state <> 'deleted';

ALTER TABLE fleet_recordings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_recordings FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
-- No DELETE: a recording's row stays (who recorded, when, how long kept) after its file is gone.
GRANT SELECT, INSERT, UPDATE ON fleet_recordings TO lan_app;

-- ── Operators of a session ──────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_session_participants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  fleet_session_id uuid NOT NULL REFERENCES fleet_sessions (id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL,
  user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
  email            text NOT NULL,
  -- holder: the operator who holds the session (mouse, keyboard and the session's tools within the
  -- profile); colleague: invited; sees the screen and uses what their own permissions allow.
  role             text NOT NULL CHECK (role IN ('holder', 'colleague')),
  state            text NOT NULL CHECK (state IN ('invited', 'joined', 'left', 'declined', 'removed', 'expired')),
  -- Never more than the session's permissions (checked by the API).
  permissions      jsonb NOT NULL,
  invited_by_email text,
  invited_at       timestamptz NOT NULL DEFAULT now(),
  invite_expires_at timestamptz,
  joined_at        timestamptz,
  left_at          timestamptz,
  policy_trail     jsonb NOT NULL DEFAULT '[]'::jsonb,
  mfa_verified     boolean NOT NULL DEFAULT false,
  request_ip       inet,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX fleet_session_participants_user ON fleet_session_participants (fleet_session_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX fleet_session_participants_user_idx ON fleet_session_participants (organization_id, user_id, state);

ALTER TABLE fleet_session_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_session_participants FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_session_participants TO lan_app;

-- The operator of each session that is still open holds it.
INSERT INTO fleet_session_participants (organization_id, fleet_session_id, endpoint_id, user_id, email, role, state, permissions, joined_at)
SELECT f.organization_id, f.id, f.endpoint_id, f.operator_user_id, coalesce(f.operator_email, 'unknown'), 'holder', 'joined',
       coalesce(f.permissions, '{}'::jsonb), coalesce(f.accepted_at, f.started_at)
  FROM fleet_sessions f
 WHERE f.state <> 'ended';

-- ── Wake-on-LAN, then connect ───────────────────────────────────────────────────────────────────
CREATE TABLE fleet_wake_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id        uuid NOT NULL,
  device_id          uuid,
  requested_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  requested_by_email text NOT NULL,
  reason             text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  profile_id         uuid,
  -- waking: the magic packet was queued for the site's Sensor; online: the agent is back (the
  -- console then sends the normal session request, through the whole access policy);
  -- connected: that request was made; timed_out / cancelled / failed: over.
  state              text NOT NULL DEFAULT 'waking' CHECK (state IN ('waking', 'online', 'connected', 'timed_out', 'cancelled', 'failed')),
  collector_id       uuid,
  collector_name     text,
  wol_command_id     uuid,
  broadcast          inet,
  mac                macaddr,
  timeout_s          integer NOT NULL CHECK (timeout_s BETWEEN 60 AND 1800),
  timeout_at         timestamptz NOT NULL,
  online_at          timestamptz,
  decided_at         timestamptz,
  session_public_id  text,
  error              text CHECK (error IS NULL OR length(error) <= 300),
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_wake_requests_open_idx ON fleet_wake_requests (endpoint_id) WHERE state IN ('waking', 'online');

ALTER TABLE fleet_wake_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_wake_requests FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_wake_requests TO lan_app;

-- ── Agent command: rd_session_update (operators and the recording mark on the banner) ─────────
ALTER TABLE endpoint_commands DROP CONSTRAINT endpoint_commands_kind_check;
ALTER TABLE endpoint_commands ADD CONSTRAINT endpoint_commands_kind_check CHECK (
  kind IN (
    'refresh_inventory', 'kill_process', 'service_action', 'power_action', 'notify_user',
    'fs_op', 'rd_capture', 'rd_input', 'software_action', 'fetch_logs', 'diagnostic_command',
    'rd_session_open', 'rd_session_close', 'rd_session_update'
  )
);
