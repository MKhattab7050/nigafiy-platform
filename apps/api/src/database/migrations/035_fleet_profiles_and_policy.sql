-- Fleet Pro: permission profiles, fleet groups and the access policy of each group
-- (docs/features/fleet-pro.md §4 "Control and trust", "Built: permission profiles and access policy").
--
--  * fleet_permission_profiles  what an operator may do inside a session. Three built-ins per
--                               organization (View only, Support, Full admin), read-only for the app
--                               role (RLS refuses UPDATE/DELETE of a built-in row), plus custom ones.
--  * fleet_groups               groups of computers (the address book reuses them) and, per group,
--                               the access policy: attended / unattended, the user's refuse window,
--                               allowed hours (weekly windows in the endpoint's site time zone),
--                               allowed operator roles, default and maximum profile, MFA to connect,
--                               second-admin approval for unattended sessions, operator IP allow-list.
--  * endpoints.fleet_group_id   nullable. An endpoint with no group uses the organization default,
--                               derived from endpoints.policy.remote_desktop_consent (code:
--                               modules/endpoints/fleet-policy/policy.ts), so the existing API keeps
--                               working unchanged.
--  * fleet_sessions             now records the profile and the permissions granted (a snapshot that
--                               never changes with the profile), the group, the policy decision trail,
--                               the approval (who, when, result) and the new states.
--
-- Nothing here can turn off the session banner, the audit or the End button: no column exists for
-- that on purpose.

-- ── Permission profiles ─────────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_permission_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- Set on the three built-ins only.
  builtin_key      text CHECK (builtin_key IN ('view_only', 'support', 'full_admin')),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  description      text CHECK (description IS NULL OR length(description) <= 300),
  view             boolean NOT NULL DEFAULT true,
  control          boolean NOT NULL DEFAULT false,
  clipboard_in     boolean NOT NULL DEFAULT false, -- operator → remote computer
  clipboard_out    boolean NOT NULL DEFAULT false, -- remote computer → operator
  files            boolean NOT NULL DEFAULT false,
  audio            boolean NOT NULL DEFAULT false,
  record           boolean NOT NULL DEFAULT false,
  restart          boolean NOT NULL DEFAULT false,
  privacy_screen   boolean NOT NULL DEFAULT false,
  block_input      boolean NOT NULL DEFAULT false,
  shell            boolean NOT NULL DEFAULT false,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, builtin_key)
);
CREATE UNIQUE INDEX fleet_permission_profiles_name ON fleet_permission_profiles (organization_id, lower(name));

ALTER TABLE fleet_permission_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON fleet_permission_profiles FOR SELECT TO lan_app USING (organization_id = app_current_org());
CREATE POLICY tenant_insert ON fleet_permission_profiles FOR INSERT TO lan_app WITH CHECK (organization_id = app_current_org());
-- Built-ins are read-only for the application, whatever the API does.
CREATE POLICY tenant_update ON fleet_permission_profiles FOR UPDATE TO lan_app
  USING (organization_id = app_current_org() AND builtin_key IS NULL)
  WITH CHECK (organization_id = app_current_org() AND builtin_key IS NULL);
