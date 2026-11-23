'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { resolveDataDir, DEV_PROFILE_NAME, LEGACY_DEV_PROFILE_NAME } = require('../src/data-dir.cjs');

const appData = path.join('C:', 'Users', 'u', 'AppData', 'Roaming');
const LEGACY = path.join(appData, 'LAN Detective');
const NEW = path.join(appData, 'Nigafiy');
const has = (...dirs) => (p) => dirs.includes(p);

test('only the legacy profile exists: it is used, so nothing is orphaned', () => {
  assert.deepEqual(resolveDataDir({ appData, exists: has(LEGACY) }), { dir: LEGACY, legacy: true });
});

test('only the new profile exists: it is used', () => {
  assert.deepEqual(resolveDataDir({ appData, exists: has(NEW) }), { dir: NEW, legacy: false });
});

test('both exist: the new one wins', () => {
  assert.deepEqual(resolveDataDir({ appData, exists: has(LEGACY, NEW) }), { dir: NEW, legacy: false });
});

test('neither exists (fresh install): the new one', () => {
  assert.deepEqual(resolveDataDir({ appData, exists: has() }), { dir: NEW, legacy: false });
});

test('a source checkout keeps its own profile under the old package name', () => {
  const legacyDev = path.join(appData, LEGACY_DEV_PROFILE_NAME);
  assert.deepEqual(resolveDataDir({ appData, exists: has(legacyDev), name: DEV_PROFILE_NAME, legacyName: LEGACY_DEV_PROFILE_NAME }), { dir: legacyDev, legacy: true });
});
