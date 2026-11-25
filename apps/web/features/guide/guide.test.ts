// Unit tests of the user guide: every signed-in page has a help target, every English section has
// an Arabic one with the same anchors and links (and the other way round), and the search finds
// sections in both languages. Run with `pnpm --filter @nigafiy/web test:unit` (node --test).
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GUIDE_AR } from './content/ar.ts';
import { GUIDE_EN } from './content/en.ts';
import { GUIDE_FALLBACK, GUIDE_ROUTES, guideHref, guideTargetForPath } from './route-map.ts';
import { buildGuideIndex, normalize } from './search.ts';
import { type GuideBlock, type GuideContent, GUIDE_SECTION_IDS } from './types.ts';

const APP_DIR = path.resolve(import.meta.dirname, '../../app/(app)');

/** Every page.tsx under app/(app), as a URL path (`[id]` → a sample segment). */
function signedInRoutes(dir = APP_DIR, segs: string[] = []): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // Route groups `(x)` add no segment; dynamic segments get a sample value.
      const seg = /^\(.*\)$/.test(name) ? null : /^\[.*\]$/.test(name) ? 'sample-id' : name;
      out.push(...signedInRoutes(full, seg ? [...segs, seg] : segs));
    } else if (name === 'page.tsx') {
      out.push(`/${segs.join('/')}`);
    }
  }
  return out;
}

/**
 * Pages that deliberately use the fallback section. Empty today: every page has its own entry.
 * A page added later fails the test below until it gets an entry in GUIDE_ROUTES or is listed here.
 */
const EXPLICIT_FALLBACK: readonly string[] = [];

const anchors = (c: GuideContent, id: string): string[] =>
  c.find((s) => s.id === id)!.blocks.flatMap((b) => (b.kind === 'h' ? [b.id] : []));

/** The shape of a block without its words: kind, and the number of items, columns and rows. */
const shape = (b: GuideBlock): string => {
  switch (b.kind) {
    case 'h':
      return `h#${b.id}`;
    case 'steps':
    case 'list':
      return `${b.kind}(${b.items.length})`;
    case 'table':
      return `table(${b.head.length}x${b.rows.length}:${b.rows.map((r) => r.length).join(',')})`;
    case 'note':
      return `note:${b.tone}`;
    default:
      return b.kind;
  }
};

describe('route → section map', () => {
  const routes = signedInRoutes();

  it('finds the signed-in pages', () => {
    assert.ok(routes.length > 50, `only ${routes.length} pages found under ${APP_DIR}`);
    assert.ok(routes.includes('/guide'));
    assert.ok(routes.includes('/guard/routers/sample-id'));
  });

  it('gives every signed-in page its own section, or lists it as an explicit fallback', () => {
    const missing = routes.filter((r) => guideTargetForPath(r).fallback && !EXPLICIT_FALLBACK.includes(r));
    assert.deepEqual(missing, [], `pages without a guide entry: ${missing.join(', ')}`);
  });

  it('points only at sections and anchors that exist in both languages', () => {
    for (const r of GUIDE_ROUTES) {
      assert.ok(GUIDE_SECTION_IDS.includes(r.section), `${r.prefix} → unknown section ${r.section}`);
      if (r.anchor) {
        assert.ok(anchors(GUIDE_EN, r.section).includes(r.anchor), `${r.prefix} → #${r.anchor} missing in English`);
        assert.ok(anchors(GUIDE_AR, r.section).includes(r.anchor), `${r.prefix} → #${r.anchor} missing in Arabic`);
      }
    }
    assert.ok(GUIDE_SECTION_IDS.includes(GUIDE_FALLBACK));
  });

  it('uses the longest prefix, whole segments only, and the fallback for unknown pages', () => {
    assert.deepEqual(guideTargetForPath('/guard/routers/abc'), { section: 'routers', anchor: undefined, fallback: false });
    assert.equal(guideTargetForPath('/guard/access').section, 'guard');
    assert.equal(guideTargetForPath('/radar/devices/x?tab=1').section, 'devices');
    assert.equal(guideTargetForPath('/radar/devicesx').section, 'radar');
    assert.equal(guideTargetForPath('/fleet/jobs/42').section, 'fleet-pro');
    assert.equal(guideTargetForPath('/').section, 'hub');
    assert.deepEqual(guideTargetForPath('/no-such-page'), { section: GUIDE_FALLBACK, fallback: true });
    assert.equal(guideHref(guideTargetForPath('/radar/discovery')), '/guide/first-scan#scope');
  });
});

