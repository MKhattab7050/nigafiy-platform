import { Logo } from '../../components/brand.tsx';
import { S } from '../../lib/content/strings.ts';

export default function LanguageChooser() {
  return (
    <main id="main" className="center-page">
      <Logo size={44} />
      <div className="pair">
        <section lang="en" dir="ltr">
          <h1>{S.h1.en}</h1>
          <p className="muted">{S.chooseLang.en}</p>
          <a href="/en/" hrefLang="en" className="btn btn-primary">
            English
          </a>
        </section>
        <section lang="ar" dir="rtl">
          <h2>{S.h1.ar}</h2>
          <p className="muted">{S.chooseLang.ar}</p>
          <a href="/ar/" hrefLang="ar" className="btn btn-primary">
            العربية
          </a>
        </section>
      </div>
    </main>
  );
}
