/**
 * Every column that holds a value sealed with `APP_ENCRYPTION_KEY` (common/crypto.ts
 * `encryptSecret`). The key-rotation tool re-encrypts exactly these, and refuses to run when the
 * database has a column that looks sealed (name ends in `_enc`, `_encrypted` or `_sealed`) but is
 * not listed here — so a new sealed column cannot be silently left on the old key.
 *
 * When you add a sealed column in a migration, add it here (and the rotation test will cover it).
 */
export interface SealedColumn {
  table: string;
  column: string;
  /** Primary-key columns, used to address each row. Never secret. */
  key: readonly string[];
  /** Organization of the row, for per-organization audit counts; null for installation-wide tables. */
  organizationColumn: string | null;
  /** What it holds (for operators; never the value). */
  holds: string;
}

export const SEALED_COLUMNS: readonly SealedColumn[] = [
  { table: 'notification_channels', column: 'secret_encrypted', key: ['id'], organizationColumn: 'organization_id', holds: 'webhook signing secret, SMTP password, Telegram/Slack/Discord/ntfy tokens and webhook URLs' },
  { table: 'snmp_targets', column: 'secret_enc', key: ['id'], organizationColumn: 'organization_id', holds: 'SNMP read credentials' },
  { table: 'snmp_targets', column: 'write_secret_enc', key: ['id'], organizationColumn: 'organization_id', holds: 'SNMP write credentials' },
  { table: 'site_routers', column: 'secret_enc', key: ['id'], organizationColumn: 'organization_id', holds: 'router login credentials' },
  { table: 'users', column: 'mfa_secret_enc', key: ['id'], organizationColumn: null, holds: 'TOTP secret' },
  { table: 'users', column: 'mfa_pending_secret_enc', key: ['id'], organizationColumn: null, holds: 'TOTP secret being set up' },
  { table: 'config_backup_targets', column: 'secret_enc', key: ['id'], organizationColumn: 'organization_id', holds: 'SSH credentials for configuration backups' },
  { table: 'config_backup_contents', column: 'content_enc', key: ['target_id', 'sha256'], organizationColumn: 'organization_id', holds: 'backed-up device configuration text (secrets redacted)' },
  { table: 'config_backup_targets', column: 'secret_fp_key_enc', key: ['id'], organizationColumn: 'organization_id', holds: 'per-device key of the secret fingerprints in sanitized configurations' },
  { table: 'identity_providers', column: 'oidc_client_secret_enc', key: ['id'], organizationColumn: 'organization_id', holds: 'OIDC client secret of an SSO identity provider' },
  { table: 'sso_requests', column: 'code_verifier_enc', key: ['id'], organizationColumn: 'organization_id', holds: 'PKCE code verifier of an SSO sign-in in progress (10 minutes)' },
  { table: 'fleet_recordings', column: 'key_sealed', key: ['id'], organizationColumn: 'organization_id', holds: 'AES-256-GCM key of a remote support session recording (the file in the data folder)' },
  { table: 'config_backup_raw', column: 'raw_enc', key: ['target_id', 'sha256'], organizationColumn: 'organization_id', holds: 'unsanitized device configuration kept only for administrator-confirmed restore' },
];

/** Column names that look like sealed values. */
export const SEALED_NAME_PATTERN = '(_enc|_encrypted|_sealed)$';