describe('content parity (English ↔ Arabic)', () => {
  it('has every section in both languages, in the same order', () => {
    assert.deepEqual(
      GUIDE_EN.map((s) => s.id),
      [...GUIDE_SECTION_IDS],
    );
    assert.deepEqual(
      GUIDE_AR.map((s) => s.id),
      [...GUIDE_SECTION_IDS],
    );
  });

  for (const id of GUIDE_SECTION_IDS) {
    it(`section ${id}: same group, program, anchors, block shapes and links`, () => {
      const en = GUIDE_EN.find((s) => s.id === id)!;
      const ar = GUIDE_AR.find((s) => s.id === id)!;
      assert.equal(ar.group, en.group);
      assert.equal(ar.program, en.program);
      assert.deepEqual(ar.blocks.map(shape), en.blocks.map(shape));
      assert.deepEqual(
        (ar.links ?? []).map((l) => l.href),
        (en.links ?? []).map((l) => l.href),
      );
      assert.ok(ar.title && ar.summary && en.title && en.summary);
    });
  }

  it('writes the Arabic guide in Arabic and keeps technical values in backticks balanced', () => {
    const texts = (c: GuideContent) =>
      c.flatMap((s) => [
        s.title,
        s.summary,
        ...s.blocks.flatMap((b) => (b.kind === 'table' ? [...b.head, ...b.rows.flat()] : b.kind === 'steps' || b.kind === 'list' ? [...b.items] : [b.text])),
      ]);
    for (const s of GUIDE_AR) assert.match(`${s.title} ${s.summary}`, /[؀-ۿ]/, `Arabic section ${s.id} has no Arabic in its title or summary`);
    for (const text of [...texts(GUIDE_EN), ...texts(GUIDE_AR)]) assert.equal(text.split('`').length % 2, 1, `unbalanced backticks: ${text}`);
  });

  it('has unique anchors within each section', () => {
    for (const c of [GUIDE_EN, GUIDE_AR])
      for (const s of c) {
        const ids = anchors(c, s.id);
        assert.equal(new Set(ids).size, ids.length, `${s.id} repeats an anchor`);
      }
  });

  it('says nothing about licences or billing (Nigafiy is free for now)', () => {
    const all = JSON.stringify([GUIDE_EN, GUIDE_AR]);
    assert.doesNotMatch(all, /licen[cs]e key|subscription|billing|pricing|ترخيص المنتج|اشتراك/i);
  });
});

describe('guide search', () => {
  const en = buildGuideIndex(GUIDE_EN, [GUIDE_AR]);
  const ar = buildGuideIndex(GUIDE_AR, [GUIDE_EN]);

  it('folds Arabic spelling variants and diacritics', () => {
    assert.equal(normalize('أُضِيفَ إلى'), normalize('اضيف الي'));
    assert.equal(normalize('الشبكة'), normalize('الشبكه'));
    assert.equal(normalize('٢٤'), '24');
  });

  it('finds English sections by their words', () => {
    assert.equal(en.query('router credentials')[0]?.id, 'routers');
    assert.equal(en.query('quick support')[0]?.id, 'fleet-enroll');
    assert.ok(en.query('Group Policy').some((h) => h.id === 'fleet-enroll'));
    assert.deepEqual(en.query('   '), []);
    assert.deepEqual(en.query('xylophone'), []);
  });

  it('finds Arabic sections, with the article and attached prepositions', () => {
    assert.equal(ar.query('راوتر')[0]?.id, 'routers');
    assert.ok(ar.query('مسح').some((h) => h.id === 'first-scan'));
    assert.ok(ar.query('مستشعر').some((h) => h.id === 'first-scan'));
  });

  it('finds a section from the other language and shows it in the reader’s language', () => {
    const hit = ar.query('router')[0];
    assert.equal(hit?.id, 'routers');
    assert.equal(hit?.title, GUIDE_AR.find((s) => s.id === 'routers')!.title);
    assert.ok(en.query('الراوتر').some((h) => h.id === 'routers'));
  });

  it('points a hit at the sub-heading that matches', () => {
    const hit = en.query('safety rules').find((h) => h.id === 'routers');
    assert.equal(hit?.anchor, 'safety');
  });
});
