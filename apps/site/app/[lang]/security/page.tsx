import type { Metadata } from 'next';
import { Ltr } from '../../../components/brand.tsx';
import { S } from '../../../lib/content/strings.ts';
import { listDocs, renderDoc } from '../../../lib/docs.ts';
import { type Lang, href } from '../../../lib/i18n.ts';

type Params = { params: Promise<{ lang: Lang }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang } = await params;
  return { title: S.securityH[lang], description: S.securityLead[lang] };
}

export default async function Security({ params }: Params) {
  const { lang } = await params;
  const docs = listDocs();
  const model = docs.find((d) => d.slug === 'security/model');
  if (!model) throw new Error('docs/security/model.md is missing');
  const rendered = renderDoc(model, new Set(docs.map((d) => d.slug)), lang);
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>{S.securityH[lang]}</h1>
        <p className="lead">{S.securityLead[lang]}</p>
      </div>
      <section className="section" style={{ paddingBlock: 24 }} aria-labelledby="privacy-h">
        <h2 id="privacy-h" style={{ fontSize: 24 }}>
          {S.privacyH[lang]}
        </h2>
        <ul className="feature-list">
          {S.privacy.map((p) => (
            <li key={p.en}>{p[lang]}</li>
          ))}
        </ul>
        <h2 style={{ fontSize: 20, marginTop: 24 }}>{S.reportH[lang]}</h2>
        <p>
          {S.report[lang]} <Ltr code>SECURITY.md</Ltr>
        </p>
      </section>
      <section aria-labelledby="model-h">
        {lang === 'ar' ? (
          <p className="note">
            <span className="badge badge-unknown">{S.englishOnly.ar}</span> {S.englishOnlyNote.ar}
          </p>
        ) : null}
        <div lang="en" dir="ltr">
          <h2 id="model-h" style={{ fontSize: 28 }}>
            {model.title}
          </h2>
          <p className="doc-meta">
            {S.docsSource.en}: <Ltr code>{model.source}</Ltr> · <a href={href(lang, 'docs/security/review-2026-11')}>Source review, November 2026</a>
          </p>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it with html:false escapes raw HTML, and lib/docs.ts rewrites every link (tests/unit/docs.test.ts) */}
          <div className="prose" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>
      </section>
    </div>
  );
}
