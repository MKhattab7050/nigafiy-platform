import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../../../common/crypto.ts';

// Shell transcripts (Fleet Pro, migration 042): every chunk of input and output is sealed with
// AES-256-GCM under the shell session's own key. The key is sealed with APP_ENCRYPTION_KEY in
// fleet_shell_sessions.transcript_key_sealed (ops/sealed-columns.ts: rotate-key re-seals it).
// AAD binds a chunk to its shell, position and direction, so chunks cannot be moved or swapped.

export function newTranscriptKey(): { key: Buffer; sealed: string } {
  const key = randomBytes(32);
  return { key, sealed: encryptSecret(key.toString('base64')) };
}

export function openTranscriptKey(sealed: string): Buffer {
  return Buffer.from(decryptSecret(sealed), 'base64');
}

const aad = (publicId: string, seq: number, direction: string) => Buffer.from(`${publicId}|${seq}|${direction}`, 'utf8');

export function sealChunk(key: Buffer, publicId: string, seq: number, direction: 'i' | 'o' | 'e', plain: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad(publicId, seq, direction));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

/** null when the chunk does not open with this key for this place (tampered or moved). */
export function openChunk(key: Buffer, publicId: string, seq: number, direction: string, sealed: Buffer): Buffer | null {
  if (sealed.length < 28) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    d.setAAD(aad(publicId, seq, direction));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
  } catch {
    return null;
  }
}
