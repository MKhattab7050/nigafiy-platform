// Client-side docs search over the index written at build time (/<lang>/docs/search-index.json).
// Matching folds case, accents and the Arabic letter forms the same way the in-app guide does
// (apps/web/features/guide/search.ts). Pure functions, so the unit tests run them directly.
import { normalize, tokenize } from '../../web/features/guide/search.ts';
import type { SearchEntry } from './docs.ts';

export interface SearchHit extends SearchEntry {
  score: number;
  snippet: string;
}

const AR_PREFIXES = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ب', 'ل', 'ف', 'ك'];

function wordMatches(word: string, q: string): boolean {
  if (word.startsWith(q)) return true;
  for (const p of AR_PREFIXES) if (word.length > p.length && word.startsWith(p) && word.slice(p.length).startsWith(q)) return true;
  return q.length >= 3 && word.includes(q);
}

function fieldScore(words: string[], q: string): boolean {
  return words.some((w) => wordMatches(w, q));
}

/** The best entries for a query: every query word must appear in the title, the heading or the text. */
export function searchDocs(entries: readonly SearchEntry[], query: string, limit = 20): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || normalize(query).trim().length < 2) return [];
  const hits: SearchHit[] = [];
  for (const e of entries) {
    const title = tokenize(e.title);
    const heading = tokenize(e.heading);
    const text = tokenize(e.text);
    let score = 0;
    let all = true;
    for (const q of terms) {
      const s = (fieldScore(title, q) ? 6 : 0) + (fieldScore(heading, q) ? 4 : 0) + (fieldScore(text, q) ? 1 : 0);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (all) hits.push({ ...e, score, snippet: snippetOf(e.text, terms) });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

/** About 160 characters of the text around the first query word. */
export function snippetOf(text: string, terms: readonly string[]): string {
  const norm = normalize(text);
  let at = -1;
  for (const t of terms) {
    const i = norm.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  // normalize() keeps the length of most text; fall back to the start when it does not line up.
  if (at < 0 || norm.length !== text.length) at = 0;
  const start = Math.max(0, at - 60);
  const s = text.slice(start, start + 160).trim();
  return (start > 0 ? '… ' : '') + s + (start + 160 < text.length ? ' …' : '');
}
