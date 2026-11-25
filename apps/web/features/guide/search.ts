// Client-side search over the guide, in both languages at once: a word typed in English finds the
// section on an Arabic screen too (and the other way round), and the hit is shown in the reader's
// language. Pure functions, no runtime imports (guide.test.ts runs them under node --test).
import type { GuideBlock, GuideContent, GuideSection, GuideSectionId } from './types.ts';

/**
 * Folds the differences a searcher should not have to type: case, Latin accents, Arabic
 * diacritics and tatweel, the alef forms (أ إ آ ٱ → ا), alef maqsura (ى → ي), taa marbuta (ة → ه)
 * and Arabic-Indic digits (٠–٩ → 0–9).
 */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[ً-ٰٟۖ-ۭـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Words of at least one letter or digit. */
export const tokenize = (text: string): string[] => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Arabic attaches "and", "the", "with", "for" to the word: a query word also matches after these. */
const AR_PREFIXES = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ب', 'ل', 'ف', 'ك'];

function wordMatches(word: string, query: string): boolean {
  if (word.startsWith(query)) return true;
  for (const p of AR_PREFIXES) if (word.length > p.length && word.startsWith(p) && word.slice(p.length).startsWith(query)) return true;
  // Inside a longer word (for example "wi" in "wi-fi" is already a word; "router" in "routers"): only for 3+ characters.
  return query.length >= 3 && word.includes(query);
}

const blockText = (b: GuideBlock): string => {
  switch (b.kind) {
    case 'h':
    case 'p':
    case 'note':
      return b.text;
    case 'steps':
    case 'list':
      return b.items.join('\n');
    case 'table':
      return [b.head.join(' '), ...b.rows.map((r) => r.join(' '))].join('\n');
  }
};

interface Indexed {
  section: GuideSection;
  title: string[];
  summary: string[];
  headings: string[];
  body: string[];
  /** Plain sentences, for the snippet. */
  sentences: string[];
}

function index(section: GuideSection): Indexed {
  const texts = section.blocks.map(blockText);
  return {
    section,
    title: tokenize(section.title),
    summary: tokenize(section.summary),
    headings: section.blocks.flatMap((b) => (b.kind === 'h' ? tokenize(b.text) : [])),
    body: tokenize(texts.join('\n')),
    sentences: texts
      .flatMap((t) => t.split(/\n|(?<=[.!?؟])\s+/))
      .map((s) => s.replace(/`/g, '').trim())
      .filter(Boolean),
  };
}

/** Score of one query word in one section (0: not there). Title counts most, body least. */
function wordScore(doc: Indexed, q: string): number {
  if (doc.title.some((w) => wordMatches(w, q))) return 8;
  if (doc.headings.some((w) => wordMatches(w, q))) return 4;
  if (doc.summary.some((w) => wordMatches(w, q))) return 3;
  if (doc.body.some((w) => wordMatches(w, q))) return 1;
  return 0;
}

export interface GuideHit {
  id: GuideSectionId;
  title: string;
  /** A sentence of the section in the reader's language that contains a query word, else the summary. */
  snippet: string;
  /** Anchor of the first sub-heading that contains a query word, if any. */
  anchor?: string;
  score: number;
}

export interface GuideSearchIndex {
  query: (text: string, limit?: number) => GuideHit[];
}

/**
 * Builds the index once. `display` is the reader's language (titles and snippets come from it);
 * `others` are searched too, so a section matches in whichever language holds every query word.
 */
export function buildGuideIndex(display: GuideContent, others: readonly GuideContent[] = []): GuideSearchIndex {
  const shown = display.map(index);
  const extra = others.map((c) => c.map(index));
  return {
    query(text, limit = 20) {
      const words = [...new Set(tokenize(text))];
      if (!words.length) return [];
      const hits: GuideHit[] = [];
      shown.forEach((doc, i) => {
        const docs = [doc, ...extra.map((c) => c.find((d) => d.section.id === doc.section.id) ?? c[i]).filter((d): d is Indexed => Boolean(d))];
        // A section matches when one of its languages contains every query word.
        let score = 0;
        for (const d of docs) {
          const scores = words.map((w) => wordScore(d, w));
          if (scores.every((s) => s > 0)) score = Math.max(score, scores.reduce((a, b) => a + b, 0));
        }
        if (!score) return;
        const matches = (s: string) => {
          const tokens = tokenize(s);
          return words.some((q) => tokens.some((w) => wordMatches(w, q)));
        };
        const snippet = doc.sentences.find(matches) ?? doc.section.summary;
        const heading = doc.section.blocks.find((b): b is Extract<GuideBlock, { kind: 'h' }> => b.kind === 'h' && matches(b.text));
        hits.push({ id: doc.section.id, title: doc.section.title, snippet, anchor: heading?.id, score });
      });
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}
