import { PROGRAMS_BRAND } from '@nigafiy/brand';
import { ProgramIcon } from '../../components/brand.tsx';
import { COMPANION_ORDER, PILLARS, PROGRAMS, PROGRAM_ORDER } from '../../lib/content/programs.ts';
import { S } from '../../lib/content/strings.ts';
import { type Lang, href } from '../../lib/i18n.ts';
import { hasShot, shotSrc } from '../../lib/shots.ts';

export default async function Home({ params }: { params: Promise<{ lang: Lang }> }) {
  const { lang } = await params;
  const hero = hasShot(lang, 'hub-home.png');
  return (
    <>
      <section className="wrap hero" aria-labelledby="hero-h">
        <div className="hero-text">
          <h1 id="hero-h">{S.h1[lang]}</h1>
          <p className="lead">{S.lead[lang]}</p>
          <div className="hero-actions">
            <a href={href(lang, 'downloads')} className="btn btn-primary">
              {S.ctaDownload[lang]}
            </a>
            <a href={href(lang, 'downloads#bundle')} className="btn btn-secondary">
              {S.ctaChoose[lang]}
            </a>
          </div>
          <p className="muted small">{S.req[lang]}</p>
        </div>
        {hero ? (
          <figure className="hero-shot">
            <div className="shot">
              {/* biome-ignore lint/performance/noImgElement: a static export with a fixed-size PNG; next/image would add nothing without its optimizer */}
              <img src={shotSrc(lang, 'hub-home.png')} alt={S.heroShotAlt[lang]} width={1440} height={900} />
            </div>
            <figcaption>{S.screenshotsNote[lang]}</figcaption>
          </figure>
        ) : null}
      </section>

      <section className="band" aria-label={lang === 'ar' ? 'ما يميّز Nigafiy' : 'What makes Nigafiy different'}>
        <div className="wrap section pillars">
          {PILLARS.map((p) => (
            <div className="pillar" key={p.title.en}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={p.icon} />
              </svg>
              <h3>{p.title[lang]}</h3>
              <p>{p.text[lang]}</p>
            </div>
          ))}
          <div className="pillar">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h16M4 12h10M4 18h7M17 15l2 2 3-4" />
            </svg>
            <h3>{S.honestH[lang]}</h3>
            <p>{S.honest[lang]}</p>
          </div>
        </div>
      </section>

      <section className="wrap section" id="programs" aria-labelledby="family-h">
        <h2 id="family-h">{S.familyH[lang]}</h2>
        <p className="section-sub">{S.familySub[lang]}</p>
        <div className="cards">
          {PROGRAM_ORDER.map((id) => (
            <a key={id} href={href(lang, `programs/${id}`)} className="card">
              <ProgramIcon id={id} />
              <span className="card-title">{PROGRAMS_BRAND[id].name}</span>
              <span className="card-text">{PROGRAMS[id].summary[lang]}</span>
            </a>
          ))}
        </div>
        <h2 id="companions-h" style={{ marginTop: 48, fontSize: 24 }}>
          {S.companionsH[lang]}
        </h2>
        <p className="section-sub">{S.companionsSub[lang]}</p>
        <div className="cards">
          {COMPANION_ORDER.map((id) => (
            <a key={id} href={href(lang, `programs/${id}`)} className="card">
              <ProgramIcon id={id} />
              <span className="card-title">{PROGRAMS_BRAND[id].name}</span>
              <span className="card-text">{PROGRAMS[id].summary[lang]}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="band" aria-labelledby="bundle-h">
        <div className="wrap section split">
          <div>
            <h2 id="bundle-h">{S.bundleH[lang]}</h2>
            <p className="section-sub">{S.bundleSub[lang]}</p>
            <p style={{ marginTop: 20 }}>
              <a href={href(lang, 'downloads#bundle')} className="btn btn-primary">
                {S.bundleOpen[lang]}
              </a>
            </p>
          </div>
          <div>
            <h2 style={{ fontSize: 24 }}>{S.noAiH[lang]}</h2>
            <p className="section-sub">{S.noAi[lang]}</p>
          </div>
        </div>
      </section>
    </>
  );
}
