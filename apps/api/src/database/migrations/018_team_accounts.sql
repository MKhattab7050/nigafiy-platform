-- Team accounts: member status, invitations, password reset, TOTP multi-factor sign-in, account mail.
--
-- Identity tables (users, sessions, invitations, auth_tokens, user_recovery_codes) stay unreadable for
-- the application role `lan_app`: they are read and written only through the owner pool, and every
-- statement filters the organization explicitly. Nothing secret is stored in clear:
--   * invitation / reset / pending-sign-in tokens and recovery codes: SHA-256 of a high-entropy value;
--   * TOTP secrets: AES-256-GCM with the application key (common/crypto.ts encryptSecret).

-- A member can be deactivated (kept, but unable to use the organization) instead of removed.
ALTER TABLE memberships
  ADD COLUMN status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivated_by uuid REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE users
  ADD COLUMN last_login_at          timestamptz,
  ADD COLUMN password_changed_at    timestamptz,
  -- TOTP (RFC 6238): the confirmed secret, and a secret being set up but not yet confirmed.
  ADD COLUMN mfa_secret_enc         text,
  ADD COLUMN mfa_enabled_at         timestamptz,
  ADD COLUMN mfa_pending_secret_enc text,
  -- Highest 30-second time step already accepted: a code is never accepted twice.
  ADD COLUMN mfa_last_step          bigint,
  ADD COLUMN mfa_failed_attempts    integer NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until       timestamptz,
  ADD CONSTRAINT users_mfa_enabled_check CHECK ((mfa_secret_enc IS NULL) = (mfa_enabled_at IS NULL));

CREATE TABLE user_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- Organization security policy: who must use multi-factor sign-in.
ALTER TABLE organizations
  ADD COLUMN mfa_required text NOT NULL DEFAULT 'off' CHECK (mfa_required IN ('off', 'admins', 'all'));

CREATE TABLE invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email           text NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'technician', 'viewer')),
  token_hash      text NOT NULL UNIQUE,
  invited_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  invited_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at      timestamptz
);
-- At most one open invitation per address and organization.
CREATE UNIQUE INDEX invitations_open_key ON invitations (organization_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Single-purpose, single-use tokens that are not sessions:
--   password_reset  a reset link (admin-issued or "forgot password")
--   mfa_login       the password step succeeded; exchange with a TOTP / recovery code for a session
--   mfa_enroll      the password step succeeded but the organization requires MFA: set it up first
CREATE TABLE auth_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  purpose         text NOT NULL CHECK (purpose IN ('password_reset', 'mfa_login', 'mfa_enroll')),
  token_hash      text NOT NULL UNIQUE,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  attempts        integer NOT NULL DEFAULT 0
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose, created_at DESC);

-- An email channel an administrator explicitly allowed for account mail (invitations, password
-- resets). Alert channels are never used for account mail without this flag.
ALTER TABLE notification_channels ADD COLUMN use_for_account_emails boolean NOT NULL DEFAULT false;
ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_account_mail_check CHECK (NOT use_for_account_emails OR kind = 'email');
