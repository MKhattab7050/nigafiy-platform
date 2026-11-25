import { PROGRAMS_BRAND, type ProgramId } from '@nigafiy/brand';
import type { Metadata } from 'next';
import { ProgramIcon } from '../../../../components/brand.tsx';
import { COMPANION_ORDER, PROGRAMS, PROGRAM_ORDER } from '../../../../lib/content/programs.ts';
import { S } from '../../../../lib/content/strings.ts';
import { listDocs } from '../../../../lib/docs.ts';
import { LANGS, type Lang, href } from '../../../../lib/i18n.ts';
import { hasShot, shotSrc } from '../../../../lib/shots.ts';

const IDS: readonly ProgramId[] = [...PROGRAM_ORDER, ...COMPANION_ORDER];
// Filled buttons carry white text: the same AA-safe fills the programs use (apps/web/app/globals.css).
const BUTTON_FILL: Partial<Record<ProgramId, string>> = { watch: '#a0650a' };

export const dynamicParams = false;
export function generateStaticParams() {
  return LANGS.flatMap((lang) => IDS.map((id) => ({ lang, id })));
}

type Params = { params: Promise<{ lang: Lang; id: ProgramId }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { lang, id } = await params;
  return { title: PROGRAMS_BRAND[id].name, description: PROGRAMS[id].summary[lang], alternates: { languages: { en: href('en', `programs/${id}`), ar: href('ar', `programs/${id}`) } } };
}

export default async function ProgramPage({ params }: Params) {
  const { lang, id } = await params;
  const p = PROGRAMS[id];
  const brand = PROGRAMS_BRAND[id];
  const docTitles = new Map(listDocs().map((d) => [d.slug, d.title]));
  const shots = p.shots.filter((s) => hasShot(lang, s.file));
  const getIt = id === 'agent' ? 'downloads#agent' : id === 'sensor' ? 'downloads#sensor' : id === 'hub' ? 'downloads#bundle-files' : `downloads#program-${id}`;
  const style = { '--accent': brand.accent, '--accent-btn': BUTTON_FILL[id] ?? brand.accentButton ?? brand.accent } as React.CSSProperties;
  return (
    <div style={style} data-program={id}>
      <div className="wrap page-head">
        <div className="program-head">
          <ProgramIcon id={id} size={72} />
          <div>
            <p className="job">{p.job[lang]}</p>
            <h1>{brand.name}</h1>
          </div>
        </div>
        <p className="lead" style={{ marginTop: 16 }}>
          {p.intro[lang]}
        </p>
        <p style={{ marginTop: 20 }}>
          <a href={href(lang, getIt)} className="btn btn-primary btn-small">
            {S.getIt[lang]}
          </a>
        </p>
      </div>

      <div className="wrap split section" style={{ paddingTop: 24 }}>
        <section aria-labelledby="does-h">
          <h2 id="does-h" style={{ fontSize: 24 }}>
            {S.whatItDoes[lang]}
          </h2>
          <ul className="feature-list">
            {p.features.map((f) => (
              <li key={f.en}>{f[lang]}</li>
            ))}
          </ul>
        </section>
        <div>
          <section aria-labelledby="needs-h">
            <h2 id="needs-h" style={{ fontSize: 24 }}>
              {S.whatItNeeds[lang]}
            </h2>
            <ul className="feature-list">
              {p.needs.map((n) => (
                <li key={n.en}>{n[lang]}</li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="unverified-h" className="note note-warn">
            <h2 id="unverified-h" className="note-title" style={{ fontSize: 16 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3l10 18H2zM12 10v5M12 18v.01" />
              </svg>
              {S.notVerifiedH[lang]}
            </h2>
            {p.unverified.length ? p.unverified.map((u) => <p key={u.en}>{u[lang]}</p>) : <p>{S.allVerified[lang]}</p>}
          </section>
          {p.docs.length ? (
            <section aria-labelledby="docs-h" style={{ marginTop: 24 }}>
              <h2 id="docs-h" style={{ fontSize: 18 }}>
                {S.moreDocs[lang]}
              </h2>
              <ul className="chips">
                {p.docs
                  .filter((slug) => docTitles.has(slug))
                  .map((slug) => (
                    <li key={slug}>
                      <a href={href(lang, `docs/${slug}`)} lang={lang === 'ar' ? 'en' : undefined}>
                        {docTitles.get(slug)}
                      </a>
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>

      <section className="wrap" aria-labelledby="shots-h">
        <h2 id="shots-h" style={{ fontSize: 24 }}>
          {S.screenshotsH[lang]}
        </h2>
        {shots.length ? (
          <>
            <p className="muted small">{S.screenshotsNote[lang]}</p>
            <div className="shots">
              {shots.map((s) => (
                <figure key={s.file}>
                  <div className="shot">
                    {/* biome-ignore lint/performance/noImgElement: a static export with a fixed-size PNG; next/image would add nothing without its optimizer */}
                    <img src={shotSrc(lang, s.file)} alt={`${brand.name}: ${s.caption[lang]}`} width={1440} height={900} loading="lazy" />
                  </div>
                  <figcaption>{s.caption[lang]}</figcaption>
                </figure>
              ))}
            </div>
          </>
        ) : (
          <p className="muted">{S.noScreenshots[lang]}</p>
        )}
      </section>
    </div>
  );
}
