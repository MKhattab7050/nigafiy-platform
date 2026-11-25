// English ↔ Arabic parity for the UI dictionaries: same keys, same {placeholders}, no empty text.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { messages as ar } from './messages-ar.ts';
import { messages as en } from './messages-en.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('UI dictionary parity (English ↔ Arabic)', () => {
  it('has exactly the same keys in both languages', () => {
    const enKeys = Object.keys(en).sort();
    const arKeys = Object.keys(ar).sort();
    assert.deepEqual(
      arKeys.filter((k) => !(k in en)),
      [],
      'keys only in Arabic',
    );
    assert.deepEqual(
      enKeys.filter((k) => !(k in ar)),
      [],
      'keys only in English',
    );
  });

  it('has no empty strings', () => {
    for (const [k, v] of Object.entries(en)) assert.ok(v.trim() !== '', `en ${k} is empty`);
    for (const [k, v] of Object.entries(ar)) assert.ok(v.trim() !== '', `ar ${k} is empty`);
  });

  it('uses the same {placeholders} in both languages', () => {
    const arMap = ar as Record<string, string>;
    for (const [k, v] of Object.entries(en)) {
      const other = arMap[k];
      if (other === undefined) continue;
      assert.deepEqual(placeholders(other), placeholders(v), `placeholders differ for ${k}`);
    }
  });
});
