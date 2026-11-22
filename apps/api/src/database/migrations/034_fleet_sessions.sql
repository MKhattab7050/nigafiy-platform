-- Fleet Pro: remote support session history.
--
-- Until now a remote desktop session lived only in endpoints.rd_session (jsonb, the current one) and
-- in pairs of audit rows. fleet_sessions keeps every session: who, why, consent asked and answered,
-- whether the on-screen banner was shown, which transport carried the picture (live WebSocket or
-- the HTTP fallback), measured relay totals, and how and by whom it ended. endpoints.rd_session
-- stays the "current session" cache the existing API reads; it now also carries the session's state
-- and its fleet_sessions id. Frames are never stored here (only counts and bytes relayed).
--
-- Two server-issued command kinds join the allow-list (never accepted from operators):
--   rd_session_open   the agent asks for consent when required, shows the banner, opens the stream
--   rd_session_close  the agent removes the banner and closes the stream

CREATE TABLE fleet_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id           uuid NOT NULL,
  public_id             text NOT NULL,
  operator_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  operator_email        text,
  reason                text,
  state                 text NOT NULL CHECK (state IN ('waiting_consent', 'active', 'ended')),
  consent_mode          text NOT NULL CHECK (consent_mode IN ('unattended', 'prompt')),
  consent_result        text NOT NULL DEFAULT 'pending'
                        CHECK (consent_result IN ('pending', 'not_required', 'accepted', 'denied', 'timeout', 'unavailable')),
  consent_error         text,
  consent_decided_at    timestamptz,
  banner_state          text NOT NULL DEFAULT 'pending' CHECK (banner_state IN ('pending', 'shown', 'unavailable', 'not_supported')),
  banner_error          text,
  transport             text NOT NULL DEFAULT 'http' CHECK (transport IN ('http', 'ws')),
  stream_connected_at   timestamptz,
  desktop_mode          text,
  display_index         integer NOT NULL DEFAULT 0,
  quality               integer,
  scale                 double precision,
  frames_relayed        bigint NOT NULL DEFAULT 0,
  bytes_relayed         bigint NOT NULL DEFAULT 0,
  clipboard_to_remote   integer NOT NULL DEFAULT 0,
  clipboard_from_remote integer NOT NULL DEFAULT 0,
  started_at            timestamptz NOT NULL DEFAULT now(),
  accepted_at           timestamptz,
  ended_at              timestamptz,
  end_reason            text CHECK (end_reason IN ('operator', 'user', 'consent_denied', 'consent_timeout', 'consent_unavailable', 'replaced', 'revoked', 'expired')),
  ended_by_email        text,
  source                text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'audit_backfill')),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, public_id)
);
CREATE INDEX fleet_sessions_endpoint_idx ON fleet_sessions (endpoint_id, started_at DESC);
CREATE INDEX fleet_sessions_org_time_idx ON fleet_sessions (organization_id, started_at DESC);
-- At most one open session per endpoint.
CREATE UNIQUE INDEX fleet_sessions_one_open ON fleet_sessions (endpoint_id) WHERE state <> 'ended';

ALTER TABLE fleet_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_sessions FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
-- History is kept: the application may add and update sessions, never delete them.
GRANT SELECT, INSERT, UPDATE ON fleet_sessions TO lan_app;

-- Earlier sessions, from the audit trail: each "started" row paired with the first "stopped" row of
-- the same endpoint after it. A session with no stop row is the current one when the endpoint still
-- points at it, otherwise its end is unknown (expired, no end time).
WITH started AS (
  SELECT a.organization_id, a.target_id::uuid AS endpoint_id, a.user_id, a.user_email, a.created_at, a.metadata
    FROM audit_logs a
   WHERE a.action = 'endpoint.remote_desktop_started' AND a.target_type = 'endpoint'
     AND a.target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND coalesce(a.metadata->>'id', '') <> ''
), paired AS (
  SELECT s.*, e.rd_session->>'id' AS current_id,
         (SELECT row(b.created_at, b.user_email)::text FROM audit_logs b
           WHERE b.organization_id = s.organization_id AND b.action = 'endpoint.remote_desktop_stopped'
             AND b.target_id = s.endpoint_id::text AND b.created_at >= s.created_at
           ORDER BY b.created_at LIMIT 1) AS stop_row,
         (SELECT b.created_at FROM audit_logs b
           WHERE b.organization_id = s.organization_id AND b.action = 'endpoint.remote_desktop_stopped'
             AND b.target_id = s.endpoint_id::text AND b.created_at >= s.created_at
           ORDER BY b.created_at LIMIT 1) AS stopped_at,
         (SELECT b.user_email FROM audit_logs b
           WHERE b.organization_id = s.organization_id AND b.action = 'endpoint.remote_desktop_stopped'
             AND b.target_id = s.endpoint_id::text AND b.created_at >= s.created_at
           ORDER BY b.created_at LIMIT 1) AS stopped_by
    FROM started s
    JOIN endpoints e ON e.organization_id = s.organization_id AND e.id = s.endpoint_id
)
INSERT INTO fleet_sessions (organization_id, endpoint_id, public_id, operator_user_id, operator_email, state, consent_mode,
                            consent_result, banner_state, transport, display_index, quality, scale, started_at,
                            accepted_at, ended_at, end_reason, ended_by_email, source)
SELECT p.organization_id, p.endpoint_id, p.metadata->>'id', p.user_id,
       coalesce(p.metadata->>'operator_email', p.user_email),
       CASE WHEN p.stopped_at IS NULL AND p.current_id = p.metadata->>'id' THEN 'active' ELSE 'ended' END,
       CASE WHEN p.metadata->>'consent_mode' = 'prompt' THEN 'prompt' ELSE 'unattended' END,
       'not_required', 'not_supported', 'http',
       coalesce((p.metadata->>'display_index')::int, 0), (p.metadata->>'quality')::int, (p.metadata->>'scale')::float8,
       p.created_at, p.created_at,
       p.stopped_at,
       CASE WHEN p.stopped_at IS NOT NULL THEN 'operator'
            WHEN p.current_id = p.metadata->>'id' THEN NULL
            ELSE 'expired' END,
       p.stopped_by, 'audit_backfill'
  FROM paired p
ON CONFLICT DO NOTHING;

-- The current session cache points at its history row.
UPDATE endpoints e
   SET rd_session = e.rd_session || jsonb_build_object('fleet_session_id', f.id::text, 'state', 'active')
  FROM fleet_sessions f
 WHERE e.rd_session IS NOT NULL AND f.endpoint_id = e.id AND f.public_id = e.rd_session->>'id' AND f.state = 'active';

ALTER TABLE endpoint_commands DROP CONSTRAINT endpoint_commands_kind_check;
ALTER TABLE endpoint_commands ADD CONSTRAINT endpoint_commands_kind_check CHECK (
  kind IN (
    'refresh_inventory', 'kill_process', 'service_action', 'power_action', 'notify_user',
    'fs_op', 'rd_capture', 'rd_input', 'software_action', 'fetch_logs', 'diagnostic_command',
    'rd_session_open', 'rd_session_close'
  )
);
