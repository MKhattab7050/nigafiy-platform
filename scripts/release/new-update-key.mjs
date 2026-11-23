#!/usr/bin/env node
// Creates the Ed25519 key pair that signs Nigafiy release manifests (docs/operations/updates.md).
//
//   node scripts/release/new-update-key.mjs --out <folder outside the repository>
//
// Writes <folder>/nigafiy-update-key.pem (the PRIVATE key, PKCS#8; keep it offline, back it up,
// never commit it) and prints the public key to set as NIGAFIY_UPDATE_PUBLIC_KEY on every install.
// Refuses a folder inside this repository and never overwrites an existing key.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { insideRepo, newKeyPair } from './manifest-lib.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].slice(name.length + 1) : args[i + 1];
};

const out = opt('--out');
if (!out) {
  console.error('usage: node scripts/release/new-update-key.mjs --out <folder outside the repository>');
  process.exit(2);
}
const dir = path.resolve(out);
if (insideRepo(dir)) {
  console.error(`Refusing to write a private key inside the repository (${dir}). Pick a folder outside it, ideally on removable or encrypted storage.`);
  process.exit(1);
}
const file = path.join(dir, 'nigafiy-update-key.pem');
if (existsSync(file)) {
  console.error(`${file} already exists; not overwriting a signing key. Move it away first if you really mean to replace it (every install must then get the new public key).`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const { privatePem, publicKey } = newKeyPair();
writeFileSync(file, privatePem, { mode: 0o600, flag: 'wx' });
if (process.platform === 'win32') {
  // Only the current user (and SYSTEM / Administrators) may read the private key.
  const { spawnSync } = await import('node:child_process');
  const user = process.env.USERNAME ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME}` : null;
  if (user) spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F'], { stdio: 'ignore', windowsHide: true });
}
console.log(`Private key written to ${file}`);
console.log('Keep it offline and backed up. Anyone holding it can publish updates every install will accept.');
console.log('');
console.log('Public key (set on every install, e.g. in the .env next to the data folder):');
console.log(`NIGAFIY_UPDATE_PUBLIC_KEY=${publicKey}`);
