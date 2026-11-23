#!/usr/bin/env node
// Creates and signs a Nigafiy release manifest (docs/operations/updates.md).
//
//   node scripts/release/sign-manifest.mjs \
//     --key <path to nigafiy-update-key.pem, outside the repository> \
//     --version 1.2.3 \
//     --component desktop-windows-x64=apps/desktop/release/Nigafiy-Setup-1.2.3.exe@https://downloads.example.com/1.2.3/Nigafiy-Setup-1.2.3.exe \
//     [--component endpoint-agent-windows-x64=dist/Nigafiy-Endpoint-Agent-Setup-1.2.3.exe@https://...] \
//     [--notes-url https://example.com/changelog/1.2.3] [--released-at 2026-11-23T10:00:00Z] \
//     [--expect-public-key <base64>] \
//     --out manifest.json
//
// Size and SHA-256 come from the files themselves. Every URL must be https://. The signature is
// checked with the key's own public half before the file is written; --expect-public-key also
// checks that this is the key the installs trust (NIGAFIY_UPDATE_PUBLIC_KEY).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildPayload, insideRepo, parseComponentArg, publicKeyOfPem, signPayload } from './manifest-lib.mjs';

const args = process.argv.slice(2);
const all = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) out.push(args[++i]);
    else if (args[i].startsWith(`${name}=`)) out.push(args[i].slice(name.length + 1));
  }
  return out;
};
const opt = (name) => all(name).at(-1);

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node scripts/release/sign-manifest.mjs --key <pem> --version x.y.z --component id=file@https://url [...] --out manifest.json');
  process.exit(2);
}

const keyPath = opt('--key');
const out = opt('--out');
if (!keyPath || !out) usage();
if (insideRepo(keyPath)) {
  console.error(`The signing key ${path.resolve(keyPath)} is inside the repository. Move it outside (and make sure it was never committed).`);
  process.exit(1);
}
try {
  const privatePem = readFileSync(keyPath, 'utf8');
  const publicKey = publicKeyOfPem(privatePem);
  const expected = opt('--expect-public-key');
  if (expected && expected !== publicKey) {
    console.error(`This key's public half is ${publicKey}, not the expected ${expected}. Installs would reject this manifest.`);
    process.exit(1);
  }
  const payload = await buildPayload({
    version: opt('--version'),
    components: all('--component').map(parseComponentArg),
    notesUrl: opt('--notes-url'),
    releasedAt: opt('--released-at'),
  });
  const envelope = signPayload(payload, privatePem);
  writeFileSync(path.resolve(out), `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`Signed manifest for ${payload.version} written to ${path.resolve(out)}`);
  for (const c of payload.components) console.log(`  ${c.id}: ${c.size} bytes, sha256 ${c.sha256}\n    ${c.url}`);
  console.log(`Public key: ${publicKey}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
