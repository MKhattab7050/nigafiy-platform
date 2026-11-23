// node --test scripts/check-brand.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scan } from './check-brand.mjs';

test('flags the old name in UI text, in any case and in Arabic text', () => {
  assert.equal(scan('apps/web/x.ts', "title: 'LAN Detective'").length, 1);
  assert.equal(scan('apps/web/x.ts', "a: 'lan detective'").length, 1);
  assert.equal(scan('apps/web/x.ts', "ar: 'خادم LAN Detective'").length, 1);
  assert.equal(scan('apps/web/x.ts', 'host: lan-detective.example.com').length, 1);
});

test('allows the identifiers kept on purpose', () => {
  assert.deepEqual(scan('collectors/x.go', 'const ProductRulePrefix = "LAN Detective: "'), []);
  assert.deepEqual(scan('collectors/x.go', 'blockCommentPrefix = "lan-detective:block:"'), []);
  assert.deepEqual(scan('apps/api/x.ts', "owner: z.enum(['lan-detective', 'administrator'])"), []);
  assert.deepEqual(scan('apps/api/x.ts', "'X-LAN-Detective-Signature': sig"), []);
});

test('a kept identifier does not hide the old name elsewhere on the line', () => {
  assert.equal(scan('apps/web/x.ts', "'Made by LAN Detective, stored as “LAN Detective: <d>”'").length, 1);
});

test('history files and migration comments are allowed, migration code is not', () => {
  assert.deepEqual(scan('docs/superpowers/plans/p.md', 'LAN Detective'), []);
  assert.deepEqual(scan('apps/api/src/database/migrations/001_x.sql', '-- LAN Detective core'), []);
  assert.equal(scan('apps/api/src/database/migrations/001_x.sql', "INSERT INTO t VALUES ('LAN Detective');").length, 1);
});
