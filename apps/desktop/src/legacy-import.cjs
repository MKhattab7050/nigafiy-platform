'use strict';
// Importing an install from before the rename (LAN Detective), on the first run of Nigafiy
// (docs/operations/installers.md, "An old LAN Detective install").
//
// The installer already upgrades an old install in place: it has the same NSIS GUID, so installing
// Nigafiy over it replaces the program and keeps %APPDATA%\LAN Detective, which the app keeps using
// (src/data-dir.cjs, the legacy fallback). What is left is offered here, never done on its own:
//   - moving the profile folder %APPDATA%\LAN Detective to %APPDATA%\Nigafiy (a rename on the same
//     drive: nothing is copied or deleted, it refuses when the new folder exists, and on any error the
//     old folder stays where it is and the app keeps using it);
//   - removing an old copy that still sits in another folder, by running that copy's own uninstaller
//     with its own window (and its own UAC prompt when it was installed for all users).
// Each needs a click; "Don't ask again" is remembered in the profile.
const fs = require('node:fs');
const path = require('node:path');
const { LEGACY_PROFILE_NAME, PROFILE_NAME } = require('./data-dir.cjs');

const LEGACY_PRODUCT = 'LAN Detective';
const LEGACY_UNINSTALLER = `Uninstall ${LEGACY_PRODUCT}.exe`;
const LEGACY_EXE = `${LEGACY_PRODUCT}.exe`;
const MOVE_FLAG = '--move-legacy-profile';
const PREFS_FILE = 'legacy-import.json';

const same = (a, b) => path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();

/**
 * Old program folders that still hold LAN Detective, apart from this install's own folder.
 * @param {{ localAppData?: string, programFiles?: string, installDir?: string, exists: (p: string) => boolean }} o
 * @returns {{ dir: string, scope: 'user' | 'machine', uninstaller: string | null }[]}
 */
function findLegacyInstalls({ localAppData, programFiles, installDir, exists }) {
  const candidates = [];
  if (localAppData) candidates.push({ dir: path.win32.join(localAppData, 'Programs', LEGACY_PRODUCT), scope: 'user' });
  if (programFiles) candidates.push({ dir: path.win32.join(programFiles, LEGACY_PRODUCT), scope: 'machine' });
  const out = [];
  for (const c of candidates) {
    if (installDir && same(c.dir, installDir)) continue;
    if (!exists(path.win32.join(c.dir, LEGACY_EXE))) continue;
    const uninstaller = path.win32.join(c.dir, LEGACY_UNINSTALLER);
    out.push({ ...c, uninstaller: exists(uninstaller) ? uninstaller : null });
  }
  return out;
}

/**
 * Whether the profile can be moved: only while the app is using the legacy folder (it exists and
 * the new one does not).
 * @returns {{ from: string, to: string } | null}
 */
function planProfileMove({ appData, exists, name = PROFILE_NAME, legacyName = LEGACY_PROFILE_NAME }) {
  const from = path.join(appData, legacyName);
  const to = path.join(appData, name);
  if (!exists(from) || exists(to)) return null;
  return { from, to };
}

/**
 * Moves the legacy profile folder by renaming it. Never overwrites and never deletes: when the new
 * folder exists or the rename keeps failing (a file still open), nothing changes.
 * @param {{ from: string, to: string, fsx?: { existsSync: Function, renameSync: Function }, retries?: number, wait?: (ms: number) => void }} o
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function moveProfile({ from, to, fsx = fs, retries = 10, wait = sleepSync }) {
  if (!fsx.existsSync(from)) return { ok: false, error: 'the old profile folder is gone' };
  if (fsx.existsSync(to)) return { ok: false, error: 'the Nigafiy profile folder already exists; nothing was moved' };
  let last = null;
  for (let i = 0; i <= retries; i++) {
    try {
      fsx.renameSync(from, to);
      return { ok: true };
    } catch (err) {
      last = err;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err?.code)) break;
      wait(500); // the previous instance may still be closing its files
    }
  }
  return { ok: false, error: `${last?.code ?? 'error'}: the old folder is still in use; nothing was moved` };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** "Don't ask again", kept in the profile. */
