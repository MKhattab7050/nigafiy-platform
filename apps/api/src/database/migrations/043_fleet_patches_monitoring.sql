-- Fleet Pro: patches, monitoring rules, inventory, local administrators and the user's side
-- (docs/features/fleet-pro.md "Built: patches, monitoring, inventory" and "Built: the user's side").
--
--  * endpoints.hardware             hardware and licence inventory measured by the agent (CPU, memory
--                                   modules, board/BIOS, serial, Windows activation, Office if seen,
--                                   physical disks with health and reliability counters, batteries).
--                                   Never a product key: the agent does not read keys.
--  * endpoint_patch_status          the agent's latest update scan (Windows Update Agent, apt, dnf,
--                                   softwareupdate): one row per computer with the missing updates.
--  * fleet_patch_policies           per group (or the organization default when fleet_group_id is
--                                   NULL): patching on/off, the classifications approved automatically,
--                                   where installs may run (the site's maintenance windows, or a weekly
--                                   patch window of the group), and the reboot policy.
--  * fleet_patch_approvals          an admin's decision on one update, for every group or one group.
--  * fleet_patch_installs           one install on one computer: the updates, the command, the result
--                                   per update, and the reboot that followed (asked, postponed, forced).
--  * fleet_monitor_rules / _states  CPU, memory, disk free, service state and event-log / journal rules
--                                   per group; a breach that lasts the rule's duration raises a Watch
--                                   event (and an incident) and its recovery resolves it.
--  * fleet_recording_user_links     a short-lived link the person at the computer opens from the tray
--                                   to watch a past recording of their own computer, when the group
--                                   allows it (fleet_groups.user_may_view_recordings, migration 036).

-- ── Inventory ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE endpoints
  ADD COLUMN hardware            jsonb,
  ADD COLUMN hardware_updated_at timestamptz;

-- ── Patches ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE endpoint_patch_status (
  endpoint_id      uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('wua', 'apt', 'dnf', 'softwareupdate', 'none')),
  -- Whether this agent can install through that source (the API never queues what it cannot do).
  install_supported boolean NOT NULL DEFAULT false,
  scanned_at       timestamptz NOT NULL,
  scan_error       text CHECK (scan_error IS NULL OR length(scan_error) <= 500),
  reboot_pending   boolean,
  -- [{ update_id, title, kb, classification, severity, size_bytes, reboot_required, published_at }]
  updates          jsonb NOT NULL DEFAULT '[]'::jsonb,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE endpoint_patch_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON endpoint_patch_status FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON endpoint_patch_status TO lan_app;