CREATE POLICY tenant_delete ON fleet_permission_profiles FOR DELETE TO lan_app
  USING (organization_id = app_current_org() AND builtin_key IS NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_permission_profiles TO lan_app;

-- The built-ins (the approved mockup docs/design/mockups/FleetPolicy.dc.html). Idempotent: the API
-- calls it for an organization that has none yet (organizations created after this migration).
CREATE FUNCTION fleet_seed_builtin_profiles(org uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO fleet_permission_profiles (organization_id, builtin_key, name, description, view, control, clipboard_in, clipboard_out,
                                         files, audio, record, restart, privacy_screen, block_input, shell)
  VALUES
    (org, 'view_only', 'View only', 'See the screen. No mouse, keyboard, clipboard or files.',
     true, false, false, false, false, false, true, false, false, false, false),
    (org, 'support', 'Support', 'See and control the screen, clipboard both ways, file transfer, restart and reconnect.',
     true, true, true, true, true, false, true, true, false, false, false),
    (org, 'full_admin', 'Full admin', 'Everything, including audio, privacy screen, blocking the user''s input and the remote shell.',
     true, true, true, true, true, true, true, true, true, true, true)
  ON CONFLICT (organization_id, builtin_key) DO NOTHING;
$$;
GRANT EXECUTE ON FUNCTION fleet_seed_builtin_profiles(uuid) TO lan_app;

SELECT fleet_seed_builtin_profiles(id) FROM organizations;

-- ── Fleet groups and their access policy ────────────────────────────────────────────────────────
CREATE TABLE fleet_groups (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description          text CHECK (description IS NULL OR length(description) <= 300),
  color                text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  -- attended: the user must accept within consent_timeout_s (no answer = declined).
  -- unattended: no acceptance; when refuse_window_s > 0 the user sees a dialog and may refuse
  -- within that many seconds (no answer = the session goes on).
  access_mode          text NOT NULL DEFAULT 'attended' CHECK (access_mode IN ('attended', 'unattended')),
  consent_timeout_s    integer NOT NULL DEFAULT 60 CHECK (consent_timeout_s BETWEEN 10 AND 300),
  refuse_window_s      integer NOT NULL DEFAULT 0 CHECK (refuse_window_s = 0 OR refuse_window_s BETWEEN 10 AND 300),
  -- [{days: [0..6, 0 = Sunday], start: "HH:MM", end: "HH:MM"}] in the endpoint's site time zone;
  -- end <= start crosses midnight. Empty = any time.
  allowed_hours        jsonb NOT NULL DEFAULT '[]'::jsonb
                       CHECK (jsonb_typeof(allowed_hours) = 'array' AND jsonb_array_length(allowed_hours) <= 14),
  allowed_roles        text[] NOT NULL DEFAULT ARRAY['owner', 'admin', 'technician']
                       CHECK (cardinality(allowed_roles) >= 1 AND allowed_roles <@ ARRAY['owner', 'admin', 'technician']),
  default_profile_id   uuid NOT NULL,
  max_profile_id       uuid NOT NULL,
  mfa_required         boolean NOT NULL DEFAULT false,
  -- Unattended sessions wait for a second admin (never the requester) when set.
  approval_required    boolean NOT NULL DEFAULT false,
  approval_ttl_minutes integer NOT NULL DEFAULT 15 CHECK (approval_ttl_minutes BETWEEN 1 AND 240),
  -- Empty = any address. Checked against the request address as the app's TRUST_PROXY setting resolves it.
  ip_allowlist         cidr[] NOT NULL DEFAULT '{}' CHECK (cardinality(ip_allowlist) <= 32),
  created_by_email     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, default_profile_id) REFERENCES fleet_permission_profiles (organization_id, id),
  FOREIGN KEY (organization_id, max_profile_id) REFERENCES fleet_permission_profiles (organization_id, id)
);
CREATE UNIQUE INDEX fleet_groups_name ON fleet_groups (organization_id, lower(name));

ALTER TABLE fleet_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_groups FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_groups TO lan_app;

ALTER TABLE endpoints ADD COLUMN fleet_group_id uuid;
ALTER TABLE endpoints ADD CONSTRAINT endpoints_fleet_group_fk
  FOREIGN KEY (organization_id, fleet_group_id) REFERENCES fleet_groups (organization_id, id) ON DELETE SET NULL (fleet_group_id);
CREATE INDEX endpoints_fleet_group_idx ON endpoints (fleet_group_id) WHERE fleet_group_id IS NOT NULL;

-- ── Sessions: profile, permissions, policy trail, approval ──────────────────────────────────────
ALTER TABLE fleet_sessions DROP CONSTRAINT fleet_sessions_state_check;
ALTER TABLE fleet_sessions ADD CONSTRAINT fleet_sessions_state_check
  CHECK (state IN ('waiting_approval', 'waiting_consent', 'active', 'ended'));
ALTER TABLE fleet_sessions DROP CONSTRAINT fleet_sessions_consent_result_check;
-- not_refused: unattended with a refuse window that passed without the user refusing.
ALTER TABLE fleet_sessions ADD CONSTRAINT fleet_sessions_consent_result_check
  CHECK (consent_result IN ('pending', 'not_required', 'accepted', 'denied', 'timeout', 'unavailable', 'not_refused'));
ALTER TABLE fleet_sessions DROP CONSTRAINT fleet_sessions_end_reason_check;
ALTER TABLE fleet_sessions ADD CONSTRAINT fleet_sessions_end_reason_check
  CHECK (end_reason IN ('operator', 'user', 'consent_denied', 'consent_timeout', 'consent_unavailable', 'replaced', 'revoked', 'expired',
                        'approval_denied', 'approval_expired'));

ALTER TABLE fleet_sessions
  ADD COLUMN fleet_group_id      uuid,
  ADD COLUMN group_name          text,
  ADD COLUMN profile_id          uuid,
  ADD COLUMN profile_name        text,
  -- The flags granted for this session (the requested profile clamped to the policy maximum).
  -- NULL on sessions from before profiles existed.
  ADD COLUMN permissions         jsonb,
  ADD COLUMN consent_timeout_s   integer,
  ADD COLUMN refuse_window_s     integer NOT NULL DEFAULT 0,
  -- [{check, result: pass|fail|info, detail}] in evaluation order.
  ADD COLUMN policy_trail        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN mfa_verified        boolean NOT NULL DEFAULT false,
  ADD COLUMN request_ip          inet,
  ADD COLUMN approval_state      text NOT NULL DEFAULT 'not_required'
                                 CHECK (approval_state IN ('not_required', 'pending', 'approved', 'denied', 'expired')),
  ADD COLUMN approval_expires_at timestamptz,
  ADD COLUMN approver_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN approver_email      text,
  ADD COLUMN approval_decided_at timestamptz,
  ADD COLUMN approval_note       text CHECK (approval_note IS NULL OR length(approval_note) <= 300);
ALTER TABLE fleet_sessions ADD CONSTRAINT fleet_sessions_profile_fk
  FOREIGN KEY (organization_id, profile_id) REFERENCES fleet_permission_profiles (organization_id, id) ON DELETE SET NULL (profile_id);
CREATE INDEX fleet_sessions_approvals_idx ON fleet_sessions (organization_id, started_at DESC) WHERE state = 'waiting_approval';

-- A session open across this upgrade keeps what it could do before (control and clipboard both
-- ways: the Support profile), so it is not cut short or widened.
UPDATE fleet_sessions f
   SET permissions = jsonb_build_object('view', true, 'control', true, 'clipboard_in', true, 'clipboard_out', true, 'files', true,
                                        'audio', false, 'record', false, 'restart', true, 'privacy_screen', false, 'block_input', false, 'shell', false),
       profile_name = 'Support (before profiles)'
 WHERE f.state <> 'ended';
UPDATE endpoints e
   SET rd_session = e.rd_session || jsonb_build_object('permissions', f.permissions, 'profile_name', f.profile_name)
  FROM fleet_sessions f
 WHERE e.rd_session IS NOT NULL AND f.endpoint_id = e.id AND f.public_id = e.rd_session->>'id' AND f.state <> 'ended';
