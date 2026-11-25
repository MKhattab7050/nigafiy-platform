// The in-app user guide (apps/web/features/guide), published in the docs section. It is the one
// part of the docs written in both languages, so the Arabic site shows it in Arabic.
// The content files only import types, so this module also runs under node --test.
import { GUIDE_AR } from '../../web/features/guide/content/ar.ts';
import { GUIDE_EN } from '../../web/features/guide/content/en.ts';
import type { GuideBlock, GuideContent, GuideSection } from '../../web/features/guide/types.ts';
import type { Lang } from './i18n.ts';
import type { SearchEntry } from './docs.ts';

export type { GuideBlock, GuideSection };

export const guideFor = (lang: Lang): GuideContent => (lang === 'ar' ? GUIDE_AR : GUIDE_EN);

export const GUIDE_GROUP_LABEL: Record<GuideSection['group'], { en: string; ar: string }> = {
  start: { en: 'Start here', ar: 'ابدأ من هنا' },
  tasks: { en: 'Common tasks', ar: 'مهام شائعة' },
  programs: { en: 'The programs', ar: 'البرامج' },
  help: { en: 'When something is wrong', ar: 'عندما يحدث خطأ' },
};

/** Plain text of a block (backticks removed), for search. */
export function blockText(b: GuideBlock): string {
  const strip = (s: string) => s.replace(/`/g, '');
  switch (b.kind) {
    case 'h':
    case 'p':
    case 'note':
      return strip(b.text);
    case 'steps':
    case 'list':
      return b.items.map(strip).join(' ');
    case 'table':
      return [...b.head, ...b.rows.flat()].map(strip).join(' ');
  }
}

/** One search entry per sub-heading of every guide section. */
export function guideSearchEntries(lang: Lang): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const section of guideFor(lang)) {
    let cur: SearchEntry = { href: `/${lang}/docs/guide/${section.id}/`, title: section.title, heading: '', text: section.summary, lang };
    const flush = () => {
      if (cur.text.trim() || cur.heading) out.push({ ...cur, text: cur.text.replace(/\s+/g, ' ').trim().slice(0, 1500) });
    };
    for (const b of section.blocks) {
      if (b.kind === 'h') {
        flush();
        cur = { href: `/${lang}/docs/guide/${section.id}/#${b.id}`, title: section.title, heading: b.text, text: '', lang };
      } else {
        cur.text += ` ${blockText(b)}`;
      }
    }
    flush();
  }
  return out;
}
