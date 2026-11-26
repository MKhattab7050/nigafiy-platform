-- Backups from the app (UX review 2026-11-26, item 15): "Back up now" and scheduled backups, with no
-- PostgreSQL client tools on the user's PC (ops/logical-backup.ts exports through the API's own
-- connection).
--
-- One row for the whole installation (id is always true). Only the API's owner connection reads it
-- (RLS on, no policy: lan_app sees nothing). The routes and the job act only on a single-organization
-- installation (an installed copy), for that organization's owner.
--
--  * folder        where backups are written; NULL = <data folder>/backups.
--  * schedule      off | daily | weekly, at `hour` (0-23, the server's local time), weekly on `weekday`
--                  (0 = Sunday). keep: how many scheduled backups to keep in the folder (oldest removed;
--                  files made with "Back up now" are never removed).
--  * key_envelope  APP_ENCRYPTION_KEY sealed with a passphrase the owner chose (scrypt + AES-256-GCM).
--                  The passphrase itself is never stored: the envelope is copied into every backup so a
--                  restore on another PC can read router, SMTP and other stored secrets again.
--                  key_id: the fingerprint of the key the envelope holds (a key rotation makes it stale).
--  * last_*        the last run, for Settings and the tray.

CREATE TABLE backup_settings (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  folder            text CHECK (folder IS NULL OR length(folder) BETWEEN 1 AND 400),
  schedule          text NOT NULL DEFAULT 'daily' CHECK (schedule IN ('off', 'daily', 'weekly')),
  hour              smallint NOT NULL DEFAULT 3 CHECK (hour BETWEEN 0 AND 23),
  weekday           smallint NOT NULL DEFAULT 0 CHECK (weekday BETWEEN 0 AND 6),
  keep              smallint NOT NULL DEFAULT 7 CHECK (keep BETWEEN 1 AND 100),
  key_envelope      jsonb,
  key_id            text,
  last_run_at       timestamptz,
  last_auto_at      timestamptz,
  last_ok_at        timestamptz,
  last_file         text,
  last_bytes        bigint,
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE backup_settings ENABLE ROW LEVEL SECURITY;
