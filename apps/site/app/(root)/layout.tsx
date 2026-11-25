import type { Metadata } from 'next';
import { THEME_SCRIPT } from '../../components/theme.tsx';
import { SITE_URL } from '../../lib/site.ts';
import '../globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Nigafiy',
  description: 'Nigafiy: the network and IT platform that runs on your own machines. · Nigafiy: منصة الشبكات وتقنية المعلومات التي تعمل على أجهزتك أنت.',
  icons: { icon: '/icon.svg' },
  openGraph: { siteName: 'Nigafiy', images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Nigafiy' }] },
};

/** The bare address "/": a page that offers both languages (a static site cannot redirect by header). */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed first-party string (components/theme.tsx) */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
