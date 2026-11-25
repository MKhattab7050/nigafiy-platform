import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Ltr } from '../../../../components/brand.tsx';
import { DocsNav } from '../../../../components/docs-nav.tsx';
import { GuideBody } from '../../../../components/guide-section.tsx';
import { S } from '../../../../lib/content/strings.ts';
import { listDocs, renderDoc } from '../../../../lib/docs.ts';
import { guideFor } from '../../../../lib/guide.ts';
import { LANGS, type Lang } from '../../../../lib/i18n.ts';

type Params = { params: Promise<{ lang: Lang; slug: string[] }> };

export const dynamicParams = false;
export function generateStaticParams() {
  const docs = listDocs();
  return LANGS.flatMap((lang) => [...guideFor(lang).map((s) => ({ lang, slug: ['guide', s.id] })), ...docs.map((d) => ({ lang, slug: d.slug.split('/') }))]);
}

function find(lang: Lang, slug: string[]) {
  const key = slug.join('/');
  if (slug[0] === 'guide' && slug.length === 2) {
    const section = guideFor(lang).find((s) => s.id === slug[1]);
    return section ? ({ kind: 'guide', key, section } as const) : null;
  }
  const doc = listDocs().find((d) => d.slug === key);
  return doc ? ({ kind: 'doc', key, doc } as const) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang, slug } = await params;
  const f = find(lang, slug);
  if (!f) return {};
  return f.kind === 'guide' ? { title: f.section.title, description: f.section.summary } : { title: f.doc.title };
}

export default async function DocPage({ params }: Params) {
  const { lang, slug } = await params;
  const f = find(lang, slug);
  if (!f) notFound();
  const docs = listDocs();
  if (f.kind === 'guide') {
    return (
      <div className="wrap docs-layout">
        <DocsNav lang={lang} docs={docs} current={f.key} />
        <article className="doc-body">
          <h1>{f.section.title}</h1>
          <p className="muted">{f.section.summary}</p>
          <GuideBody section={f.section} inAppLabel={S.inAppLink[lang]} />
        </article>
      </div>
    );
  }
  const published = new Set(docs.map((d) => d.slug));
  const rendered = renderDoc(f.doc, published, lang);
  const toc = rendered.headings.filter((h) => h.level === 2);
  return (
    <div className="wrap docs-layout">
      <DocsNav lang={lang} docs={docs} current={f.key} />
      <article className="doc-body">
        {lang === 'ar' ? (
          <p className="note" style={{ marginTop: 0 }}>
            <span className="badge badge-unknown">{S.englishOnly.ar}</span> {S.englishOnlyNote.ar}
          </p>
        ) : null}
        <div lang="en" dir="ltr">
          <h1>{f.doc.title}</h1>
          <p className="doc-meta">
            <span>
              {S.docsSource.en}: <Ltr code>{f.doc.source}</Ltr>
            </span>
          </p>
          {toc.length > 2 ? (
            <nav className="toc" aria-label={S.onThisPage.en}>
              <strong>{S.onThisPage.en}</strong>
              <ul>
                {toc.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it with html:false escapes raw HTML, and lib/docs.ts rewrites every link (tests/unit/docs.test.ts) */}
          <div className="prose" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>
      </article>
    </div>
  );
}
