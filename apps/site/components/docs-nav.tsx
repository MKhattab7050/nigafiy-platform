import { S } from '../lib/content/strings.ts';
import { type DocFile, type DocGroup, GROUP_ORDER } from '../lib/docs.ts';
import { guideFor } from '../lib/guide.ts';
import { type Lang, href } from '../lib/i18n.ts';

const GROUP_LABEL: Record<DocGroup, keyof typeof S> = { start: 'groupStart', features: 'groupFeatures', operations: 'groupOperations', security: 'groupSecurity' };

/** The docs sidebar: the user guide (in the page's language) and the English-only technical docs. */
export function DocsNav({ lang, docs, current }: { lang: Lang; docs: readonly DocFile[]; current: string }) {
  const label = (k: keyof typeof S) => (S[k] as { en: string; ar: string })[lang];
  return (
    <nav className="docs-side" aria-label={label('docsNav')}>
      <h2>{label('groupGuide')}</h2>
      <ul>
        {guideFor(lang).map((s) => {
          const slug = `guide/${s.id}`;
          return (
            <li key={s.id}>
              <a href={href(lang, `docs/${slug}`)} aria-current={current === slug ? 'page' : undefined}>
                {s.title}
              </a>
            </li>
          );
        })}
      </ul>
      {GROUP_ORDER.map((g) => (
        <div key={g}>
          <h2>
            {label(GROUP_LABEL[g])}
            {lang === 'ar' ? <span className="sr-only"> ({label('englishOnly')})</span> : null}
          </h2>
          <ul lang={lang === 'ar' ? 'en' : undefined} dir={lang === 'ar' ? 'ltr' : undefined}>
            {docs
              .filter((d) => d.group === g)
              .map((d) => (
                <li key={d.slug}>
                  <a href={href(lang, `docs/${d.slug}`)} aria-current={current === d.slug ? 'page' : undefined}>
                    {d.title}
                  </a>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
