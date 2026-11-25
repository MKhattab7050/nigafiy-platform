'use strict';
// Running as the Microsoft Store package (MSIX; docs/operations/microsoft-store.md).
//
// A packaged app's writes to new files under %APPDATA% / %LOCALAPPDATA% are virtualized into a
// private per-package copy, and HKCU writes are copy-on-write. A PostgreSQL data folder split between
// the real %APPDATA%\Nigafiy and a private copy would break, so the Store package keeps its whole
// profile (database, logs, settings, sensor state) in its own package folder:
//   %LOCALAPPDATA%\Packages\<package family name>\LocalState\Nigafiy
// Windows deletes that folder when the app is uninstalled (as for every Store app).
//
// The profile of an NSIS install (%APPDATA%\Nigafiy, or the one from before the rename) is never
// used, moved or deleted from inside the package: such a move would itself be virtualized. The first
// run says where that data is, once.
const path = require('node:path');
const { PROFILE_NAME, LEGACY_PROFILE_NAME } = require('./data-dir.cjs');

// <Name>_<Version>_<Arch>_<ResourceId>_<PublisherId>: the folder Windows installs a package into.
const PACKAGE_DIR_RE = /^([A-Za-z0-9.-]{3,50})_(\d+\.\d+\.\d+\.\d+)_(x64|x86|arm64|arm|neutral)_([A-Za-z0-9.-]*)_([a-z0-9]{13})$/;

/**
 * The package identity from the program's path (…\WindowsApps\<package full name>\app\Nigafiy.exe),
 * or null.
 * @param {string} execPath
 */
function packageFromPath(execPath) {
  const parts = path.win32.normalize(String(execPath || '')).split('\\');
  for (let i = 1; i < parts.length; i++) {
    if (parts[i - 1].toLowerCase() !== 'windowsapps') continue;
    const m = parts[i].match(PACKAGE_DIR_RE);
    if (m) return { fullName: parts[i], familyName: `${m[1]}_${m[5]}`, name: m[1], version: m[2], arch: m[3], publisherId: m[5] };
  }
  return null;
}

/**
 * Whether this is the Store package, and its identity. Electron sets process.windowsStore inside an
 * AppX/MSIX package; the path gives the family name. A package registered from a development folder
 * has windowsStore but no family name in its path.
 * @param {{ windowsStore?: boolean, execPath: string }} o
 * @returns {{ fullName: string, familyName: string } | { fullName: null, familyName: null } | null}
 */
function storeRuntime({ windowsStore, execPath }) {
  const fromPath = packageFromPath(execPath);
  if (fromPath) return fromPath;
  return windowsStore === true ? { fullName: null, familyName: null } : null;
}

/**
 * The Store package's profile folder.
 * @param {{ localAppData: string, appData: string, familyName: string | null }} o
 * @returns {{ dir: string, own: boolean }} own = the package's own LocalState folder (not virtualized)
 */
function storeDataDir({ localAppData, appData, familyName }) {
  if (familyName && localAppData) return { dir: path.win32.join(localAppData, 'Packages', familyName, 'LocalState', 'Nigafiy'), own: true };
  // Development registration (no family name in the path): the virtualized %APPDATA%\Nigafiy view.
  return { dir: path.win32.join(appData, 'Nigafiy Store'), own: false };
}

const NOTICE_FILE = 'store-notice.json';

const STRINGS = {
  en: {
    title: 'Nigafiy from the Microsoft Store',
    message: (folders) =>
      `This copy of Nigafiy keeps its data separately, in its own folder. The data of the other Nigafiy installation on this computer is still here and is not used, moved or deleted:\n\n${folders.join('\n')}\n\nIf you no longer need that installation, remove it in Settings → Apps. Both copies use the same local ports, so run only one at a time.`,
    ok: 'OK',
    never: "Don't show again",
  },
  ar: {
    title: 'Nigafiy من Microsoft Store',
    message: (folders) =>
      `تحفظ نسخة Nigafiy هذه بياناتها بشكل منفصل في مجلدها الخاص. بيانات تثبيت Nigafiy الآخر على هذا الحاسوب ما زالت هنا، ولا تُستخدم ولا تُنقل ولا تُحذف:\n\n${folders.map((f) => `⁦${f}⁩`).join('\n')}\n\nإن لم تعد بحاجة إلى ذلك التثبيت فأزِله من الإعدادات ← التطبيقات. تستخدم النسختان المنافذ المحلية نفسها، لذا شغّل واحدة فقط في كل مرة.`,
    ok: 'حسنًا',
    never: 'لا تعرض هذا مرة أخرى',
  },
};

/**
 * Folders of another (NSIS) installation's data that exist, for the one-time notice.
 * @param {{ appData: string, exists: (p: string) => boolean, legacyInstalls?: { dir: string }[] }} o
 */
function otherInstallFolders({ appData, exists, legacyInstalls = [] }) {
  const out = [];
  for (const name of [PROFILE_NAME, LEGACY_PROFILE_NAME]) {
    const dir = path.win32.join(appData, name);
    if (exists(dir)) out.push(dir);
  }
  for (const i of legacyInstalls) out.push(i.dir);
  return out;
}

/** @param {{ locale: 'en' | 'ar', folders: string[] }} o */
function noticeText({ locale, folders }) {
  const t = STRINGS[locale] ?? STRINGS.en;
  return { title: t.title, message: t.message(folders), buttons: [t.ok, t.never] };
}

module.exports = { PACKAGE_DIR_RE, packageFromPath, storeRuntime, storeDataDir, otherInstallFolders, noticeText, NOTICE_FILE, STRINGS };