CREATE TABLE fleet_patch_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  fleet_group_id        uuid REFERENCES fleet_groups (id) ON DELETE CASCADE,
  enabled               boolean NOT NULL DEFAULT false,
  -- Classifications approved without a per-update decision (a declined update stays declined).
  auto_approve          text[] NOT NULL DEFAULT '{}'
    CHECK (auto_approve <@ ARRAY['critical', 'security', 'definition', 'update_rollup', 'service_pack', 'feature_pack', 'update', 'driver', 'tool', 'upgrade', 'other']::text[]),
  -- maintenance: the computer's site maintenance windows (migration 019); group: the window below.
  window_kind           text NOT NULL DEFAULT 'maintenance' CHECK (window_kind IN ('maintenance', 'group')),
  window_weekdays       smallint[] CHECK (window_weekdays IS NULL OR (cardinality(window_weekdays) BETWEEN 1 AND 7 AND window_weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[])),
  window_start          time,
  window_minutes        integer CHECK (window_minutes IS NULL OR window_minutes BETWEEN 30 AND 720),
  window_timezone       text,
  -- never: show "restart needed" only; ask: the person may postpone up to max_postponements times
  -- until the deadline; force: restart at the end of the window (with a 5-minute notice).
  reboot_policy         text NOT NULL DEFAULT 'ask' CHECK (reboot_policy IN ('never', 'ask', 'force')),
  max_postponements     integer NOT NULL DEFAULT 3 CHECK (max_postponements BETWEEN 0 AND 10),
  postpone_minutes      integer NOT NULL DEFAULT 60 CHECK (postpone_minutes BETWEEN 15 AND 1440),
  reboot_deadline_hours integer NOT NULL DEFAULT 24 CHECK (reboot_deadline_hours BETWEEN 1 AND 168),
  updated_by_email      text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (window_kind = 'maintenance' OR (window_weekdays IS NOT NULL AND window_start IS NOT NULL AND window_minutes IS NOT NULL AND window_timezone IS NOT NULL))
);
CREATE UNIQUE INDEX fleet_patch_policies_scope_idx ON fleet_patch_policies (organization_id, coalesce(fleet_group_id, '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE fleet_patch_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_patch_policies FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_patch_policies TO lan_app;

CREATE TABLE fleet_patch_approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  update_id        text NOT NULL CHECK (length(update_id) BETWEEN 1 AND 200),
  -- NULL: every group (and computers in no group).
  fleet_group_id   uuid REFERENCES fleet_groups (id) ON DELETE CASCADE,
  decision         text NOT NULL CHECK (decision IN ('approved', 'declined')),
  title            text NOT NULL CHECK (length(title) <= 500),
  kb               text,
  classification   text,
  decided_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_by_email text NOT NULL,
  decided_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_patch_approvals_scope_idx ON fleet_patch_approvals (organization_id, update_id, coalesce(fleet_group_id, '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE fleet_patch_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_patch_approvals FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_patch_approvals TO lan_app;

CREATE TABLE fleet_patch_installs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id       uuid NOT NULL,
  source            text NOT NULL CHECK (source IN ('wua', 'apt', 'dnf', 'softwareupdate')),
  state             text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'installing', 'succeeded', 'partial', 'failed', 'cancelled')),
  -- [{ update_id, title, kb, classification }] as approved when the install was queued.
  updates           jsonb NOT NULL,
  -- [{ update_id, result: succeeded|failed|aborted|not_started, hresult, reboot_required }]
  results           jsonb,
  command_id        uuid,
  why               text NOT NULL CHECK (why IN ('approved', 'auto_approved')),
  window_label      text,
  window_ends_at    timestamptz,
  queued_at         timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  error             text CHECK (error IS NULL OR length(error) <= 1000),
  reboot_required   boolean NOT NULL DEFAULT false,
  -- none: no restart needed; pending: needed, policy "never"; asking: the question is on screen;
  -- postponed: the person chose later; scheduled: the restart is due (deadline or window end);
  -- restarting: the agent started it; done: the computer came back; failed: the restart failed.
  reboot_state      text NOT NULL DEFAULT 'none' CHECK (reboot_state IN ('none', 'pending', 'asking', 'postponed', 'scheduled', 'restarting', 'done', 'failed')),
  reboot_policy     text CHECK (reboot_policy IS NULL OR reboot_policy IN ('never', 'ask', 'force')),
  postponements     integer NOT NULL DEFAULT 0,
  max_postponements integer NOT NULL DEFAULT 0,
  next_prompt_at    timestamptz,
  reboot_deadline   timestamptz,
  reboot_command_id uuid,
  rebooted_at       timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_patch_installs_endpoint_idx ON fleet_patch_installs (endpoint_id, queued_at DESC);
CREATE INDEX fleet_patch_installs_open_idx ON fleet_patch_installs (organization_id) WHERE state IN ('queued', 'installing') OR reboot_state IN ('asking', 'postponed', 'scheduled', 'restarting');
ALTER TABLE fleet_patch_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_patch_installs FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
-- No DELETE: the patch history of a computer is evidence.
GRANT SELECT, INSERT, UPDATE ON fleet_patch_installs TO lan_app;

-- ── Monitoring rules ────────────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_monitor_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- NULL: every managed computer.
  fleet_group_id       uuid REFERENCES fleet_groups (id) ON DELETE CASCADE,
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind                 text NOT NULL CHECK (kind IN ('cpu', 'memory', 'disk_free', 'service', 'event_log')),
  -- cpu / memory: percent above which the rule breaches; disk_free: free space below which it breaches
  -- (percent or GB per threshold_unit); event_log: at least this many matching entries in the window.
  threshold            numeric CHECK (threshold IS NULL OR threshold >= 0),
  threshold_unit       text CHECK (threshold_unit IS NULL OR threshold_unit IN ('pct', 'gb', 'count')),
  -- disk_free: one volume (C:, /, /home) or NULL for every volume.
  mount                text CHECK (mount IS NULL OR length(mount) BETWEEN 1 AND 120),
  -- service: the service name (Windows service name, systemd unit, launchd label) that must be running.
  service_name         text CHECK (service_name IS NULL OR length(service_name) BETWEEN 1 AND 256),
  -- event_log: Windows log name (System, Application, Security, or a channel) / journal unit ('' = all).
  event_log            text CHECK (event_log IS NULL OR length(event_log) <= 256),
  event_source         text CHECK (event_source IS NULL OR length(event_source) <= 256),
  event_ids            integer[] CHECK (event_ids IS NULL OR cardinality(event_ids) <= 20),
  event_level          text CHECK (event_level IS NULL OR event_level IN ('critical', 'error', 'warning', 'any')),
  match_text           text CHECK (match_text IS NULL OR length(match_text) <= 200),
  event_window_minutes integer CHECK (event_window_minutes IS NULL OR event_window_minutes BETWEEN 1 AND 1440),
  -- How long the breach must last before the alert (0: at once).
  duration_seconds     integer NOT NULL DEFAULT 300 CHECK (duration_seconds BETWEEN 0 AND 86400),
  severity             text NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'critical')),
  enabled              boolean NOT NULL DEFAULT true,
  created_by_email     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (kind NOT IN ('cpu', 'memory') OR (threshold IS NOT NULL AND threshold <= 100 AND threshold_unit = 'pct')),
  CHECK (kind <> 'disk_free' OR (threshold IS NOT NULL AND threshold_unit IN ('pct', 'gb'))),
  CHECK (kind <> 'service' OR service_name IS NOT NULL),
  CHECK (kind <> 'event_log' OR (event_log IS NOT NULL AND threshold IS NOT NULL AND threshold >= 1 AND threshold_unit = 'count' AND event_window_minutes IS NOT NULL))
);
CREATE INDEX fleet_monitor_rules_org_idx ON fleet_monitor_rules (organization_id, fleet_group_id);
ALTER TABLE fleet_monitor_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_monitor_rules FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_monitor_rules TO lan_app;

