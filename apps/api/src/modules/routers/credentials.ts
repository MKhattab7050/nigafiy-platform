import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import type { RouterCredentials } from './schema.ts';

// Router administrator credentials: sealed with the application key before storage and decrypted
// in exactly one place — the configuration sent to the site's own collector (collector-config.ts).
// Never returned by the API, never written to the audit trail, never logged.

export const sealRouterCredentials = (c: RouterCredentials): string => encryptSecret(JSON.stringify({ username: c.username, password: c.password }));

export function openRouterCredentials(sealed: string): RouterCredentials | null {
  try {
    const v = JSON.parse(decryptSecret(sealed)) as Partial<RouterCredentials>;
    return typeof v.username === 'string' && typeof v.password === 'string' ? { username: v.username, password: v.password } : null;
  } catch {
    return null; // undecryptable (key changed): the router stays out of the configuration until credentials are re-entered
  }
}
