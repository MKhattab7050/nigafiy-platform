-- Fleet Pro: remote shell, scripts library and jobs
-- (docs/features/fleet-pro.md "Built: shell, scripts and jobs").
--
--  * fleet_groups.shell_*         the group switch for the remote shell (OFF unless an admin turns it
--                                 on; computers in no group never get a shell) and its idle timeout.
--  * fleet_shell_sessions         one interactive shell (PowerShell on Windows, the account's shell on
--                                 Linux/macOS) opened by an admin through the agent's WebSocket.
--  * fleet_shell_transcript       the full transcript (input and output), AES-256-GCM per chunk with
--                                 the session's own key; the key is sealed with APP_ENCRYPTION_KEY in
--                                 fleet_shell_sessions.transcript_key_sealed (ops/sealed-columns.ts,
--                                 so rotate-key covers it). Never copied into the audit log.
--  * fleet_scripts / _versions    saved PowerShell / shell scripts with typed parameters, versioned,
--                                 per OS; technicians run only those marked runnable by technicians.
--  * fleet_jobs / _runs / _results / _outputs
--                                 a script on one computer, a selection or a group, now or scheduled
--                                 (one-off or recurring in a time zone, optionally only inside a
--                                 maintenance window); one result per computer per run; computers that
--                                 are offline run when they come back, until the run's expiry.

-- ── Group switch ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE fleet_groups
  ADD COLUMN shell_enabled              boolean NOT NULL DEFAULT false,
  ADD COLUMN shell_idle_timeout_minutes integer NOT NULL DEFAULT 15 CHECK (shell_idle_timeout_minutes BETWEEN 1 AND 240);

-- ── Remote shell ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_shell_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id           uuid NOT NULL,
  -- What the agent and the sockets use (never the row id).
  public_id             text NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  operator_id           uuid REFERENCES users (id) ON DELETE SET NULL,
  operator_email        text NOT NULL,
  reason                text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  fleet_group_id        uuid REFERENCES fleet_groups (id) ON DELETE SET NULL,
  profile_id            uuid,
  profile_name          text,
  policy_trail          jsonb NOT NULL DEFAULT '[]'::jsonb,
  mfa_verified          boolean NOT NULL DEFAULT false,
  request_ip            inet,
  -- opening: the agent was asked; open: the agent's shell runs; closed.
  state                 text NOT NULL DEFAULT 'opening' CHECK (state IN ('opening', 'open', 'closed')),
  shell                 text CHECK (shell IS NULL OR length(shell) <= 200),
  -- conpty (Windows pseudo console), pty (Linux), pipes (no terminal: documented limits).
  pty                   text CHECK (pty IS NULL OR pty IN ('conpty', 'pty', 'pipes')),
  cols                  integer NOT NULL DEFAULT 120 CHECK (cols BETWEEN 20 AND 400),
  rows                  integer NOT NULL DEFAULT 30 CHECK (rows BETWEEN 5 AND 200),
  idle_timeout_s        integer NOT NULL CHECK (idle_timeout_s BETWEEN 60 AND 14400),
  max_transcript_bytes  integer NOT NULL CHECK (max_transcript_bytes BETWEEN 65536 AND 268435456),
  -- AES-256-GCM key of this transcript, sealed with APP_ENCRYPTION_KEY. Never returned.
  transcript_key_sealed text NOT NULL,
  transcript_chunks     integer NOT NULL DEFAULT 0,
  bytes_in              bigint NOT NULL DEFAULT 0,
  bytes_out             bigint NOT NULL DEFAULT 0,
  command_id            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  opened_at             timestamptz,
  last_activity_at      timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  end_reason            text CHECK (end_reason IS NULL OR end_reason IN ('operator', 'user', 'idle', 'limit', 'exited', 'open_failed', 'agent_gone', 'revoked')),
  ended_by              text,
  exit_code             integer,
  error                 text CHECK (error IS NULL OR length(error) <= 500),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_shell_sessions_org_idx ON fleet_shell_sessions (organization_id, created_at DESC);
CREATE INDEX fleet_shell_sessions_live_idx ON fleet_shell_sessions (endpoint_id) WHERE state <> 'closed';
ALTER TABLE fleet_shell_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_shell_sessions FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
-- No DELETE: a shell's record (and its transcript) is evidence.
GRANT SELECT, INSERT, UPDATE ON fleet_shell_sessions TO lan_app;

