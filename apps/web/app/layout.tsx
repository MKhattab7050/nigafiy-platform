import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import { ThemeProvider } from '@/lib/theme';
import { THEME_BOOT_SCRIPT } from '@/lib/theme-boot';
import { I18nProvider } from '@/lib/i18n';
import './globals.css';

// One type family across scripts: IBM Plex Sans (Latin), Plex Sans Arabic and Plex Mono share the
// same skeleton, so English, Arabic and addresses sit together without a seam.
const plex = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-plex', display: 'swap' });
const arabic = IBM_Plex_Sans_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600', '700'], variable: '--font-arabic', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Nigafiy', template: '%s · Nigafiy' },
  description: 'Know your network. Understand every incident.',
};
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b1016' },
    { media: '(prefers-color-scheme: light)', color: '#f2f4f7' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = (await cookies()).get('ld_locale')?.value === 'ar' ? 'ar' : 'en';
  // Set by proxy.ts; the Content-Security-Policy only lets nonce-stamped inline scripts run.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    // The boot script sets data-theme before the first paint; React must accept that attribute.
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} className={`${plex.variable} ${arabic.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from lib/theme-boot.ts, no user input; nonce-checked by the CSP. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh text-sm">
        <ThemeProvider>
          <I18nProvider initialLocale={locale}>{children}</I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
