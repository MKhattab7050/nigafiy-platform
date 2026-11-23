'use strict';
// The installer identity survives the rename (docs/architecture/naming.md): an update over a
// "LAN Detective" install must upgrade it in place, never install a second copy beside it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const pkg = require('../package.json');

/** RFC 4122 version 5 UUID, as electron-builder derives the NSIS GUID from the appId. */
function uuidV5(name, namespace) {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const h = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const ELECTRON_BUILDER_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3';

test('the product is called Nigafiy with the Hub app id', () => {
  assert.equal(pkg.build.productName, 'Nigafiy');
  assert.equal(pkg.build.appId, 'com.nigafiy.hub');
});

test('the NSIS GUID stays the one the LAN Detective installer had (upgrade in place)', () => {
  assert.equal(pkg.build.nsis.guid, uuidV5('com.landetective.desktop', ELECTRON_BUILDER_NS_UUID));
  assert.equal(pkg.build.nsis.guid, '664f0038-fee2-574d-ae14-23d8a9c943e5');
  // Without the pinned GUID the new appId would give a different one: a second install.
  assert.notEqual(uuidV5(pkg.build.appId, ELECTRON_BUILDER_NS_UUID), pkg.build.nsis.guid);
});

test('the MSI upgrade code never changes', () => {
  assert.equal(pkg.build.msi.upgradeCode, '6DA7D862-27E7-4AC8-809D-89B4128FB3AE');
});

test('the bundled Sensor is packaged under its new name', () => {
  const sensor = pkg.build.extraResources.find((r) => r.to.startsWith('collector/'));
  assert.equal(sensor.to, 'collector/nigafiy-sensor.exe');
  assert.match(sensor.from, /nigafiy-sensor\.exe$/);
});
