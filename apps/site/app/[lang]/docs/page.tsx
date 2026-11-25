import type { Metadata } from 'next';
import { DocsNav } from '../../../components/docs-nav.tsx';
import { DocsSearch } from '../../../components/docs-search.tsx';
import { S } from '../../../lib/content/strings.ts';
import { GROUP_ORDER, listDocs } from '../../../lib/docs.ts';
import { GUIDE_GROUP_LABEL, guideFor } from '../../../lib/guide.ts';
import { type Lang, href } from '../../../lib/i18n.ts';

type Params = { params: Promise<{ lang: Lang }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang } = await params;
  return { title: S.docsH[lang], description: S.docsLead[lang] };
}

const GROUP_KEY = { start: 'groupStart', features: 'groupFeatures', operations: 'groupOperations', security: 'groupSecurity' } as const;

export default async function DocsIndex({ params }: Params) {
  const { lang } = await params;
  const docs = listDocs();
  const guide = guideFor(lang);
  return (
    <div className="wrap docs-layout">
      <DocsNav lang={lang} docs={docs} current="" />
      <div className="doc-body">
        <h1>{S.docsH[lang]}</h1>
        <p className="muted">{S.docsLead[lang]}</p>
        {lang === 'ar' ? <p>{S.docsLeadAr.ar}</p> : null}
        <DocsSearch
          lang={lang}
          text={{ label: S.docsSearch[lang], hint: S.docsSearchHint[lang], none: S.docsNoResults[lang], results: S.docsResults[lang], englishOnly: S.englishOnly[lang] }}
        />
        <section aria-labelledby="g-guide">
          <h2 id="g-guide">{S.groupGuide[lang]}</h2>
          {(['start', 'tasks', 'programs', 'help'] as const).map((g) => (
            <div key={g}>
              <h3>{GUIDE_GROUP_LABEL[g][lang]}</h3>
              <ul>
                {guide
                  .filter((s) => s.group === g)
                  .map((s) => (
                    <li key={s.id}>
                      <a href={href(lang, `docs/guide/${s.id}`)}>{s.title}</a> <span className="muted">— {s.summary}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>
        {GROUP_ORDER.map((g) => (
          <section key={g} aria-labelledby={`g-${g}`}>
            <h2 id={`g-${g}`}>
              {S[GROUP_KEY[g]][lang]}{' '}
              {lang === 'ar' ? (
                <span className="badge badge-unknown" style={{ verticalAlign: 'middle' }}>
                  {S.englishOnly.ar}
                </span>
              ) : null}
            </h2>
            <ul lang={lang === 'ar' ? 'en' : undefined} dir={lang === 'ar' ? 'ltr' : undefined}>
              {docs
                .filter((d) => d.group === g)
                .map((d) => (
                  <li key={d.slug}>
                    <a href={href(lang, `docs/${d.slug}`)}>{d.title}</a>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
