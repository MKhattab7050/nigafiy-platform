'use strict';
// Environment variables after the rename (docs/architecture/naming.md): the desktop app's LD_*
// variables are now NIGAFIY_*. The new name wins; the old one is still read and logs one
// deprecation line. The same table as apps/api/src/config/env-compat.ts.

const LEGACY_ENV = Object.freeze({
  NIGAFIY_DATA_DIR: 'LD_DATA_DIR',
  NIGAFIY_BUNDLE_DIR: 'LD_BUNDLE_DIR',
  NIGAFIY_DESKTOP_NO_ENGINE: 'LD_DESKTOP_NO_ENGINE',
  NIGAFIY_DESKTOP_AUTO_CONSENT: 'LD_DESKTOP_AUTO_CONSENT',
});

const warned = new Set();

function readEnv(name, env = process.env, warn = console.warn) {
  const value = env[name];
  if (value !== undefined && value !== '') return value;
  const legacy = LEGACY_ENV[name];
  if (!legacy) return undefined;
  const old = env[legacy];
  if (old === undefined || old === '') return undefined;
  if (!warned.has(legacy)) {
    warned.add(legacy);
    warn(`[env] ${legacy} is deprecated, use ${name} (the old name still works)`);
  }
  return old;
}

module.exports = { LEGACY_ENV, readEnv };
