-- Configuration restore beyond Juniper Junos: the device identity behind every backup, and the
-- administrator's explicit choice to restore onto a device whose identity differs.
--
-- The collector reads the hardware model and serial number the device reports (read-only commands,
-- never part of the configuration text; Junos and VyOS / EdgeOS today) and sends them with the
-- backup result. Each run keeps what was reported; each version keeps the identity of the run that
-- first stored it (filled in later when a run confirms an unchanged version that had none).
--
-- A restore compares the version's identity with the device's identity in the backup right before
-- the restore. A different (or unknown) identity is refused unless the administrator forced it with a
-- second typed confirmation (forced_other_device). The collector checks again on the device itself
-- before it changes anything.

ALTER TABLE config_backup_runs
  ADD COLUMN device_model  text CHECK (length(device_model) <= 100),
  ADD COLUMN device_serial text CHECK (length(device_serial) <= 100);

ALTER TABLE config_backup_versions
  ADD COLUMN device_model  text CHECK (length(device_model) <= 100),
  ADD COLUMN device_serial text CHECK (length(device_serial) <= 100);

ALTER TABLE config_backup_restores
  ADD COLUMN forced_other_device boolean NOT NULL DEFAULT false,
  -- 'match' | 'mismatch' | 'unknown' at the time of the request; the identity seen by the restore session.
  ADD COLUMN identity_check  text CHECK (identity_check IN ('match', 'mismatch', 'unknown')),
  ADD COLUMN device_model    text CHECK (length(device_model) <= 100),
  ADD COLUMN device_serial   text CHECK (length(device_serial) <= 100);
