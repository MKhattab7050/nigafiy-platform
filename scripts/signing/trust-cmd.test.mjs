// node --test scripts/signing/trust-cmd.test.mjs
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildTrustCmd, certificateDer } from './trust-cmd.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REAL_CER = path.join(ROOT, '.data', 'signing', 'nigafiy-code-signing.cer');

test('refuses a file with a private key', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.throws(() => certificateDer(pem), /private key/);
});

test('refuses something that is not a certificate', () => {
  assert.throws(() => certificateDer(Buffer.from('hello')));
});

test('builds a plain-ASCII CRLF .cmd with the certificate inside', { skip: !existsSync(REAL_CER) && 'no signing certificate on this computer' }, () => {
  const bytes = readFileSync(REAL_CER);
  const text = buildTrustCmd(bytes);
  assert.match(text, /^@echo off\r\n/);
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'only CRLF line endings');
  assert.doesNotMatch(text, /[^\x00-\x7f]/);
  // Exactly one PowerShell marker; the batch part builds it from two halves.
  assert.equal(text.split('#NIGAFIY-POWERSHELL').length, 2);
  const b64 = text.split("@'\r\n")[1].split("\r\n'@")[0].replace(/\s/g, '');
  assert.deepEqual(Buffer.from(b64, 'base64'), certificateDer(bytes));
  for (const store of ['Root', 'TrustedPublisher']) assert.ok(text.includes(`'${store}'`));
});
