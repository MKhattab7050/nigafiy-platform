'use strict';
// The desktop profile folder after the rename (docs/architecture/naming.md).
//
// Electron puts its profile (userData: local account, preferences, the collector's state and,
// in local mode, the whole database) under %APPDATA%\<productName>. productName changed from
// "LAN Detective" to "Nigafiy", so a renamed build would start with an empty profile and orphan the
// old one. Until Milestone 5 migrates it, a renamed build keeps using the legacy folder when it exists
// and the new one does not.
const path = require('node:path');

const PROFILE_NAME = 'Nigafiy';
const LEGACY_PROFILE_NAME = 'LAN Detective';
// Running from a source checkout, Electron names the profile after package.json "name".
const DEV_PROFILE_NAME = '@nigafiy/desktop';
const LEGACY_DEV_PROFILE_NAME = '@lan-detective/desktop';

/**
 * @param {{ appData: string, exists: (p: string) => boolean, name?: string, legacyName?: string }} o
 * @returns {{ dir: string, legacy: boolean }}
 */
function resolveDataDir({ appData, exists, name = PROFILE_NAME, legacyName = LEGACY_PROFILE_NAME }) {
  const current = path.join(appData, name);
  const legacy = path.join(appData, legacyName);
  if (exists(legacy) && !exists(current)) return { dir: legacy, legacy: true };
  return { dir: current, legacy: false };
}

module.exports = { resolveDataDir, PROFILE_NAME, LEGACY_PROFILE_NAME, DEV_PROFILE_NAME, LEGACY_DEV_PROFILE_NAME };
