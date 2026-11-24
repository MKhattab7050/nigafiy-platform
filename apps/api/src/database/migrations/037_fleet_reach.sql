-- Fleet Pro: reaching computers (docs/features/fleet-pro.md "Built: reaching computers and Quick Support").
--
--  * endpoints.nigafiy_id        a stable 9-digit Nigafiy ID per computer, unique in its organization,
--                                shown on the endpoint page and in the agent's tray ("connect by ID").
--  * endpoints.tags              address-book tags (lower-case, at most 20).
--  * endpoints.kind              'agent' (enrolled) or 'quick_support' (a nigafiy-support.exe run: a
--                                short-lived row that exists only while its code is valid; it never
--                                shows in the address book).
--  * endpoints.user_sessions     the Windows user sessions the agent reported (WTSEnumerateSessions):
--                                the operator picks which one the session helper attaches to.
--  * endpoints.boot_state        what the agent reported about its boot: safe mode, safe boot flag.
--  * fleet_favourites            per operator.
--  * fleet_help_requests         "Request help" from the agent's tray: a note; listed in Fleet and in
--                                Watch; the operator starts an attended session from it.
--  * fleet_restarts              restart and reconnect (normal or Safe Mode with Networking): the API
--                                resumes the session when the agent comes back and makes sure the
--                                safe-boot flag is cleared afterwards, also after a failure or timeout.
--  * fleet_quick_support         Quick Support rendezvous: 9-digit code + one-time PIN (hash only),
--                                expiry, wrong-PIN lockout. Attended only, at most the Support profile.

-- ── Nigafiy ID ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE endpoints
  ADD COLUMN nigafiy_id    text CHECK (nigafiy_id IS NULL OR nigafiy_id ~ '^[1-9][0-9]{8}$'),
  ADD COLUMN tags          text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  ADD COLUMN kind          text NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'quick_support')),
  ADD COLUMN user_sessions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN boot_state    jsonb NOT NULL DEFAULT '{}'::jsonb;

-- A random free ID in the organization (9 digits, no leading zero, so it reads the same everywhere).
CREATE FUNCTION fleet_new_nigafiy_id(org uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  candidate text;
BEGIN
  LOOP
    candidate := (100000000 + floor(random() * 900000000))::bigint::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM endpoints WHERE organization_id = org AND nigafiy_id = candidate);
  END LOOP;
  RETURN candidate;
END $$;

UPDATE endpoints SET nigafiy_id = fleet_new_nigafiy_id(organization_id) WHERE nigafiy_id IS NULL;

-- Filled on insert when the API did not set one (a column value, so pg_dump restores keep theirs).
CREATE FUNCTION fleet_assign_nigafiy_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nigafiy_id IS NULL THEN
    NEW.nigafiy_id := fleet_new_nigafiy_id(NEW.organization_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER endpoints_nigafiy_id BEFORE INSERT ON endpoints FOR EACH ROW EXECUTE FUNCTION fleet_assign_nigafiy_id();

ALTER TABLE endpoints ALTER COLUMN nigafiy_id SET NOT NULL;
CREATE UNIQUE INDEX endpoints_nigafiy_id_uniq ON endpoints (organization_id, nigafiy_id);
CREATE INDEX endpoints_tags_idx ON endpoints USING gin (tags);

-- ── Favourites (per operator) ───────────────────────────────────────────────────────────────────
CREATE TABLE fleet_favourites (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint_id),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE fleet_favourites ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_favourites FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, DELETE ON fleet_favourites TO lan_app;

-- ── Request help (agent tray) ───────────────────────────────────────────────────────────────────
CREATE TABLE fleet_help_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL,
  -- What the person typed (shown to operators; it is their own request, not captured input).
  note             text NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  -- The Windows / OS account that asked, as the agent reported it.
  requested_by     text CHECK (requested_by IS NULL OR length(requested_by) <= 120),
  state            text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_session', 'closed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  handled_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  handled_by_email text,
  handled_at       timestamptz,
  close_note       text CHECK (close_note IS NULL OR length(close_note) <= 300),
  fleet_session_id uuid REFERENCES fleet_sessions (id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_help_requests_org_idx ON fleet_help_requests (organization_id, state, created_at DESC);
ALTER TABLE fleet_help_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_help_requests FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_help_requests TO lan_app;

-- ── Restart and reconnect ───────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_restarts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id         uuid NOT NULL,
  -- The session that asked for the restart, and the one that resumed it.
  fleet_session_id    uuid REFERENCES fleet_sessions (id) ON DELETE SET NULL,
  resumed_session_id  uuid REFERENCES fleet_sessions (id) ON DELETE SET NULL,
  mode                text NOT NULL CHECK (mode IN ('normal', 'safe_mode')),
  -- queued → restarting (the agent acknowledged) → resumed | failed | timeout
  state               text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'restarting', 'resumed', 'failed', 'timeout', 'cancelled')),
  requested_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  requested_by_email  text NOT NULL,
  reason              text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  command_id          uuid,
  -- Safe mode: the agent set the safe-boot flag; cleared once it reports the flag gone.
  safe_boot_set       boolean NOT NULL DEFAULT false,
  safe_boot_cleared_at timestamptz,
  clear_command_id    uuid,
  agent_back_at       timestamptz,
  timeout_s           integer NOT NULL DEFAULT 600 CHECK (timeout_s BETWEEN 120 AND 3600),
  timeout_at          timestamptz NOT NULL,
  error               text CHECK (error IS NULL OR length(error) <= 300),
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_restarts_open_idx ON fleet_restarts (endpoint_id) WHERE state IN ('queued', 'restarting');
CREATE INDEX fleet_restarts_timeout_idx ON fleet_restarts (timeout_at) WHERE state IN ('queued', 'restarting');
ALTER TABLE fleet_restarts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_restarts FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_restarts TO lan_app;

