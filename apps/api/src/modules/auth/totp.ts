import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), with Node's crypto only. Pure: no I/O, the time is a
 * parameter. Authenticator apps use SHA-1, 6 digits and a 30-second step — the defaults here.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret (RFC 4226 recommends ≥ 128 bits; 160 matches the SHA-1 block). */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** HOTP value for a counter (RFC 4226 §5.3 dynamic truncation). */
export function hotp(key: Buffer, counter: bigint, digits = TOTP_DIGITS, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (timeMs: number, step = TOTP_STEP_SECONDS): bigint => BigInt(Math.floor(timeMs / 1000 / step));

export function totp(key: Buffer, timeMs: number, opts: { digits?: number; step?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' } = {}): string {
  return hotp(key, timeStep(timeMs, opts.step), opts.digits, opts.algorithm);
}

/**
 * Checks a code against the steps now−1, now and now+1 (±30 s clock skew) and returns the matching
 * step, or null. Every candidate is compared in constant time and all three are always computed.
 * Steps at or below `lastUsedStep` are refused: a code can be used once only.
 */
export function verifyTotp(secretBase32: string, code: string, timeMs: number, lastUsedStep: bigint | null): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretBase32);
  const now = timeStep(timeMs);
  let matched: bigint | null = null;
  for (const step of [now - 1n, now, now + 1n]) {
    const expected = Buffer.from(hotp(key, step));
    const ok = timingSafeEqual(expected, Buffer.from(code));
    if (ok && matched === null && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

/** otpauth:// URI for QR codes (Key Uri Format used by authenticator apps). */
export function otpauthUri(secretBase32: string, account: string, issuer = 'Nigafiy'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
