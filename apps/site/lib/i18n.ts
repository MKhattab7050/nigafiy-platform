// The site's two languages. Every user-visible string exists in both (lib/content/*).
export const LANGS = ['en', 'ar'] as const;
export type Lang = (typeof LANGS)[number];

export function isLang(v: string): v is Lang {
  return (LANGS as readonly string[]).includes(v);
}

export const dirOf = (lang: Lang): 'ltr' | 'rtl' => (lang === 'ar' ? 'rtl' : 'ltr');

/** A text in both languages. */
export type T = { readonly en: string; readonly ar: string };

export const pick = (t: T, lang: Lang): string => t[lang];

/** An internal link with the language prefix and the trailing slash the static export uses. */
export function href(lang: Lang, path = ''): string {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const [p, hash] = clean.split('#') as [string, string | undefined];
  const base = p ? `/${lang}/${p}/` : `/${lang}/`;
  return hash ? `${base}#${hash}` : base;
}
