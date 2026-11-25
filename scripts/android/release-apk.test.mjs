import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBadging, parseSigner, releaseApkName, releaseProblems } from './release-apk.mjs';

const BADGING = `package: name='com.nigafiy.agent' versionCode='1' versionName='1.0.0' platformBuildVersionName='16'
minSdkVersion:'26'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'`;

const SIGNED = `Verifies
Verified using v2 scheme (APK Signature Scheme v2): true
Number of signers: 1
Signer #1 certificate DN: CN=Nigafiy Agent, O=Nigafiy (local key)
Signer #1 certificate SHA-256 digest: f2a2d1aabeabf0bad27540b67cda848c6eaef32e87e6423a786c2da370d66f97`;

const ok = (over = {}) => ({ badging: parseBadging(BADGING), signer: parseSigner(SIGNED), version: '1.0.0', ...over });

test('reads the package, version and debuggable flag', () => {
  assert.deepEqual(parseBadging(BADGING), { packageName: 'com.nigafiy.agent', versionName: '1.0.0', versionCode: '1', debuggable: false });
  assert.equal(parseBadging(`${BADGING}\napplication-debuggable`).debuggable, true);
});

test('reads the signer', () => {
  assert.deepEqual(parseSigner(SIGNED), {
    verifies: true,
    signers: 1,
    dn: 'CN=Nigafiy Agent, O=Nigafiy (local key)',
    sha256: 'f2a2d1aabeabf0bad27540b67cda848c6eaef32e87e6423a786c2da370d66f97',
  });
  assert.equal(parseSigner('DOES NOT VERIFY\nERROR: missing META-INF').verifies, false);
});

test('a signed release APK of the right version ships', () => {
  assert.deepEqual(releaseProblems(ok()), []);
  assert.deepEqual(releaseProblems(ok({ expectCertSha256: 'F2A2D1AABEABF0BAD27540B67CDA848C6EAEF32E87E6423A786C2DA370D66F97' })), []);
  assert.equal(releaseApkName('1.0.0'), 'Nigafiy-Android-Agent-1.0.0.apk');
});

test('refuses the wrong version, a debug key, a debuggable or unverified APK, or another certificate', () => {
  assert.match(releaseProblems(ok({ version: '1.1.0' })).join(), /versionName is 1\.0\.0, the release is 1\.1\.0/);
  const debugKey = parseSigner(SIGNED.replace('CN=Nigafiy Agent, O=Nigafiy (local key)', 'C=US, O=Android, CN=Android Debug'));
  assert.match(releaseProblems(ok({ signer: debugKey })).join(), /debug key/);
  assert.match(releaseProblems(ok({ badging: parseBadging(`${BADGING}\napplication-debuggable`) })).join(), /debuggable/);
  assert.match(releaseProblems(ok({ signer: parseSigner('DOES NOT VERIFY') })).join(), /does not verify/);
  assert.match(releaseProblems(ok({ expectCertSha256: 'ab'.repeat(32) })).join(), /expected abab/);
});
