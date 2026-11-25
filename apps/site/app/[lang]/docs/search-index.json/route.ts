import { docSearchEntries, listDocs } from '../../../../lib/docs.ts';
import { guideSearchEntries } from '../../../../lib/guide.ts';
import { LANGS, isLang } from '../../../../lib/i18n.ts';

// Written once at build time: the client-side docs search reads this file (no search service).
export const dynamic = 'force-static';
export const dynamicParams = false;
export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ lang: string }> }) {
  const { lang: raw } = await params;
  const lang = isLang(raw) ? raw : 'en';
  return Response.json([...guideSearchEntries(lang), ...docSearchEntries(listDocs(), lang)]);
}
