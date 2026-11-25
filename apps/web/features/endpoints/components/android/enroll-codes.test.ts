import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AndroidProvisioningInfo } from '@nigafiy/shared-types';
import { enrollLink, phoneRefusesServer, provisioningPayload } from './enroll-codes.ts';

const token = 'ldea_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const pinColons = `${'AB:CD:'.repeat(15)}AB:CD`;

test('the app link carries server, token and a colon-free lower-case pin (EnrollLink.kt format)', () => {
  const link = enrollLink('https://nigafiy.example.test:47143', token, pinColons);
  const u = new URL(link.replace('nigafiy://enroll', 'https://enroll.invalid/'));
  assert.ok(link.startsWith('nigafiy://enroll?'));
  assert.equal(u.searchParams.get('server'), 'https://nigafiy.example.test:47143');
  assert.equal(u.searchParams.get('token'), token);
  assert.equal(u.searchParams.get('pin'), 'abcd'.repeat(16));
  assert.ok(!enrollLink('https://h', token, null).includes('pin='));
});

test('the Device Owner payload names the admin component, the APK and its base64url SHA-256, and the enrollment extras', () => {
  const info: AndroidProvisioningInfo = {
    component: 'com.nigafiy.agent/.admin.NigafiyAdminReceiver',
    apk: { url: 'https://nigafiy.example.test/api/v1/agent/android/agent.apk', sha256: 'ab'.repeat(32), checksum_b64url: 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s', size_bytes: 123 },
    server_url: 'https://nigafiy.example.test',
    server_url_source: 'configured',
    tls_pin_sha256: null,
  };
  const json = JSON.parse(provisioningPayload(info, 'https://nigafiy.example.test', token, pinColons)!);
  assert.equal(json['android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME'], 'com.nigafiy.agent/.admin.NigafiyAdminReceiver');
  assert.equal(json['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'], info.apk!.url);
  assert.equal(json['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM'], info.apk!.checksum_b64url);
  assert.deepEqual(json['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'], { server: 'https://nigafiy.example.test', token, pin: 'abcd'.repeat(16) });
  assert.equal(provisioningPayload({ ...info, apk: null }, 'https://h', token, null), null);
});

test('the phone refuses plain http:// except loopback', () => {
  assert.equal(phoneRefusesServer('https://nigafiy.example.test'), false);
  assert.equal(phoneRefusesServer('http://127.0.0.1:4100'), false);
  assert.equal(phoneRefusesServer('http://10.0.0.5:4100'), true);
});
