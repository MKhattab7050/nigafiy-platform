/**
 * Minimal, safe markdown for knowledge articles.
 *
 * The parser turns plain text into a small tree of known node types. It never produces HTML:
 * the view (markdown-view.tsx) maps each node to a React element, and React escapes every text
 * node. Raw HTML in the source stays literal text. Links are kept only for http(s), mailto and
 * in-app paths ("/incidents/…"); anything else (javascript:, data:, vbscript:, //host, …) is text.
 *
 * Supported: # / ## / ### headings, paragraphs, "- " / "* " bullet lists, "1. " numbered lists,
 * "> " quotes, ``` fenced code blocks, **bold**, *italic* / _italic_, `code`, [text](url).
 *
 * Lives in @lan-detective/shared-types (an ES module package) so both the web view and the API
 * test suite compile it: imported as "@lan-detective/shared-types/markdown". It has no imports.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; external: boolean; children: Inline[] };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; text: string };

const MAX_SOURCE = 50_000;
const MAX_DEPTH = 4;

/** The URL a link may point to, or null when it is not allowed. */
export function safeHref(raw: string): { href: string; external: boolean } | null {
  // Browsers ignore control characters and whitespace inside a scheme ("java\tscript:"): reject them outright.
  if (/[\u0000- \u007f-\u009f]/.test(raw)) return null;
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) return { href: raw, external: false };
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    if (!/^https?:\/\/[^/\\]/i.test(raw)) return null;
    return { href: raw, external: true };
  }
  if (scheme === 'mailto') return { href: raw, external: true };
  return null;
}

function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#>!-]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_DEPTH && ch === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'strong', children: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (depth < MAX_DEPTH && (ch === '*' || ch === '_') && src[i + 1] !== ch && src[i + 1] !== ' ') {
      const end = src.indexOf(ch, i + 1);
      // `_` inside words (snake_case identifiers) is not emphasis.
      const wordBefore = ch === '_' && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1]!);
      const wordAfter = ch === '_' && end > 0 && end + 1 < src.length && /[\p{L}\p{N}]/u.test(src[end + 1]!);
      if (end > i + 1 && src[end - 1] !== ' ' && !wordBefore && !wordAfter) {
        flush();
        out.push({ type: 'em', children: parseInline(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close > i + 1 && src[close + 1] === '(') {
        const end = src.indexOf(')', close + 2);
        if (end > close + 2) {
          const label = src.slice(i + 1, close);
          const target = safeHref(src.slice(close + 2, end).trim());
          if (target) {
            flush();
            out.push({ type: 'link', href: target.href, external: target.external, children: depth < MAX_DEPTH ? parseInline(label, depth + 1) : [{ type: 'text', text: label }] });
            i = end + 1;
            continue;
          }
          // Not an allowed link: keep only the label, as text.
          text += label;
          i = end + 1;
          continue;
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.slice(0, MAX_SOURCE).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line.startsWith('```')) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) body.push(lines[i++]!);
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (!line) {
      flushPara();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, children: parseInline(heading[2]!) });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      const items: Inline[][] = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j]!.trim();
        const m = ordered ? /^\d{1,3}[.)]\s+(.*)$/.exec(l) : /^[-*]\s+(.*)$/.exec(l);
        if (!m) break;
        items.push(parseInline(m[1]!));
        j++;
      }
      blocks.push({ type: 'list', ordered, items });
      i = j - 1;
      continue;
    }
    if (line.startsWith('>')) {
      flushPara();
      const quote: string[] = [];
      let j = i;
      while (j < lines.length && lines[j]!.trim().startsWith('>')) quote.push(lines[j++]!.trim().replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', children: parseInline(quote.join(' ')) });
      i = j - 1;
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

/** Plain text of a document (for previews and excerpts). */
export function markdownToText(source: string): string {
  const inline = (xs: Inline[]): string => xs.map((x) => (x.type === 'text' || x.type === 'code' ? x.text : inline(x.children))).join('');
  return parseMarkdown(source)
    .map((b) => (b.type === 'code' ? b.text : b.type === 'list' ? b.items.map(inline).join(' · ') : inline(b.children)))
    .join(' ')
    .trim();
}
