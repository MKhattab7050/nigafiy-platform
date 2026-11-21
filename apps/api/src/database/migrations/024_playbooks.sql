-- Playbooks: multi-step workflow automation with approval gates (modules/playbooks).
--
--  * playbooks            trigger + ordered steps + enabled flag + scope (organization, or one site).
--                         `trigger` and `steps` are validated by the API against a closed catalogue
--                         (modules/playbooks/catalog.ts); nothing here can name an arbitrary command.
--                         approval_mode: 'always_ask' (default) gates every disruptive step on an
--                         administrator's approval; 'run_automatically' is set explicitly by an
--                         administrator (recorded in auto_run_set_by/at). Router actions always ask.
--  * playbook_settings    per-organization: two-person rule and how long an approval request stays open.
--  * playbook_runs        one durable record per run (trigger evidence, status, loop-guard chain).
--                         UNIQUE (playbook_id, trigger_key) makes trigger matching idempotent: the
--                         same event / incident / schedule slot can never start a playbook twice.
--  * playbook_run_steps   the run's steps, created when the run is created, each with its own status,
--                         inputs, outputs, errors, timestamps, actor and approval decision.

CREATE TABLE playbooks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- NULL: the whole organization.
  site_id               uuid,
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description           text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  enabled               boolean NOT NULL DEFAULT false,
  -- Triggers start dry runs only (preview what would happen, act on nothing).
  dry_run               boolean NOT NULL DEFAULT false,
  trigger               jsonb NOT NULL,
  steps                 jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 20),
  approval_mode         text NOT NULL DEFAULT 'always_ask' CHECK (approval_mode IN ('always_ask', 'run_automatically')),
  auto_run_set_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  auto_run_set_by_email text,
  auto_run_set_at       timestamptz,
  max_runs_per_hour     integer NOT NULL DEFAULT 6 CHECK (max_runs_per_hour BETWEEN 1 AND 60),
  template_key          text,
  version               integer NOT NULL DEFAULT 1,
  -- Events, incidents and schedule slots before this moment never start the playbook.
  enabled_at            timestamptz,
  created_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_email      text,
  updated_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by_email      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX playbooks_enabled_idx ON playbooks (organization_id) WHERE enabled;

CREATE TABLE playbook_settings (
  organization_id      uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  -- The approver of a disruptive step must be another person than the playbook's author / last editor.
  two_person_rule      boolean NOT NULL DEFAULT false,
  approval_ttl_minutes integer NOT NULL DEFAULT 60 CHECK (approval_ttl_minutes BETWEEN 5 AND 1440),
  updated_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE playbook_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  playbook_id      uuid,
  playbook_name    text NOT NULL,
  playbook_version integer NOT NULL,
  site_id          uuid,
  device_id        uuid,
  incident_id      uuid,
  -- The triggering event (no foreign key: event retention may remove it; the evidence keeps a copy).
  event_id         uuid,
  trigger_kind     text NOT NULL CHECK (trigger_kind IN ('event', 'incident', 'schedule', 'manual')),
  trigger_key      text NOT NULL,
  -- What started the run, as it was at that moment (event / incident / schedule slot / who clicked).
  evidence         jsonb NOT NULL DEFAULT '{}',
  dry_run          boolean NOT NULL DEFAULT false,
  approval_mode    text NOT NULL CHECK (approval_mode IN ('always_ask', 'run_automatically')),
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'waiting', 'awaiting_approval', 'succeeded', 'stopped', 'failed', 'rejected', 'expired', 'cancelled', 'skipped')),
  status_reason    text,
  current_position integer NOT NULL DEFAULT 0,
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  -- Short lease so the scheduler job and an API request never advance the same run at once.
  lease_token      uuid,
  lease_until      timestamptz,
  -- Loop guard: the run whose action caused the triggering event, and the playbooks in that chain.
  caused_by_run_id uuid,
  chain            uuid[] NOT NULL DEFAULT '{}',
  -- Author and last editor of the playbook when the run started (two-person rule).
  author_ids       uuid[] NOT NULL DEFAULT '{}',
  started_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  started_by_email text,
  started_by_role  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, playbook_id) REFERENCES playbooks (organization_id, id) ON DELETE SET NULL (playbook_id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id),
  FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE SET NULL (incident_id)
);
CREATE UNIQUE INDEX playbook_runs_trigger_key ON playbook_runs (playbook_id, trigger_key) WHERE playbook_id IS NOT NULL;
CREATE INDEX playbook_runs_active_idx ON playbook_runs (organization_id, next_run_at)
  WHERE status IN ('queued', 'running', 'waiting', 'awaiting_approval');
CREATE INDEX playbook_runs_history_idx ON playbook_runs (organization_id, created_at DESC);
CREATE INDEX playbook_runs_playbook_idx ON playbook_runs (playbook_id, created_at DESC);

CREATE TABLE playbook_run_steps (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  run_id                uuid NOT NULL,
  position              integer NOT NULL CHECK (position >= 0),
  step_key              text NOT NULL,
  action                text NOT NULL,
  params                jsonb NOT NULL DEFAULT '{}',
  risk                  text NOT NULL CHECK (risk IN ('low', 'disruptive')),
  on_error              text NOT NULL DEFAULT 'stop' CHECK (on_error IN ('stop', 'continue')),
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'awaiting_approval', 'approved', 'running', 'succeeded', 'failed', 'skipped', 'rejected', 'expired', 'previewed', 'cancelled')),
  -- What the step resolved to act on (device, routers, endpoint, target...) and its preconditions.
  input                 jsonb,
  output                jsonb,
  error                 text,
  -- The record of another module the step waits for: toolbox run, collector / router / endpoint command.
  external              jsonb,
  actor                 text CHECK (actor IN ('system', 'user')),
  actor_user_id         uuid,
  actor_email           text,
  approval_requested_at timestamptz,
  approval_expires_at   timestamptz,
  decided_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_by_email      text,
  decided_role          text,
  decided_ip            inet,
  decided_at            timestamptz,
  decision_comment      text CHECK (decision_comment IS NULL OR length(decision_comment) <= 1000),
  started_at            timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, position),
  FOREIGN KEY (organization_id, run_id) REFERENCES playbook_runs (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX playbook_run_steps_pending_approval_idx ON playbook_run_steps (organization_id, approval_expires_at) WHERE status = 'awaiting_approval';
-- Loop guard: recent action steps by action.
CREATE INDEX playbook_run_steps_recent_idx ON playbook_run_steps (organization_id, action, started_at DESC) WHERE started_at IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['playbooks', 'playbook_settings', 'playbook_runs', 'playbook_run_steps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;
