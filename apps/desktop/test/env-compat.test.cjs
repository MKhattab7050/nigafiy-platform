'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readEnv } = require('../src/env-compat.cjs');

test('readEnv prefers the new name, falls back to the legacy one, and warns once', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(readEnv('NIGAFIY_DESKTOP_AUTO_CONSENT', { LD_DESKTOP_AUTO_CONSENT: '1' }, warn), '1');
  assert.equal(readEnv('NIGAFIY_DESKTOP_AUTO_CONSENT', { LD_DESKTOP_AUTO_CONSENT: '1' }, warn), '1');
  assert.equal(warnings.length, 1);
  assert.equal(readEnv('NIGAFIY_DESKTOP_NO_ENGINE', { NIGAFIY_DESKTOP_NO_ENGINE: 'n', LD_DESKTOP_NO_ENGINE: 'o' }, warn), 'n');
  assert.equal(readEnv('NIGAFIY_DATA_DIR', {}, warn), undefined);
  assert.equal(warnings.length, 1);
});
