'use client';
import { usePathname } from 'next/navigation';
import type { Lang } from '../lib/i18n.ts';

/** The same page in the other language. */
export function LangSwitch({ lang, label, title }: { lang: Lang; label: string; title: string }) {
  const pathname = usePathname() ?? `/${lang}/`;
  const other: Lang = lang === 'en' ? 'ar' : 'en';
  const target = pathname.replace(/^\/(en|ar)(?=\/|$)/, `/${other}`);
  return (
    <a href={target.endsWith('/') ? target : `${target}/`} hrefLang={other} lang={other} className="lang-switch" title={title}>
      {label}
    </a>
  );
}
