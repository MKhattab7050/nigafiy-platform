-- Android phone controls in regular app mode (docs/features/android.md §12): ring the phone and
-- stop ringing. Screen view, remote control, the file manager and messages reuse rd_session_open,
-- rd_capture, rd_input, fs_op and notify_user. What the phone can do is in endpoints.android
-- (features, all_files_access, accessibility_enabled, screen_capture), reported in each heartbeat.
ALTER TABLE endpoint_commands DROP CONSTRAINT endpoint_commands_kind_check;
ALTER TABLE endpoint_commands ADD CONSTRAINT endpoint_commands_kind_check CHECK (
  kind IN (
    'refresh_inventory', 'kill_process', 'service_action', 'power_action', 'notify_user',
    'fs_op', 'rd_capture', 'rd_input', 'software_action', 'fetch_logs', 'diagnostic_command',
    'rd_session_open', 'rd_session_close', 'rd_session_update',
    'fleet_restart', 'fleet_safe_boot_clear',
    'shell_open', 'shell_close', 'script_run', 'script_cancel',
    'patch_scan', 'patch_install', 'patch_reboot_prompt', 'patch_reboot',
    'android_lock', 'android_password_policy', 'android_camera', 'android_install_apk',
    'android_uninstall', 'android_wipe', 'android_release',
    'android_ring', 'android_ring_stop'
  )
);
