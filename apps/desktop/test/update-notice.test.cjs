'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trayLine, noticeFor, TEXT } = require('../src/update-notice.cjs');

const available = { configured: true, ok: true, current_version: '1.0.4', checked_at: 'x', latest_version: '1.0.5', update_available: true, released_at: null, notes_url: null };
const current = { ...available, latest_version: '1.0.4', update_available: false };

test('an available update is a clickable tray line, in English and Arabic', () => {
  assert.deepEqual(trayLine(available, 'en-US'), { label: 'Update available: version 1.0.5', enabled: true, opens: true });
  assert.equal(trayLine(available, 'ar-EG').label, 'يتوفر تحديث: الإصدار 1.0.5');
});

test('off is said plainly and is never "up to date"', () => {
  for (const reason of ['no_source', 'no_key']) {
    const line = trayLine({ configured: false, reason, current_version: '1.0.4' }, 'en');
    assert.equal(line.label, TEXT.en.off);
    assert.equal(line.enabled, false);
    assert.doesNotMatch(line.label, /up to date/i);
  }
  assert.equal(trayLine({ configured: false, reason: 'no_source', current_version: '1.0.4' }, 'ar').label, TEXT.ar.off);
  assert.equal(trayLine({ configured: false, reason: 'msi_managed', current_version: '1.0.4' }, 'en').label, TEXT.en.msi);
  assert.equal(trayLine({ configured: false, reason: 'store_managed', current_version: '1.0.4' }, 'en').label, TEXT.en.store);
});

test('a failed check says so; an up-to-date copy shows its version; nothing before the first check', () => {
  assert.equal(trayLine({ configured: true, ok: false, current_version: '1.0.4', checked_at: 'x', error: 'unreachable' }, 'en').label, TEXT.en.failed);
  assert.equal(trayLine(current, 'en').label, 'Up to date (version 1.0.4)');
  assert.equal(trayLine(null, 'en'), null);
});

test('the Windows notice comes once per new version', () => {
  const n = noticeFor(available, null, 'en');
  assert.equal(n.version, '1.0.5');
  assert.match(n.title, /1\.0\.5/);
  assert.equal(noticeFor(available, '1.0.5', 'en'), null);
  assert.equal(noticeFor({ ...available, latest_version: '1.0.6' }, '1.0.5', 'ar').version, '1.0.6');
  assert.equal(noticeFor(current, null, 'en'), null);
  assert.equal(noticeFor({ configured: false, reason: 'no_source', current_version: '1.0.4' }, null, 'en'), null);
});
