import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import { cookies } from 'next/headers';
import { I18nProvider } from '@/lib/i18n';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const arabic = IBM_Plex_Sans_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600'], variable: '--font-arabic', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'LAN Detective', template: '%s · LAN Detective' },
  description: 'Know your network. Understand every incident.',
};
export const viewport: Viewport = { themeColor: '#070d1a', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = (await cookies()).get('ld_locale')?.value === 'ar' ? 'ar' : 'en';
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} className={`${inter.variable} ${arabic.variable} ${mono.variable}`}>
      <body className="min-h-dvh text-sm">
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
