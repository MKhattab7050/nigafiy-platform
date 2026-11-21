import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import type { Credentials } from './schema.ts';

// SSH credentials of a backup target: sealed with the application key before storage and decrypted
// in exactly one place — the `config_backup` command delivered to the site's own collector
// (commands.ts). Never returned by the API, never written to the audit trail, never logged.

export function sealCredentials(c: Credentials): string {
  const v: Credentials = { username: c.username };
  if (c.password) v.password = c.password;
  if (c.private_key) v.private_key = c.private_key;
  if (c.passphrase) v.passphrase = c.passphrase;
  if (c.enable_secret) v.enable_secret = c.enable_secret;
  return encryptSecret(JSON.stringify(v));
}

export function openCredentials(sealed: string | null): Credentials | null {
  if (!sealed) return null;
  try {
    const v = JSON.parse(decryptSecret(sealed)) as Partial<Credentials>;
    if (typeof v.username !== 'string' || (typeof v.password !== 'string' && typeof v.private_key !== 'string')) return null;
    return v as Credentials;
  } catch {
    return null; // undecryptable (key changed): the target needs its credentials re-entered
  }
}

/** What the API may say about credentials: whether they are set and which kinds, never the values. */
export function describeCredentials(sealed: string | null, updatedAt: Date | null) {
  const c = openCredentials(sealed);
  return {
    set: !!c,
    unreadable: !!sealed && !c,
    updated_at: updatedAt,
    username_set: !!c?.username,
    auth: c ? (c.private_key ? (c.password ? 'key_and_password' : 'key') : 'password') : null,
    enable_secret_set: !!c?.enable_secret,
  };
}
