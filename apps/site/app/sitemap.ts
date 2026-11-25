import type { MetadataRoute } from 'next';
import { COMPANION_ORDER, PROGRAM_ORDER } from '../lib/content/programs.ts';
import { listDocs } from '../lib/docs.ts';
import { guideFor } from '../lib/guide.ts';
import { LANGS, href } from '../lib/i18n.ts';
import { SITE_URL } from '../lib/site.ts';

export const dynamic = 'force-static';

/** Every page in both languages (SITE_URL: lib/site.ts). */
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    '',
    'downloads',
    'docs',
    'changelog',
    'security',
    'release-manifest',
    ...[...PROGRAM_ORDER, ...COMPANION_ORDER].map((id) => `programs/${id}`),
    ...guideFor('en').map((s) => `docs/guide/${s.id}`),
    ...listDocs().map((d) => `docs/${d.slug}`),
  ];
  return paths.map((p) => ({
    url: `${SITE_URL}${href('en', p)}`,
    alternates: { languages: Object.fromEntries(LANGS.map((l) => [l, `${SITE_URL}${href(l, p)}`])) },
  }));
}
