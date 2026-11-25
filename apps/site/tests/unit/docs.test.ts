// The docs pipeline: which docs are published, safe rendering, link rewriting, anchors, search.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Slugger, docSearchEntries, listDocs, renderDoc, resolveDocLink } from '../../lib/docs.ts';
import { guideFor, guideSearchEntries } from '../../lib/guide.ts';
import { searchDocs } from '../../lib/search.ts';

const docs = listDocs();
const published = new Set(docs.map((d) => d.slug));
const render = (markdown: string, slug = 'features/x') => renderDoc({ slug, markdown }, published, 'en');

describe('published docs', () => {
  it('publishes getting-started, features, operations and security, and nothing internal', () => {
    for (const s of ['getting-started', 'features/sso', 'operations/updates', 'operations/installers', 'security/model', 'features/user-guide']) assert.ok(published.has(s), s);
    for (const d of docs) {
      assert.match(d.slug, /^(getting-started|features\/|operations\/|security\/)/, d.slug);
      assert.doesNotMatch(d.source, /superpowers|roadmap|architecture|design/);
    }
  });

  it('every published doc has a title and renders', () => {
    for (const d of docs) {
      assert.ok(d.title && d.title !== d.slug, `${d.slug} has a # title`);
      assert.ok(renderDoc(d, published, 'en').html.length > 100, d.slug);
    }
  });
});