CREATE TABLE fleet_shell_transcript (
  shell_id        uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  seq             integer NOT NULL CHECK (seq >= 0),
  -- i: operator input, o: shell output, e: an event (opened, resized, ended), at in ms.
  direction       char(1) NOT NULL CHECK (direction IN ('i', 'o', 'e')),
  at              timestamptz NOT NULL,
  -- nonce (12) || ciphertext || tag (16); AAD "<shell public id>|<seq>|<direction>".
  ciphertext      bytea NOT NULL,
  PRIMARY KEY (shell_id, seq),
  FOREIGN KEY (organization_id, shell_id) REFERENCES fleet_shell_sessions (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE fleet_shell_transcript ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_shell_transcript FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT ON fleet_shell_transcript TO lan_app;

-- ── Scripts library ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_scripts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description         text CHECK (description IS NULL OR length(description) <= 1000),
  os                  text NOT NULL CHECK (os IN ('windows', 'linux', 'macos')),
  -- Windows scripts are PowerShell; Linux and macOS scripts run with /bin/sh.
  language            text NOT NULL CHECK (language IN ('powershell', 'sh')),
  technician_runnable boolean NOT NULL DEFAULT false,
  current_version     integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  archived_at         timestamptz,
  created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_email    text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK ((os = 'windows') = (language = 'powershell'))
);
CREATE UNIQUE INDEX fleet_scripts_name_uniq ON fleet_scripts (organization_id, lower(name)) WHERE archived_at IS NULL;
ALTER TABLE fleet_scripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_scripts FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
-- Scripts are archived, never deleted (jobs keep pointing at the version they ran).
GRANT SELECT, INSERT, UPDATE ON fleet_scripts TO lan_app;

CREATE TABLE fleet_script_versions (
  script_id        uuid NOT NULL,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  version          integer NOT NULL CHECK (version >= 1),
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
  -- [{name, type: string|int|bool|choice, label, required, default, choices, min, max, max_length}]
  parameters       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parameters) = 'array'),
  timeout_s        integer NOT NULL DEFAULT 600 CHECK (timeout_s BETWEEN 10 AND 86400),
  note             text CHECK (note IS NULL OR length(note) <= 300),
  body_sha256      text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_email text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (script_id, version),
  FOREIGN KEY (organization_id, script_id) REFERENCES fleet_scripts (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE fleet_script_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_script_versions FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
-- A version never changes once saved.
GRANT SELECT, INSERT ON fleet_script_versions TO lan_app;

-- ── Jobs ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE fleet_jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  script_id              uuid NOT NULL,
  script_version         integer NOT NULL,
  -- The validated values ({name: value}); passed to the agent as typed values, never pasted into the script.
  parameters             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
  target_kind            text NOT NULL CHECK (target_kind IN ('endpoints', 'group')),
  endpoint_ids           uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(endpoint_ids) <= 1000),
  -- target_kind 'group': the group's members at each run (a deleted group leaves runs with no computers).
  fleet_group_id         uuid REFERENCES fleet_groups (id) ON DELETE SET NULL,
  schedule_kind          text NOT NULL CHECK (schedule_kind IN ('now', 'once', 'recurring')),
  run_at                 timestamptz,
  recur_every            text CHECK (recur_every IS NULL OR recur_every IN ('hourly', 'daily', 'weekly', 'monthly')),
  -- Wall-clock time in `timezone` (daily/weekly/monthly); minute past the hour for hourly.
  recur_time             text CHECK (recur_time IS NULL OR recur_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  recur_weekdays         smallint[] CHECK (recur_weekdays IS NULL OR (cardinality(recur_weekdays) BETWEEN 1 AND 7 AND recur_weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[])),
  recur_monthday         smallint CHECK (recur_monthday IS NULL OR recur_monthday BETWEEN 1 AND 28),
  timezone               text NOT NULL,
  maintenance_only       boolean NOT NULL DEFAULT false,
  -- How long a run waits for an offline computer (or for a maintenance window) before it expires.
  expiry_minutes         integer NOT NULL DEFAULT 1440 CHECK (expiry_minutes BETWEEN 5 AND 43200),
  next_run_at            timestamptz,
  state                  text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'cancelled', 'finished')),
  created_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_email       text NOT NULL,
  created_by_role        text NOT NULL CHECK (created_by_role IN ('owner', 'admin', 'technician')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  cancelled_at           timestamptz,
  cancelled_by_email     text,
  UNIQUE (organization_id, id),
  FOREIGN KEY (script_id, script_version) REFERENCES fleet_script_versions (script_id, version),
  CHECK (schedule_kind <> 'once' OR run_at IS NOT NULL),
  CHECK (schedule_kind <> 'recurring' OR (recur_every IS NOT NULL AND recur_time IS NOT NULL))
);
CREATE INDEX fleet_jobs_due_idx ON fleet_jobs (next_run_at) WHERE state = 'active';
CREATE INDEX fleet_jobs_org_idx ON fleet_jobs (organization_id, created_at DESC);
ALTER TABLE fleet_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_jobs FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_jobs TO lan_app;

