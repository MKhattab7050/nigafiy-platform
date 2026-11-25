// Site content: both languages everywhere, brand files copied unchanged, screenshot names consistent.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROGRAMS_BRAND } from '@nigafiy/brand';
import { COMPANION_ORDER, PILLARS, PROGRAMS, PROGRAM_ORDER } from '../../lib/content/programs.ts';
import { S } from '../../lib/content/strings.ts';
import { listDocs } from '../../lib/docs.ts';
import { href } from '../../lib/i18n.ts';

const SITE = path.resolve(import.meta.dirname, '../..');
const REPO = path.resolve(SITE, '../..');
const ARABIC = /[؀-ۿ]/;

type T = { en: string; ar: string };
function* texts(v: unknown): Generator<T> {
  if (v && typeof v === 'object' && 'en' in v && 'ar' in v) yield v as T;
  else if (Array.isArray(v)) for (const x of v) yield* texts(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* texts(x);
}

describe('content', () => {
  it('every string has English and Arabic, and the Arabic is Arabic', () => {
    // docsLeadAr is only shown on the Arabic site.
    const all = [...texts(S), ...texts(PROGRAMS), ...texts(PILLARS)].filter((t) => t.en !== '' || t.ar === '');
    assert.ok(all.length > 150);
    for (const t of all) {
      assert.ok(t.en.trim(), `empty English for ${JSON.stringify(t)}`);
      assert.ok(t.ar.trim(), `empty Arabic for ${t.en}`);
      // The language switch names the other language in its own script ("العربية" on the English site).
      if (t.en !== t.ar && !ARABIC.test(t.en)) assert.match(t.ar, ARABIC, `Arabic text for "${t.en}"`);
    }
  });

  it('says Nigafiy, never the old name, and claims no AI', () => {
    const blob = JSON.stringify([S, PROGRAMS, PILLARS]);
    assert.doesNotMatch(blob, new RegExp(['lan', 'detective'].join('[ -]'), 'i'));
    assert.doesNotMatch(blob, /\b(GPT|LLM|machine learning|AI-powered)\b/i);
  });

  it('has a page for each of the seven programs, the Agent and the Sensor, with features and needs', () => {
    assert.deepEqual([...PROGRAM_ORDER, ...COMPANION_ORDER], ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox', 'agent', 'sensor']);
    for (const id of [...PROGRAM_ORDER, ...COMPANION_ORDER]) {
      const p = PROGRAMS[id];
      assert.equal(p.id, id);
      assert.ok(p.features.length >= 3, id);
      assert.ok(p.needs.length >= 1, id);
      assert.ok(PROGRAMS_BRAND[id].accent, id);
    }
  });

  it('links each program to docs that exist', () => {
    const slugs = new Set(listDocs().map((d) => d.slug));
    for (const p of Object.values(PROGRAMS)) for (const d of p.docs) assert.ok(slugs.has(d), `${p.id}: docs/${d}.md`);
  });

  it('screenshot file names are unique, and every committed screenshot is used', () => {
    const files = Object.values(PROGRAMS).flatMap((p) => p.shots.map((s) => s.file));
    assert.equal(new Set(files).size, files.length);
    for (const lang of ['en', 'ar']) {
      const dir = path.join(SITE, 'public', 'screenshots', lang);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) assert.ok(files.includes(f), `${lang}/${f} is not used by any program page`);
    }
  });

  it('the capture script writes exactly the files the pages use', () => {
    const spec = readFileSync(path.join(SITE, 'screenshots', 'capture.spec.ts'), 'utf8');
    const captured = [...spec.matchAll(/file: '([^']+\.png)'/g)].map((m) => m[1]);
    const used = Object.values(PROGRAMS).flatMap((p) => p.shots.map((s) => s.file));
    assert.deepEqual([...captured].sort(), [...used].sort());
  });

  it('the favicon and icon are the brand files, unchanged', () => {
    assert.deepEqual(readFileSync(path.join(SITE, 'public', 'icon.svg')), readFileSync(path.join(REPO, 'packages', 'brand', 'svg', 'app-icon.svg')));
    assert.deepEqual(readFileSync(path.join(SITE, 'public', 'favicon.ico')), readFileSync(path.join(REPO, 'packages', 'brand', 'ico', 'app.ico')));
  });

  it('the fonts are self-hosted with their licence', () => {
    const fonts = readdirSync(path.join(SITE, 'public', 'fonts'));
    assert.ok(fonts.some((f) => f.startsWith('ibm-plex-sans-arabic-arabic-')));
    assert.ok(fonts.includes('OFL-IBM-Plex-Sans.txt') && fonts.includes('OFL-IBM-Plex-Sans-Arabic.txt'));
    const css = readFileSync(path.join(SITE, 'app', 'globals.css'), 'utf8');
    assert.doesNotMatch(css, /https?:\/\//, 'no font or stylesheet from another host');
  });

  it('internal links carry the language and the trailing slash', () => {
    assert.equal(href('ar'), '/ar/');
    assert.equal(href('en', 'downloads'), '/en/downloads/');
    assert.equal(href('en', 'downloads#bundle'), '/en/downloads/#bundle');
    assert.equal(href('ar', '/docs/features/sso/'), '/ar/docs/features/sso/');
  });
});
