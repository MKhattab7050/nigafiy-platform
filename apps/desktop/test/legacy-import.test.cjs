'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findLegacyInstalls, planProfileMove, moveProfile, prefsStore, shouldOffer, offerText, MOVE_FLAG } = require('../src/legacy-import.cjs');
const { resolveDataDir } = require('../src/data-dir.cjs');

/** A fake folder tree on disk under a fresh temp folder. */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nigafiy-legacy-'));
  for (const f of files) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!f.endsWith('/')) fs.writeFileSync(p, f);
  }
  return { root, at: (...p) => path.join(root, ...p), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('finds old per-user and per-machine copies, not this install, not an empty folder', () => {
  const t = tree([
    'Local/Programs/LAN Detective/LAN Detective.exe',
    'Local/Programs/LAN Detective/Uninstall LAN Detective.exe',
    'PF/LAN Detective/LAN Detective.exe',
    'PF2/LAN Detective/',
  ]);
  try {
    const exists = (p) => fs.existsSync(p);
    const found = findLegacyInstalls({ localAppData: t.at('Local'), programFiles: t.at('PF'), installDir: t.at('Local', 'Programs', 'Nigafiy'), exists });
    assert.deepEqual(found, [
      { dir: path.win32.join(t.at('Local'), 'Programs', 'LAN Detective'), scope: 'user', uninstaller: path.win32.join(t.at('Local'), 'Programs', 'LAN Detective', 'Uninstall LAN Detective.exe') },
      { dir: path.win32.join(t.at('PF'), 'LAN Detective'), scope: 'machine', uninstaller: null },
    ]);
    // Upgraded in place: the install folder is the old one, so it is not "another copy".
    assert.equal(findLegacyInstalls({ localAppData: t.at('Local'), installDir: t.at('Local', 'Programs', 'LAN Detective'), exists }).length, 0);
    assert.equal(findLegacyInstalls({ programFiles: t.at('PF2'), exists }).length, 0);
  } finally {
    t.done();
  }
});

test('moves the legacy profile by renaming it; the legacy fallback then picks the new folder', () => {
  const t = tree(['Roaming/LAN Detective/Local Storage/leveldb/000003.log', 'Roaming/LAN Detective/collector/identity.json']);
  try {
    const exists = (p) => fs.existsSync(p);
    const appData = t.at('Roaming');
    assert.equal(resolveDataDir({ appData, exists }).legacy, true);
    const plan = planProfileMove({ appData, exists });
    assert.deepEqual(plan, { from: path.join(appData, 'LAN Detective'), to: path.join(appData, 'Nigafiy') });
    assert.deepEqual(moveProfile(plan), { ok: true });
    assert.equal(fs.readFileSync(path.join(appData, 'Nigafiy', 'collector', 'identity.json'), 'utf8'), 'Roaming/LAN Detective/collector/identity.json');
    assert.equal(fs.existsSync(path.join(appData, 'LAN Detective')), false);
    assert.deepEqual(resolveDataDir({ appData, exists }), { dir: path.join(appData, 'Nigafiy'), legacy: false });
    assert.equal(planProfileMove({ appData, exists }), null);
  } finally {
    t.done();
  }
});

test('never overwrites a Nigafiy profile and never deletes the old one', () => {
  const t = tree(['Roaming/LAN Detective/old.txt', 'Roaming/Nigafiy/new.txt']);
  try {
    const appData = t.at('Roaming');
    assert.equal(planProfileMove({ appData, exists: (p) => fs.existsSync(p) }), null);
    const r = moveProfile({ from: path.join(appData, 'LAN Detective'), to: path.join(appData, 'Nigafiy') });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(path.join(appData, 'LAN Detective', 'old.txt'), 'utf8'), 'Roaming/LAN Detective/old.txt');
    assert.equal(fs.readFileSync(path.join(appData, 'Nigafiy', 'new.txt'), 'utf8'), 'Roaming/Nigafiy/new.txt');
  } finally {
    t.done();
  }
});

test('a folder still in use is retried, then left where it is', () => {
  let renames = 0;
  const busy = { existsSync: (p) => p === 'from', renameSync: () => {
      renames++;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
  };
  const r = moveProfile({ from: 'from', to: 'to', fsx: busy, retries: 3, wait: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /EBUSY.*nothing was moved/);
  assert.equal(renames, 4);
  let n = 0;
  const later = { existsSync: (p) => p === 'from', renameSync: () => { if (++n < 3) throw Object.assign(new Error('perm'), { code: 'EPERM' }); } };
  assert.deepEqual(moveProfile({ from: 'from', to: 'to', fsx: later, wait: () => {} }), { ok: true });
});

test('"Don\'t ask again" is remembered; an explicit profile, a smoke run or a source checkout is never asked', () => {
  const t = tree(['p/']);
  try {
    const store = prefsStore(t.at('p'));
    assert.deepEqual(store.load(), { neverAsk: false });
    store.save({ neverAsk: true });
    assert.deepEqual(store.load(), { neverAsk: true });
  } finally {
    t.done();
  }
  const base = { packaged: true, explicitDataDir: false, smoke: false, neverAsk: false, move: { from: 'a', to: 'b' }, installs: [] };
  assert.equal(shouldOffer(base), true);
  assert.equal(shouldOffer({ ...base, explicitDataDir: true }), false);
  assert.equal(shouldOffer({ ...base, smoke: true }), false);
  assert.equal(shouldOffer({ ...base, packaged: false }), false);
  assert.equal(shouldOffer({ ...base, neverAsk: true }), false);
  assert.equal(shouldOffer({ ...base, move: null }), false);
  assert.equal(shouldOffer({ ...base, move: null, installs: [{ dir: 'x', scope: 'user', uninstaller: 'u' }] }), true);
  assert.equal(MOVE_FLAG, '--move-legacy-profile');
});

test('the offer says Nigafiy in EN and AR, isolates paths, and always has Not now', () => {
  const move = { from: 'C:\\Users\\me\\AppData\\Roaming\\LAN Detective', to: 'C:\\Users\\me\\AppData\\Roaming\\Nigafiy' };
  const installs = [{ dir: 'C:\\Program Files\\LAN Detective', scope: 'machine', uninstaller: 'C:\\Program Files\\LAN Detective\\Uninstall LAN Detective.exe' }];
  const en = offerText({ locale: 'en', move, installs });
  assert.deepEqual(en.buttons.map((b) => b.id), ['move', 'remove', 'later', 'never']);
  assert.match(en.message, /Nigafiy/);
  assert.ok(en.message.includes(`\u2068${move.from}\u2069`));
  const ar = offerText({ locale: 'ar', move: null, installs: [{ ...installs[0], uninstaller: null }] });
  assert.deepEqual(ar.buttons.map((b) => b.id), ['later', 'never']);
  assert.match(ar.message, /[\u0600-\u06ff]/);
  assert.ok(ar.message.includes('\u2068Nigafiy\u2069'));
});
