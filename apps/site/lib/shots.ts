// Which screenshots exist (public/screenshots/<lang>/<file>), so a page never shows a broken image.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Lang } from './i18n.ts';
import { SITE_DIR } from './paths.ts';

export function hasShot(lang: Lang, file: string): boolean {
  return existsSync(path.join(SITE_DIR, 'public', 'screenshots', lang, file));
}

export const shotSrc = (lang: Lang, file: string) => `/screenshots/${lang}/${file}`;