CREATE TABLE fleet_job_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  job_id           uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('scheduled', 'manual', 'rerun')),
  rerun_of         uuid REFERENCES fleet_job_runs (id) ON DELETE SET NULL,
  scheduled_for    timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, job_id) REFERENCES fleet_jobs (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_job_runs_job_idx ON fleet_job_runs (job_id, created_at DESC);
ALTER TABLE fleet_job_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_job_runs FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_job_runs TO lan_app;

CREATE TABLE fleet_job_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  job_id           uuid NOT NULL,
  run_id           uuid NOT NULL,
  endpoint_id      uuid NOT NULL,
  -- pending: waiting for the computer to be online (and inside a maintenance window when asked);
  -- queued: the command was handed to the agent; then succeeded | failed | expired | cancelled | skipped.
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'succeeded', 'failed', 'expired', 'cancelled', 'skipped')),
  waiting_for      text CHECK (waiting_for IS NULL OR waiting_for IN ('online', 'maintenance_window')),
  skip_reason      text CHECK (skip_reason IS NULL OR length(skip_reason) <= 200),
  command_id       uuid,
  exit_code        integer,
  -- The first 8 KiB of each stream; the full copy (up to the agent's cap) is in fleet_job_outputs.
  stdout_preview   text,
  stderr_preview   text,
  stdout_bytes     integer,
  stderr_bytes     integer,
  -- The agent stopped keeping output after its cap (1 MiB per stream).
  output_capped    boolean NOT NULL DEFAULT false,
  duration_ms      integer,
  error            text CHECK (error IS NULL OR length(error) <= 2000),
  queued_at        timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (run_id, endpoint_id),
  FOREIGN KEY (organization_id, run_id) REFERENCES fleet_job_runs (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_job_results_open_idx ON fleet_job_results (organization_id, state) WHERE state IN ('pending', 'queued');
CREATE INDEX fleet_job_results_job_idx ON fleet_job_results (job_id, created_at DESC);
CREATE INDEX fleet_job_results_endpoint_idx ON fleet_job_results (endpoint_id, created_at DESC);
ALTER TABLE fleet_job_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_job_results FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_job_results TO lan_app;

CREATE TABLE fleet_job_outputs (
  result_id        uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  stdout           text NOT NULL DEFAULT '',
  stderr           text NOT NULL DEFAULT '',
  FOREIGN KEY (organization_id, result_id) REFERENCES fleet_job_results (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE fleet_job_outputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_job_outputs FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON fleet_job_outputs TO lan_app;

-- ── Agent commands: shell open/close, script run/cancel ─────────────────────────────────────────
ALTER TABLE endpoint_commands DROP CONSTRAINT endpoint_commands_kind_check;
ALTER TABLE endpoint_commands ADD CONSTRAINT endpoint_commands_kind_check CHECK (
  kind IN (
    'refresh_inventory', 'kill_process', 'service_action', 'power_action', 'notify_user',
    'fs_op', 'rd_capture', 'rd_input', 'software_action', 'fetch_logs', 'diagnostic_command',
    'rd_session_open', 'rd_session_close', 'rd_session_update',
    'fleet_restart', 'fleet_safe_boot_clear',
    'shell_open', 'shell_close', 'script_run', 'script_cancel'
  )
);
