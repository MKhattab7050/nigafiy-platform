-- Removes the iOS / Android "MDM" support added in 013. It had no Apple MDM protocol
-- (no APNs push, no signed profiles, no check-in handling) and no Android Device Policy
-- Controller app: commands sent to such an endpoint could never run. Only endpoints running
-- the LAN Detective agent (Windows, Linux, macOS) remain.

-- Mobile endpoints and everything hanging off them (commands, samples cascade).
DELETE FROM endpoints WHERE platform IN ('android', 'ios');
DELETE FROM endpoint_commands WHERE kind = 'mobile_action';

ALTER TABLE endpoints DROP CONSTRAINT IF EXISTS endpoints_platform_check;
ALTER TABLE endpoints ADD CONSTRAINT endpoints_platform_check CHECK (platform IN ('windows', 'linux', 'macos'));

ALTER TABLE endpoints
  DROP COLUMN management_mode,
  DROP COLUMN security_patch_level,
  DROP COLUMN battery_pct,
  DROP COLUMN battery_charging;

-- Mobile-only security answers, a permission flag no agent reports, and policy settings that
-- nothing enforces.
UPDATE endpoints
   SET security = security - 'supervised' - 'device_owner' - 'work_profile' - 'passcode_compliant'
                           - 'rooted_or_jailbroken' - 'accessibility_granted' - 'screen_recording_granted',
       policy = policy - 'passcode_required' - 'min_passcode_length' - 'camera_disabled'
                       - 'usb_file_transfer_blocked' - 'wifi_ssid' - 'wifi_security' - 'vpn_name'
                       - 'vpn_server' - 'managed_apps';

-- Older agents sent false/0 for checks they never ran (every field on Linux and macOS; disk
-- encryption and pending updates on Windows). Those were not observations; drop them.
UPDATE endpoints
   SET security = security - 'firewall_enabled' - 'antivirus_enabled' - 'disk_encrypted' - 'pending_updates'
 WHERE platform IN ('linux', 'macos');
UPDATE endpoints
   SET security = security - 'disk_encrypted' - 'pending_updates'
 WHERE platform = 'windows';
UPDATE endpoints
   SET compliance_reasons = array(
         SELECT r FROM unnest(compliance_reasons) AS r
          WHERE NOT (platform <> 'windows' AND r = 'Host firewall is reported off')
            AND r NOT LIKE '% OS/security update(s) pending'
       );

-- Compliance reasons computed from those answers no longer apply.
UPDATE endpoints
   SET compliance_reasons = array(
         SELECT r FROM unnest(compliance_reasons) AS r
          WHERE r NOT LIKE 'Passcode%' AND r NOT LIKE 'Device is rooted%'
       );
UPDATE endpoints
   SET compliance_status = CASE WHEN security = '{}'::jsonb AND disk_used_pct IS NULL THEN 'unknown' ELSE 'compliant' END
 WHERE compliance_status IN ('non_compliant', 'attention') AND cardinality(compliance_reasons) = 0;

ALTER TABLE endpoint_commands DROP CONSTRAINT endpoint_commands_kind_check;
ALTER TABLE endpoint_commands ADD CONSTRAINT endpoint_commands_kind_check CHECK (
  kind IN (
    'refresh_inventory', 'kill_process', 'service_action', 'power_action', 'notify_user',
    'fs_op', 'rd_capture', 'rd_input', 'software_action', 'fetch_logs', 'diagnostic_command'
  )
);
