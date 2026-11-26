-- Session banner per fleet group (docs/features/fleet-pro.md "Consent and the session banner").
--
-- fleet_groups.banner_mode decides what the person at a company-managed computer sees while a
-- remote support session runs:
--   shown      the full banner (the default, and what every session had before)
--   minimized  a small indicator in the corner of the screen (still with End session)
--   off        no on-screen banner: the operator connects without interrupting the signed-in user
-- `off` and `minimized` are accepted only with access_mode = 'unattended' (the group is for
-- company-owned, enrolled machines). Attended, help-request and Quick Support sessions always get
-- the full banner, whatever the group says (remote-desktop/service.ts). The audit log is written
-- in every mode; nothing here turns it off.
--
-- fleet_sessions.banner_mode keeps what each session used (the group may change later), and
-- banner_state gains the two answers an agent gives for them.
ALTER TABLE fleet_groups
  ADD COLUMN banner_mode text NOT NULL DEFAULT 'shown' CHECK (banner_mode IN ('shown', 'minimized', 'off'));
ALTER TABLE fleet_groups
  ADD CONSTRAINT fleet_groups_banner_mode_unattended CHECK (banner_mode = 'shown' OR access_mode = 'unattended');

ALTER TABLE fleet_sessions
  ADD COLUMN banner_mode text NOT NULL DEFAULT 'shown' CHECK (banner_mode IN ('shown', 'minimized', 'off'));
ALTER TABLE fleet_sessions DROP CONSTRAINT fleet_sessions_banner_state_check;
ALTER TABLE fleet_sessions ADD CONSTRAINT fleet_sessions_banner_state_check
  CHECK (banner_state IN ('pending', 'shown', 'minimized', 'off', 'unavailable', 'not_supported'));
