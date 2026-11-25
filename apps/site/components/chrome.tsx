import { type Lang, href, pick } from '../lib/i18n.ts';
import { S } from '../lib/content/strings.ts';
import { Logo } from './brand.tsx';
import { LangSwitch } from './lang-switch.tsx';
import { ThemeSwitch } from './theme.tsx';

export function Header({ lang }: { lang: Lang }) {
  const t = (k: keyof typeof S) => pick(S[k] as { en: string; ar: string }, lang);
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <a href={href(lang)} className="brand-link" aria-label={`Nigafiy, ${lang === 'ar' ? 'الصفحة الرئيسية' : 'home'}`}>
          <Logo />
        </a>
        <nav aria-label={t('navLabel')} className="site-nav">
          <a href={href(lang, '#programs')}>{t('navPrograms')}</a>
          <a href={href(lang, 'downloads')}>{t('navDownloads')}</a>
          <a href={href(lang, 'docs')}>{t('navDocs')}</a>
          <a href={href(lang, 'security')}>{t('navSecurity')}</a>
        </nav>
        <div className="header-tools">
          <ThemeSwitch labels={{ group: t('theme'), system: t('themeSystem'), light: t('themeLight'), dark: t('themeDark') }} />
          <LangSwitch lang={lang} label={t('otherLang')} title={t('otherLangLabel')} />
          <a href={href(lang, 'downloads')} className="btn btn-primary btn-small">
            {t('download')}
          </a>
        </div>
      </div>
    </header>
  );
}

export function Footer({ lang }: { lang: Lang }) {
  const t = (k: keyof typeof S) => pick(S[k] as { en: string; ar: string }, lang);
  return (
    <footer className="site-footer">
      <div className="wrap footer-row">
        <div className="footer-tag">
          <p>{t('footTag')}</p>
          <p className="muted small">{t('footNoTracking')}</p>
        </div>
        <nav aria-label={t('navFooter')} className="footer-nav">
          <a href={href(lang, 'changelog')}>{t('navChangelog')}</a>
          <a href={href(lang, 'security')}>{t('navSecurity')}</a>
          <a href={href(lang, 'release-manifest')}>{t('navManifest')}</a>
          <a href={href(lang, 'docs')}>{t('navDocs')}</a>
          <a href={href(lang, 'downloads')}>{t('navDownloads')}</a>
        </nav>
      </div>
    </footer>
  );
}
