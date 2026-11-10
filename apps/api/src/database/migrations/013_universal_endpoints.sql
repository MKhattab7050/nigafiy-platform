-- Universal Endpoint Management (Phase 4 Completion + Windows, Linux, macOS, Android Enterprise & Apple MDM)
--
-- Expands endpoints with platform-specific management modes, hardware/mobile telemetry,
-- security & compliance posture, remote desktop session state, policy configuration,
-- and structured command results (Remote File Manager, Remote Desktop, Software, Logs, Diagnostics, Mobile/MDM).

ALTER TABLE endpoints
  ADD COLUMN platform             text NOT NULL DEFAULT 'windows'
    CHECK (platform IN ('windows', 'linux', 'macos', 'android', 'ios')),
  ADD COLUMN management_mode      text NOT NULL DEFAULT 'agent'
    CHECK (management_mode IN (
      'agent',
      'android_device_owner',
      'android_work_profile',
      'android_companion',
      'ios_supervised_mdm',
      'ios_byod_mdm',
      'macos_mdm'
    )),
  ADD COLUMN manufacturer         text,
  ADD COLUMN model                text,
  ADD COLUMN serial_number        text,
  ADD COLUMN security_patch_level text,
  ADD COLUMN battery_pct          double precision,
  ADD COLUMN battery_charging     boolean,
  ADD COLUMN compliance_status    text NOT NULL DEFAULT 'compliant'
    CHECK (compliance_status IN ('compliant', 'non_compliant', 'attention', 'unknown')),
  ADD COLUMN compliance_reasons   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN security             jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN policy               jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN rd_session           jsonb,
  ADD COLUMN last_rd_frame        jsonb;

ALTER TABLE endpoint_commands
  ADD COLUMN result_data jsonb;

ALTER TABLE endpoint_commands
  DROP CONSTRAINT endpoint_commands_kind_check;

ALTER TABLE endpoint_commands
  ADD CONSTRAINT endpoint_commands_kind_check CHECK (
    kind IN (
      'refresh_inventory',
      'kill_process',
      'service_action',
      'power_action',
      'notify_user',
      'fs_op',
      'rd_capture',
      'rd_input',
      'software_action',
      'fetch_logs',
      'diagnostic_command',
      'apply_policy',
      'mobile_action'
    )
  );