-- ── Quick Support ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_quick_support (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id          uuid NOT NULL,
  endpoint_id      uuid NOT NULL,
  -- Read aloud by the person; unique among the codes that are still usable (any organization: the
  -- operator types it without saying which organization).
  code             text NOT NULL CHECK (code ~ '^[1-9][0-9]{8}$'),
  -- sha256(id || ':' || pin): the PIN itself is only ever on the person's screen.
  pin_hash         text NOT NULL,
  state            text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'connected', 'ended', 'expired', 'locked')),
  failed_attempts  integer NOT NULL DEFAULT 0,
  hostname         text,
  os               text,
  link_issued_by   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  connected_at     timestamptz,
  operator_email   text,
  fleet_session_id uuid REFERENCES fleet_sessions (id) ON DELETE SET NULL,
  ended_at         timestamptz,
  end_reason       text,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX fleet_quick_support_live_code ON fleet_quick_support (code) WHERE state IN ('waiting', 'connected');
CREATE INDEX fleet_quick_support_org_idx ON fleet_quick_support (organization_id, created_at DESC);
ALTER TABLE fleet_quick_support ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_quick_support FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_quick_support TO lan_app;

-- ── Sessions ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE fleet_sessions
  -- Which Windows session the helper attaches to (null: the console's; 'winlogon': nobody signed in).
  ADD COLUMN user_session      text CHECK (user_session IS NULL OR user_session ~ '^([0-9]{1,5}|winlogon)$'),
  ADD COLUMN help_request_id   uuid,
  ADD COLUMN restart_id        uuid,
  ADD COLUMN quick_support_id  uuid,
  ADD COLUMN resumed_from_id   uuid;
-- restart: the computer restarted for "restart and reconnect" (the resumed session is a new row);
-- quick_support_closed: the Quick Support program closed or its code was ended.
ALTER TABLE fleet_sessions DROP CONSTRAINT fleet_sessions_end_reason_check;
ALTER TABLE fleet_sessions ADD CONSTRAINT fleet_sessions_end_reason_check
  CHECK (end_reason IN ('operator', 'user', 'consent_denied', 'consent_timeout', 'consent_unavailable', 'replaced', 'revoked', 'expired',
                        'approval_denied', 'approval_expired', 'restart', 'quick_support_closed'));

-- ── Agent commands: restart for reconnect, clear safe boot ──────────────────────────────────────
ALTER TABLE endpoint_commands DROP CONSTRAINT endpoint_commands_kind_check;
ALTER TABLE endpoint_commands ADD CONSTRAINT endpoint_commands_kind_check CHECK (
  kind IN (
    'refresh_inventory', 'kill_process', 'service_action', 'power_action', 'notify_user',
    'fs_op', 'rd_capture', 'rd_input', 'software_action', 'fetch_logs', 'diagnostic_command',
    'rd_session_open', 'rd_session_close', 'rd_session_update',
    'fleet_restart', 'fleet_safe_boot_clear'
  )
);
