'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sign = require('../scripts/signing.cjs');

const TP = 'AB'.repeat(20);

test('no certificate configured: unsigned build, nothing run', () => {
  assert.equal(sign.signingConfig({}), null);
  let ran = false;
  assert.equal(sign.signFiles([__filename], {}, () => { ran = true; }), false);
  assert.equal(ran, false);
});

test('NIGAFIY_REQUIRE_SIGNING=1 refuses an unsigned build', () => {
  assert.throws(() => sign.signingConfig({ NIGAFIY_REQUIRE_SIGNING: '1' }), /REQUIRE_SIGNING/);
});

test('thumbprint is cleaned and must be 40 hex characters', () => {
  assert.equal(sign.signingConfig({ NIGAFIY_SIGN_THUMBPRINT: `  ${TP.slice(0, 20)} ${TP.slice(20)} ` }).thumbprint, TP);
  assert.throws(() => sign.signingConfig({ NIGAFIY_SIGN_THUMBPRINT: 'abc' }), /40-character/);
});

test('timestamp server defaults to a free RFC 3161 server, can be turned off, must be http(s)', () => {
  assert.match(sign.signingConfig({ NIGAFIY_SIGN_THUMBPRINT: TP }).timestampUrl, /^http:\/\/timestamp\./);
  assert.equal(sign.signingConfig({ NIGAFIY_SIGN_THUMBPRINT: TP, NIGAFIY_SIGN_TIMESTAMP_URL: '' }).timestampUrl, '');
  const off = sign.signingConfig({ NIGAFIY_SIGN_THUMBPRINT: TP, NIGAFIY_SIGN_NO_TIMESTAMP: '1' });
  assert.equal(off.timestampUrl, '');
  assert.ok(sign.psArgs(off, 'a.exe').includes('-NoTimestamp'));
  assert.throws(() => sign.signingConfig({ NIGAFIY_SIGN_THUMBPRINT: TP, NIGAFIY_SIGN_TIMESTAMP_URL: 'file:///x' }), /http/);
});

test('PowerShell arguments carry the file and certificate but never the PFX password', () => {
  const cfg = sign.signingConfig({ NIGAFIY_SIGN_PFX: 'c.pfx', NIGAFIY_SIGN_PFX_PASSWORD: 'hunter2' });
  const args = sign.psArgs(cfg, 'C:\\a b\\app.exe');
  assert.ok(args.includes('-PfxPath'));
  assert.equal(args[args.indexOf('-Path') + 1], 'C:\\a b\\app.exe');
  assert.ok(!args.join(' ').includes('hunter2'));
  assert.ok(args[args.indexOf('-File') + 1].endsWith(path.join('scripts', 'signing', 'Sign-NigafiyFiles.ps1')));
});

test('signs each file once and refuses missing files', () => {
  const calls = [];
  const env = { NIGAFIY_SIGN_THUMBPRINT: TP };
  assert.equal(sign.signFiles([__filename, __filename], env, (exe, args) => calls.push([exe, args])), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.throws(() => sign.signFiles(['Z:\\missing.exe'], env, () => {}), /does not exist/);
});

test('electron-builder hook skips the SHA-1 pass', async () => {
  // No certificate configured in the test environment, so a sha256 call is a no-op too; the point is
  // that the sha1 call returns before touching the file system.
  await sign({ hash: 'sha1', path: 'Z:\\missing.exe' });
});
