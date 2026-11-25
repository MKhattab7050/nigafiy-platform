#!/usr/bin/env node
// Generates the Android release signing key on THIS PC, under .data/android (git-ignored).
// The key and its passwords never leave the machine and are never printed. Run once; it refuses to
// overwrite an existing key (losing the key means phones cannot take updates of the app).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, '.data', 'android');
const store = join(dir, 'release.jks');
const props = join(dir, 'keystore.properties');
const javaHome = process.env.JAVA_HOME || 'D:\\nigafiy-tools\\jdk17';
const keytool = join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');

if (existsSync(store) || existsSync(props)) {
  console.log(`A release key already exists in ${dir}; leaving it alone.`);
  process.exit(0);
}
if (!existsSync(keytool)) {
  console.error(`keytool not found at ${keytool}. Set JAVA_HOME to a JDK 17.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
// PKCS12 keeps one password for the store and the key.
const password = randomBytes(24).toString('base64url');
execFileSync(
  keytool,
  ['-genkeypair', '-noprompt', '-keystore', store, '-storetype', 'PKCS12', '-alias', 'nigafiy-agent', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Nigafiy Agent, O=Nigafiy (local key)', '-storepass:env', 'NIGAFIY_KS_PASS', '-keypass:env', 'NIGAFIY_KS_PASS'],
  { env: { ...process.env, NIGAFIY_KS_PASS: password }, stdio: ['ignore', 'ignore', 'inherit'] },
);
writeFileSync(props, `storeFile=release.jks\nstorePassword=${password}\nkeyAlias=nigafiy-agent\nkeyPassword=${password}\n`, { mode: 0o600 });
console.log(`Release key created: ${store} (passwords in keystore.properties next to it; back both up, never commit them).`);
