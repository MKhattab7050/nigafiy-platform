-- UX review item 6 (2026-11-26): the owner of an installed copy chooses their own password.
--
-- The desktop app creates the first account itself (`owner-<8 hex>@nigafiy.local`, a random
-- password kept DPAPI-encrypted on that PC) and signs in with it. Nobody knows that password, so the
-- person cannot sign in from a phone or another browser, and a Windows reinstall loses access.
--
-- password_set_by_owner_at: when a person last chose this account's password (own-password, change,
--   reset, recovery). While it is NULL on an auto-created local account, the web app offers
--   "Set your own password".
-- desktop_login_email / desktop_password_hash: the desktop app's own credential, kept when the
--   owner replaces the auto-created password. It is the random password the desktop stored (only
--   its hash is moved here), accepted by POST /auth/login/desktop only, so the installed app keeps
--   signing in on its own without knowing the owner's password.
ALTER TABLE users
  ADD COLUMN password_set_by_owner_at timestamptz,
  ADD COLUMN desktop_login_email      text,
  ADD COLUMN desktop_password_hash    text;

CREATE UNIQUE INDEX users_desktop_login_email_key ON users (lower(desktop_login_email)) WHERE desktop_login_email IS NOT NULL;

-- One-time codes that reset the password from the sign-in page (not the MFA recovery codes in
-- user_recovery_codes, which only replace the second factor). Like every identity table this stays
-- unreadable for lan_app; only a SHA-256 over the user id and an 80-bit code is stored.
CREATE TABLE account_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
