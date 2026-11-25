import type { Metadata } from 'next';
import { Logo } from '../components/brand.tsx';
import { THEME_SCRIPT } from '../components/theme.tsx';
import { S } from '../lib/content/strings.ts';
import './globals.css';

export const metadata: Metadata = { title: 'Page not found · الصفحة غير موجودة · Nigafiy', robots: { index: false } };

/** One 404 page for every unknown address, in English and Arabic side by side (static hosts serve 404.html). */
export default function GlobalNotFound() {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed first-party string (components/theme.tsx) */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <main id="main" className="center-page">
          <a href="/en/" className="brand-link" aria-label="Nigafiy">
            <Logo size={44} />
          </a>
          <div className="pair">
            <section lang="en" dir="ltr">
              <h1>{S.notFoundH.en}</h1>
              <p className="muted">{S.notFoundText.en}</p>
              <a href="/en/" className="btn btn-primary">
                {S.goHome.en}
              </a>
            </section>
            <section lang="ar" dir="rtl">
              <h2>{S.notFoundH.ar}</h2>
              <p className="muted">{S.notFoundText.ar}</p>
              <a href="/ar/" className="btn btn-primary">
                {S.goHome.ar}
              </a>
            </section>
          </div>
        </main>
      </body>
    </html>
  );
}