describe('safe rendering', () => {
  it('escapes raw HTML instead of passing it through', () => {
    const { html } = render('Hello <script>alert(1)</script> <img src=x onerror=alert(2)>\n\n<iframe src="https://evil.example"></iframe>');
    assert.doesNotMatch(html, /<script|<img|<iframe/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('turns javascript:, data: and vbscript: links into plain text', () => {
    const { html } = render('[a](javascript:alert(1)) [b](data:text/html,x) [c](vbscript:x) [d](JAVASCRIPT:alert(1))');
    // markdown-it's link validator refuses them, so the source stays visible as text and nothing is clickable.
    assert.doesNotMatch(html, /href=/);
    assert.doesNotMatch(html, /<a /);
  });

  it('shows images as their alt text (no broken image)', () => {
    const { html } = render('![the topology](../assets/topo.png)');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /the topology/);
  });

  it('wraps tables so they scroll on a phone', () => {
    assert.match(render('| a | b |\n| --- | --- |\n| 1 | 2 |').html, /<div class="table-wrap" tabindex="0"><table>/);
  });

  it('leaves the first "# " title out of the body (the page prints it)', () => {
    const { html, headings } = render('# Title\n\nText\n\n## Part');
    assert.doesNotMatch(html, /<h1/);
    assert.deepEqual(
      headings.map((h) => h.text),
      ['Part'],
    );
  });
});

describe('links', () => {
  it('a published doc → its page, with the anchor kept', () => {
    assert.deepEqual(resolveDocLink('updates.md#building-a-release', 'operations/installers', published, 'ar'), { href: '/ar/docs/operations/updates/#building-a-release', external: false });
    assert.deepEqual(resolveDocLink('../operations/updates.md', 'features/sso', published, 'en'), { href: '/en/docs/operations/updates/', external: false });
    assert.deepEqual(resolveDocLink('features/sso.md', 'getting-started', published, 'en'), { href: '/en/docs/features/sso/', external: false });
  });

  it('an unpublished doc or a source file → plain text', () => {
    assert.equal(resolveDocLink('../roadmap/status.md', 'features/sso', published, 'en'), null);
    assert.equal(resolveDocLink('../architecture/engine-sensor.md', 'features/capabilities', published, 'en'), null);
    assert.equal(resolveDocLink('../../apps/web/lib/csp.ts', 'security/model', published, 'en'), null);
    assert.equal(resolveDocLink('/etc/passwd', 'security/model', published, 'en'), null);
    assert.equal(resolveDocLink('//evil.example/x.md', 'security/model', published, 'en'), null);
  });

  it('http(s) and mailto stay, with rel=noopener', () => {
    assert.deepEqual(resolveDocLink('https://developer.android.com/work', 'features/android', published, 'en'), { href: 'https://developer.android.com/work', external: true });
    const { html } = render('[x](https://example.com/a) and <https://example.org/b>');
    assert.match(html, /href="https:\/\/example.com\/a" rel="noopener noreferrer"/);
    assert.match(html, /href="https:\/\/example.org\/b" rel="noopener noreferrer"/);
  });

  it('every link in every rendered doc points to a published page, an anchor, or http(s)/mailto', () => {
    for (const d of docs) {
      const { html } = renderDoc(d, published, 'en');
      for (const m of html.matchAll(/href="([^"]*)"/g)) {
        const href = m[1]!;
        if (/^(https?:|mailto:)/.test(href) || href.startsWith('#')) continue;
        const target = /^\/en\/docs\/(.+?)\/(#.*)?$/.exec(href);
        assert.ok(target && published.has(target[1]!), `${d.slug}: ${href}`);
      }
    }
  });

  it('anchors in links between docs exist on the target page', () => {
    const ids = new Map(docs.map((d) => [d.slug, new Set(renderDoc(d, published, 'en').headings.map((h) => h.id))]));
    for (const d of docs) {
      for (const m of renderDoc(d, published, 'en').html.matchAll(/href="\/en\/docs\/(.+?)\/#([^"]+)"/g)) {
        assert.ok(ids.get(m[1]!)?.has(decodeURIComponent(m[2]!)), `${d.slug} → ${m[1]}#${m[2]}`);
      }
    }
  });
});

describe('anchors', () => {
  it('match GitHub: lower case, punctuation removed, spaces to dashes, repeats numbered', () => {
    const s = new Slugger();
    assert.equal(s.slug('Building a release'), 'building-a-release');
    assert.equal(s.slug('Engine and Sensor in one executable: what an older install sees'), 'engine-and-sensor-in-one-executable-what-an-older-install-sees');
    assert.equal(s.slug('Desktop app: NSIS'), 'desktop-app-nsis');
    assert.equal(s.slug('Desktop app: NSIS'), 'desktop-app-nsis-1');
    assert.equal(s.slug('`PROGRAMS` (MSI)'), 'programs-msi');
  });
});

describe('search', () => {
  const en = [...guideSearchEntries('en'), ...docSearchEntries(docs, 'en')];
  const ar = [...guideSearchEntries('ar'), ...docSearchEntries(docs, 'ar')];

  it('finds the updates doc by its words', () => {
    const hits = searchDocs(en, 'Ed25519 manifest');
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => h.href.startsWith('/en/docs/operations/updates/')));
  });

  it('needs every word, and at least two letters', () => {
    assert.deepEqual(searchDocs(en, 'x'), []);
    assert.deepEqual(searchDocs(en, 'zzqqxx'), []);
  });

  it('finds Arabic guide text on the Arabic site, with or without the article and hamza', () => {
    const hits = searchDocs(ar, 'الراوتر');
    assert.ok(hits.some((h) => h.href === '/ar/docs/guide/routers/' || h.href.startsWith('/ar/docs/guide/routers/#')));
    assert.ok(searchDocs(ar, 'راوتر').length > 0);
    assert.ok(hits.every((h) => h.lang === 'ar' || h.lang === 'en'));
  });

  it('marks English-only docs as English on the Arabic site', () => {
    const doc = ar.find((e) => e.href.startsWith('/ar/docs/operations/updates/'));
    assert.equal(doc?.lang, 'en');
    const guide = ar.find((e) => e.href.startsWith('/ar/docs/guide/'));
    assert.equal(guide?.lang, 'ar');
  });

  it('the guide has the same sections in both languages', () => {
    assert.deepEqual(
      guideFor('ar').map((s) => s.id),
      guideFor('en').map((s) => s.id),
    );
  });
});
