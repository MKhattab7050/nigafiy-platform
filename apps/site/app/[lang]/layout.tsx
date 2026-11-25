import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { Footer, Header } from '../../components/chrome.tsx';
import { THEME_SCRIPT } from '../../components/theme.tsx';
import { S } from '../../lib/content/strings.ts';
import { LANGS, dirOf, isLang } from '../../lib/i18n.ts';
import { SITE_URL } from '../../lib/site.ts';
import '../globals.css';

export const dynamicParams = false;
export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = isLang(lang) ? lang : 'en';
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: 'Nigafiy', template: '%s · Nigafiy' },
    description: S.lead[l],
    openGraph: { siteName: 'Nigafiy', images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Nigafiy' }], locale: l === 'ar' ? 'ar' : 'en' },
    icons: { icon: '/icon.svg' },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111418' },
  ],
};

export default async function LangLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return (
    <html lang={lang} dir={dirOf(lang)} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed first-party string (components/theme.tsx) */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          {S.skip[lang]}
        </a>
        <Header lang={lang} />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <Footer lang={lang} />
      </body>
    </html>
  );
}
