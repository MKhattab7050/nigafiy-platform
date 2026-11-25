// English ↔ Arabic parity for the UI dictionaries: same keys, same {placeholders}, no empty text.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { messages as ar } from './messages-ar.ts';
import { messages as en } from './messages-en.ts';
import { parsePlural, pluralCategoriesFor } from './plural.ts';

// Union over all plural forms: a form may spell the number out (Arabic one / two) instead of {n}.
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

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

const WEB = path.resolve(import.meta.dirname, '../..');
function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.next') || name === 'e2e') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('strings.ts')) yield full;
  }
}

describe('plural keys', () => {
  const arMap = ar as Record<string, string>;
  const pluralKeys = Object.keys(en).filter((k) => parsePlural((en as Record<string, string>)[k] as string));

  it('exist (count sentences use plural forms)', () => {
    assert.ok(pluralKeys.length >= 20, `only ${pluralKeys.length} plural keys`);
  });

  it('carry exactly the forms each language needs (en: one/other, ar: zero/one/two/few/many/other)', () => {
    const need = { en: pluralCategoriesFor('en'), ar: pluralCategoriesFor('ar') };
    assert.deepEqual(need.en, ['one', 'other']);
    assert.deepEqual(need.ar, ['zero', 'one', 'two', 'few', 'many', 'other']);
    for (const k of Object.keys(en)) {
      const e = parsePlural((en as Record<string, string>)[k] as string);
      const a = parsePlural(arMap[k] as string);
      assert.equal(!!a, !!e, `${k}: plural in one language only`);
      if (!e || !a) continue;
      assert.deepEqual(Object.keys(e).sort(), [...need.en].sort(), `en ${k} forms`);
      assert.deepEqual(Object.keys(a).sort(), [...need.ar].sort(), `ar ${k} forms`);
      for (const [c, text] of Object.entries(e)) assert.ok(text.trim() !== '', `en ${k} ${c} empty`);
      for (const [c, text] of Object.entries(a)) assert.ok(text.trim() !== '', `ar ${k} ${c} empty`);
    }
  });

  it('are read with tn(key, count), never with t(key)', () => {
    const plural = new Set(pluralKeys);
    const misuse: string[] = [];
    for (const file of sources(WEB)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\('([\w.-]+)'\)/g)) if (plural.has(m[1] as string)) misuse.push(`${path.relative(WEB, file)}: ${m[1]}`);
    }
    assert.deepEqual(misuse, []);
  });
});
