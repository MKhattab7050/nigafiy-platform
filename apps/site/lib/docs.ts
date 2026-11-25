// The docs section: the repository's user-facing markdown (docs/getting-started.md,
// docs/features, docs/operations, docs/security), read and rendered when the site is built.
// Internal plans and specs (docs/superpowers), the roadmap, the architecture notes and the design
// mockups are not published.
//
// Rendering is safe by construction: markdown-it with `html: false` escapes every raw HTML tag in
// the source, its link validator refuses javascript:, vbscript:, file: and data: URLs, links are
// rewritten here (another published doc → its page; http(s)/mailto kept; anything else, such as a
// source file or an unpublished doc, becomes plain text so no link goes nowhere) and images become
// their alt text.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { Lang } from './i18n.ts';
import { REPO_ROOT } from './paths.ts';

export type DocGroup = 'start' | 'features' | 'operations' | 'security';

export interface DocFile {
  /** URL path under /<lang>/docs/, e.g. "features/sso". */
  slug: string;
  group: DocGroup;
  title: string;
  /** Repository path, e.g. "docs/features/sso.md". */
  source: string;
  markdown: string;
}

export interface Heading {
  id: string;
  text: string;
  level: number;
}

export interface SearchEntry {
  href: string;
  title: string;
  heading: string;
  text: string;
  /** Language of the text ("en" for English-only docs on the Arabic site). */
  lang: Lang;
}

export interface RenderedDoc {
  html: string;
  headings: Heading[];
  sections: { id: string; heading: string; text: string }[];
}

export const DOCS_DIR = path.join(REPO_ROOT, 'docs');

/** What is published, relative to docs/. */
const PUBLISHED: readonly { dir: string; group: DocGroup }[] = [
  { dir: '', group: 'start' },
  { dir: 'features', group: 'features' },
  { dir: 'operations', group: 'operations' },
  { dir: 'security', group: 'security' },
];
/** Top-level files of docs/ that are published (the folder index README.md is not). */
const TOP_LEVEL = new Set(['getting-started.md']);

export const GROUP_ORDER: readonly DocGroup[] = ['start', 'features', 'operations', 'security'];

/** Every published doc, sorted by group then title. */
export function listDocs(docsDir = DOCS_DIR): DocFile[] {
  const out: DocFile[] = [];
  for (const { dir, group } of PUBLISHED) {
    const full = path.join(docsDir, dir);
    let names: string[];
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      if (dir === '' && !TOP_LEVEL.has(name)) continue;
      const file = path.join(full, name);
      if (!statSync(file).isFile()) continue;
      const markdown = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const slug = (dir ? `${dir}/` : '') + name.slice(0, -3);
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? slug;
      out.push({ slug, group, title: stripInlineMarkdown(title), source: `docs/${slug}.md`, markdown });
    }
  }
  return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.title.localeCompare(b.title));
}

function stripInlineMarkdown(s: string): string {
  return s.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** GitHub-style heading anchors, so links such as updates.md#building-a-release keep working. */
export class Slugger {
  private seen = new Map<string, number>();
  slug(text: string): string {
    const base =
      text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-') || 'section';
    const n = this.seen.get(base);
    this.seen.set(base, (n ?? 0) + 1);
    return n === undefined ? base : `${base}-${n}`;
  }
}

function inlineText(token: Token | undefined): string {
  if (!token?.children) return token?.content ?? '';
  return token.children
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('');
}

/** Where a link in `fromSlug` should go on the site, or null to render it as plain text. */
export function resolveDocLink(raw: string, fromSlug: string, published: ReadonlySet<string>, lang: Lang): { href: string; external: boolean } | null {
  const href = raw.trim();
  if (/^https?:\/\/[^/\\]/i.test(href) || /^mailto:/i.test(href)) return { href, external: true };
  if (href.startsWith('#')) return href.length > 1 ? { href, external: false } : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')) return null;
  const [pathPart = '', hash] = href.split('#') as [string, string | undefined];
  if (!pathPart.endsWith('.md')) return null;
  const fromDir = path.posix.dirname(fromSlug);
  const target = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, decodeURIComponent(pathPart))).replace(/\.md$/, '');
  if (!published.has(target)) return null;
  return { href: `/${lang}/docs/${target}/${hash ? `#${hash}` : ''}`, external: false };
}

/** Rewrites links and images in an inline token's children (see the file comment). */
function rewriteInline(children: Token[], fromSlug: string, published: ReadonlySet<string>, lang: Lang, TokenCtor: typeof Token): Token[] {
  const out: Token[] = [];
  const dropStack: boolean[] = [];
  for (const t of children) {
    if (t.type === 'link_open') {
      const target = resolveDocLink(t.attrGet('href') ?? '', fromSlug, published, lang);
      dropStack.push(target === null);
      if (target === null) continue;
      t.attrSet('href', target.href);
      if (target.external) t.attrSet('rel', 'noopener noreferrer');
      out.push(t);
    } else if (t.type === 'link_close') {
      if (!dropStack.pop()) out.push(t);
    } else if (t.type === 'image') {
      const text = new TokenCtor('text', '', 0);
      text.content = t.content || inlineText(t);
      out.push(text);
    } else {
      out.push(t);
    }
  }
  return out;
}

function makeRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.renderer.rules.table_open = () => '<div class="table-wrap" tabindex="0"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  return md;
}

/** Renders one doc for one language: HTML, its headings (for "On this page") and its text per section (for search). */
export function renderDoc(doc: Pick<DocFile, 'slug' | 'markdown'>, published: ReadonlySet<string>, lang: Lang): RenderedDoc {
  const md = makeRenderer();
  const env = {};
  const tokens = md.parse(doc.markdown, env);
  const slugger = new Slugger();
  const headings: Heading[] = [];
  const sections: RenderedDoc['sections'] = [{ id: '', heading: '', text: '' }];
  let droppedTitle = false;
  const kept: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === 'heading_open') {
      const text = inlineText(tokens[i + 1]);
      // The page shows the title itself; the markdown's first "# " heading is left out.
      if (t.tag === 'h1' && !droppedTitle) {
        droppedTitle = true;
        i += 2;
        continue;
      }
      const id = slugger.slug(text);
      t.attrSet('id', id);
      headings.push({ id, text, level: Number(t.tag.slice(1)) });
      sections.push({ id, heading: text, text: '' });
    }
    if (t.type === 'inline' && t.children) {
      t.children = rewriteInline(t.children, doc.slug, published, lang, t.constructor as typeof Token);
      const prev = tokens[i - 1];
      if (prev?.type !== 'heading_open') {
        const s = sections[sections.length - 1]!;
        s.text += `${inlineText(t)} `;
      }
    }
    if (t.type === 'fence' || t.type === 'code_block') {
      const s = sections[sections.length - 1]!;
      s.text += `${t.content} `;
    }
    kept.push(t);
  }
  const html = md.renderer.render(kept, md.options, env);
  return {
    html,
    headings,
    sections: sections.filter((s) => s.text.trim() || s.heading).map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })),
  };
}

/** Search entries for every published doc (one per section). */
export function docSearchEntries(docs: readonly DocFile[], lang: Lang): SearchEntry[] {
  const published = new Set(docs.map((d) => d.slug));
  const out: SearchEntry[] = [];
  for (const doc of docs) {
    const { sections } = renderDoc(doc, published, lang);
    for (const s of sections) {
      out.push({
        href: `/${lang}/docs/${doc.slug}/${s.id ? `#${s.id}` : ''}`,
        title: doc.title,
        heading: s.heading,
        text: s.text.slice(0, 1500),
        lang: 'en',
      });
    }
  }
  return out;
}
