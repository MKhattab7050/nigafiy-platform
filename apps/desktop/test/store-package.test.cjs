'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { packageFromPath, storeRuntime, storeDataDir, otherInstallFolders, noticeText } = require('../src/store-package.cjs');

const FULL = 'Nigafiy.Hub_0.1.0.0_x64__8wekyb3d8bbwe';
const EXE = `C:\\Program Files\\WindowsApps\\${FULL}\\app\\Nigafiy.exe`;

test('packageFromPath reads the package identity from the WindowsApps folder name', () => {
  assert.deepEqual(packageFromPath(EXE), { fullName: FULL, familyName: 'Nigafiy.Hub_8wekyb3d8bbwe', name: 'Nigafiy.Hub', version: '0.1.0.0', arch: 'x64', publisherId: '8wekyb3d8bbwe' });
  // another package volume
  assert.equal(packageFromPath(`D:\\WindowsApps\\${FULL}\\app\\Nigafiy.exe`)?.familyName, 'Nigafiy.Hub_8wekyb3d8bbwe');
  // not a package
  for (const p of ['C:\\Users\\u\\AppData\\Local\\Programs\\Nigafiy\\Nigafiy.exe', 'C:\\Program Files\\Nigafiy\\Nigafiy.exe', `C:\\Temp\\${FULL}\\app\\Nigafiy.exe`, 'C:\\Program Files\\WindowsApps\\Nigafiy\\Nigafiy.exe', '']) {
    assert.equal(packageFromPath(p), null, p);
  }
});

test('storeRuntime: the path wins; windowsStore alone is a development registration; neither is not the Store', () => {
  assert.equal(storeRuntime({ windowsStore: true, execPath: EXE })?.fullName, FULL);
  assert.equal(storeRuntime({ windowsStore: undefined, execPath: EXE })?.fullName, FULL);
  assert.deepEqual(storeRuntime({ windowsStore: true, execPath: 'D:\\dev\\layout\\app\\Nigafiy.exe' }), { fullName: null, familyName: null });
  assert.equal(storeRuntime({ windowsStore: false, execPath: 'C:\\Program Files\\Nigafiy\\Nigafiy.exe' }), null);
});

test('storeDataDir: the package LocalState folder, never the shared %APPDATA%\\Nigafiy', () => {
  const local = 'C:\\Users\\u\\AppData\\Local';
  const roaming = 'C:\\Users\\u\\AppData\\Roaming';
  assert.deepEqual(storeDataDir({ localAppData: local, appData: roaming, familyName: 'Nigafiy.Hub_8wekyb3d8bbwe' }), {
    dir: 'C:\\Users\\u\\AppData\\Local\\Packages\\Nigafiy.Hub_8wekyb3d8bbwe\\LocalState\\Nigafiy',
    own: true,
  });
  const dev = storeDataDir({ localAppData: local, appData: roaming, familyName: null });
  assert.equal(dev.own, false);
  assert.notEqual(dev.dir.toLowerCase(), `${roaming}\\Nigafiy`.toLowerCase());
});

test('the one-time notice lists the other installation data that exists, in English and Arabic', () => {
  const roaming = 'C:\\Users\\u\\AppData\\Roaming';
  const have = new Set([`${roaming}\\Nigafiy`]);
  const folders = otherInstallFolders({ appData: roaming, exists: (p) => have.has(p), legacyInstalls: [{ dir: 'C:\\Program Files\\Old' }] });
  assert.deepEqual(folders, [`${roaming}\\Nigafiy`, 'C:\\Program Files\\Old']);
  assert.deepEqual(otherInstallFolders({ appData: roaming, exists: () => false }), []);
  const en = noticeText({ locale: 'en', folders });
  assert.match(en.message, /not used, moved or deleted/);
  assert.ok(en.message.includes(`${roaming}\\Nigafiy`));
  assert.deepEqual(en.buttons, ['OK', "Don't show again"]);
  const ar = noticeText({ locale: 'ar', folders });
  assert.match(ar.title, /Microsoft Store/);
  assert.ok(ar.message.includes(`\u2066${roaming}\\Nigafiy\u2069`), 'paths are bidi-isolated in Arabic');
  assert.equal(ar.buttons.length, 2);
});
