import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';

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

// ── Secrets at rest: AES-256-GCM with the application key ──
const KEY = Buffer.from(env.APP_ENCRYPTION_KEY, 'hex');

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, ct] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
