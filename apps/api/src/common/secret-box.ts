import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing with an explicit key: the one format for every secret stored at rest
 * (`v1:<iv b64>:<tag b64>:<ciphertext b64>`, 12-byte random IV). `common/crypto.ts` uses it with
 * `APP_ENCRYPTION_KEY`; the key-rotation tool (`ops/rotate-key.ts`) uses it with an old and a new key.
 *
 * Deliberately free of `config/env.ts`, so the operations tools can load it without a full API
 * environment.
 */

const KEY_HEX = /^[0-9a-fA-F]{64}$/;

/** Parses a 32-byte hex key. The error never contains the value. */
export function parseKeyHex(value: string, label = 'key'): Buffer {
  const trimmed = value.trim();
  if (!KEY_HEX.test(trimmed)) throw new Error(`${label} must be 32 bytes, hex encoded (64 hex characters)`);
  return Buffer.from(trimmed, 'hex');
}

/**
 * A short, non-secret identifier of a key (first 12 hex digits of SHA-256 over a fixed label and the
 * key), so an operator can tell which key a database was last rotated to without seeing the key.
 */
export function keyId(key: Buffer): string {
  return createHash('sha256').update('nigafiy-app-encryption-key-id:').update(key).digest('hex').slice(0, 12);
}

export function sealWithKey(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function openWithKey(key: Buffer, stored: string): string {
  const [version, iv, tag, ct] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
