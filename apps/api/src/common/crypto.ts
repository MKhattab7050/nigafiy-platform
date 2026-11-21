import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';
import { openWithKey, sealWithKey } from './secret-box.ts';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const hmacSha256 = (key: string, body: string): string => createHmac('sha256', key).update(body).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ── Passwords: scrypt (memory-hard, built into Node; no native addon to audit) ──
const SCRYPT_LOG_N = 15;
const SCRYPT_OPTS = { N: 2 ** SCRYPT_LOG_N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, logN: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 64, { ...SCRYPT_OPTS, N: 2 ** logN }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_LOG_N);
  return `scrypt$${SCRYPT_LOG_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, logN, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !logN || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), Number(logN));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Used to keep login timing uniform when the account does not exist. */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomToken());

// ── Secrets at rest: AES-256-GCM with the application key (format: common/secret-box.ts) ──
const KEY = Buffer.from(env.APP_ENCRYPTION_KEY, 'hex');

export const encryptSecret = (plain: string): string => sealWithKey(KEY, plain);
export const decryptSecret = (stored: string): string => openWithKey(KEY, stored);