function prefsStore(dir, fsx = fs) {
  const file = path.join(dir, PREFS_FILE);
  return {
    load() {
      try {
        const v = JSON.parse(fsx.readFileSync(file, 'utf8'));
        return { neverAsk: v?.neverAsk === true };
      } catch {
        return { neverAsk: false };
      }
    },
    save(v) {
      fsx.mkdirSync(dir, { recursive: true });
      fsx.writeFileSync(file, JSON.stringify({ neverAsk: v.neverAsk === true }));
    },
  };
}

/**
 * Whether to ask at all: never with an explicit --user-data-dir, in a smoke run, from the chooser,
 * in a source checkout, or after "Don't ask again".
 */
function shouldOffer({ packaged, explicitDataDir, smoke, neverAsk, move, installs }) {
  if (!packaged || explicitDataDir || smoke || neverAsk) return false;
  return Boolean(move) || installs.length > 0;
}

const STRINGS = {
  en: {
    title: 'Nigafiy',
    found: 'Nigafiy found data or a program from before it was renamed (LAN Detective).',
    move: (from, to) => `Your data is in ${from}. Nigafiy can move it to ${to}. It is moved, not copied: nothing is deleted. Nigafiy restarts to do it.`,
    remove: (dirs) => `The old program is still installed in:\n${dirs.join('\n')}\nYou can remove it with its own uninstaller. Your data is not removed.`,
    moveButton: 'Move my data',
    removeButton: 'Remove the old program',
    later: 'Not now',
    never: "Don't ask again",
    moveFailed: (error) => `Your data was not moved and Nigafiy keeps using the old folder. ${error}`,
  },
  ar: {
    title: 'Nigafiy',
    found: 'عثر Nigafiy على بيانات أو برنامج من قبل تغيير الاسم (LAN Detective).',
    move: (from, to) => `بياناتك في ${from}. يمكن لـ Nigafiy نقلها إلى ${to}. تُنقل ولا تُنسخ: لا يُحذف شيء. يعيد Nigafiy التشغيل لتنفيذ ذلك.`,
    remove: (dirs) => `البرنامج القديم ما زال مثبّتًا في:\n${dirs.join('\n')}\nيمكنك إزالته بأداة الإزالة الخاصة به. لا تُحذف بياناتك.`,
    moveButton: 'نقل بياناتي',
    removeButton: 'إزالة البرنامج القديم',
    later: 'ليس الآن',
    never: 'لا تسألني مرة أخرى',
    moveFailed: (error) => `لم تُنقل بياناتك ويواصل Nigafiy استخدام المجلد القديم. ${error}`,
  },
};

// First-strong isolates around paths and the old name, so they read left to right in Arabic.
const iso = (t) => `⁨${t}⁩`;

/** The dialog's text and buttons, EN or AR. */
function offerText({ locale, move, installs }) {
  const t = locale === 'ar' ? STRINGS.ar : STRINGS.en;
  const lines = [t.found.replace('LAN Detective', iso('LAN Detective')).replace('Nigafiy', iso('Nigafiy'))];
  const buttons = [];
  if (move) {
    lines.push(t.move(iso(move.from), iso(move.to)));
    buttons.push({ id: 'move', label: t.moveButton });
  }
  const removable = installs.filter((i) => i.uninstaller);
  if (removable.length) {
    lines.push(t.remove(removable.map((i) => iso(i.dir))));
    buttons.push({ id: 'remove', label: t.removeButton });
  }
  buttons.push({ id: 'later', label: t.later }, { id: 'never', label: t.never });
  return { title: t.title, message: lines.join('\n\n'), buttons };
}

module.exports = {
  LEGACY_PRODUCT,
  LEGACY_UNINSTALLER,
  MOVE_FLAG,
  PREFS_FILE,
  findLegacyInstalls,
  planProfileMove,
  moveProfile,
  prefsStore,
  shouldOffer,
  offerText,
  STRINGS,
};