CREATE TABLE fleet_monitor_states (
  rule_id          uuid NOT NULL,
  endpoint_id      uuid NOT NULL,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- First measurement of the current breach (NULL: healthy); alerted_at once the event was raised.
  breached_since   timestamptz,
  alerted_at       timestamptz,
  alert_event_id   uuid,
  last_value       text CHECK (last_value IS NULL OR length(last_value) <= 300),
  last_checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, endpoint_id),
  FOREIGN KEY (organization_id, rule_id) REFERENCES fleet_monitor_rules (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE fleet_monitor_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_monitor_states FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_monitor_states TO lan_app;

-- Incidents opened by a monitoring rule (kind 'endpoint', key endpoint:<id>:rule:<id>). The kind
-- list is extended from whatever the constraint allows now, as migration 023 does.
DO $$
DECLARE kinds text[];
BEGIN
  SELECT array_agg(DISTINCT m[1]) INTO kinds
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
   WHERE c.conrelid = 'incidents'::regclass AND c.conname = 'incidents_kind_check';
  kinds := ARRAY(SELECT DISTINCT k FROM unnest(coalesce(kinds, ARRAY['network', 'service', 'collector', 'device', 'dhcp']) || ARRAY['endpoint']) AS k ORDER BY k);
  ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_kind_check;
  EXECUTE format('ALTER TABLE incidents ADD CONSTRAINT incidents_kind_check CHECK (kind = ANY (%L::text[]))', kinds);
END $$;

-- ── The user's side: past recordings from the tray ──────────────────────────────────────────────
CREATE TABLE fleet_recording_user_links (
  -- SHA-256 of the link's token; the token itself is only in the link the tray opened.
  token_hash       text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  recording_id     uuid NOT NULL REFERENCES fleet_recordings (id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL,
  requested_by     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  first_used_at    timestamptz,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_recording_user_links_expiry_idx ON fleet_recording_user_links (expires_at);
ALTER TABLE fleet_recording_user_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_recording_user_links FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_recording_user_links TO lan_app;

-- ── Agent commands: patches ─────────────────────────────────────────────────────────────────────
ALTER TABLE endpoint_commands DROP CONSTRAINT endpoint_commands_kind_check;
ALTER TABLE endpoint_commands ADD CONSTRAINT endpoint_commands_kind_check CHECK (
  kind IN (
    'refresh_inventory', 'kill_process', 'service_action', 'power_action', 'notify_user',
    'fs_op', 'rd_capture', 'rd_input', 'software_action', 'fetch_logs', 'diagnostic_command',
    'rd_session_open', 'rd_session_close', 'rd_session_update',
    'fleet_restart', 'fleet_safe_boot_clear',
    'shell_open', 'shell_close', 'script_run', 'script_cancel',
    'patch_scan', 'patch_install', 'patch_reboot_prompt', 'patch_reboot'
  )
);
