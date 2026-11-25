#!/usr/bin/env node
// Checks the README pages (README.md, README.ar.md) the way GitHub will show them:
//   - every relative link, image and <picture> source points at a file or folder that exists;
//   - every "#anchor" (on the same page or on the other README) resolves to a heading or an id;
//   - every <img> has an alt attribute (alt="" for decoration);
//   - both pages offer the same in-page anchors, so a link that works in one language works in the other.
//
//   node scripts/check-readme-links.mjs
//
// Read-only. Web links (http, https, mailto) are listed, not fetched.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const PAGES = ['README.md', 'README.ar.md'];

/** GitHub's heading slug: lower case, punctuation removed, spaces to hyphens. */
function slug(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/** The page without fenced code blocks (links inside them are not links). */
function withoutCode(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

function anchorsOf(text) {
  const ids = new Set();
  const seen = new Map();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    ids.add(n ? `${base}-${n}` : base);
  }
  for (const m of text.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)) ids.add(slug(m[1]));
  for (const m of text.matchAll(/\s(?:id|name)="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

function targetsOf(text) {
  const out = [];
  for (const m of text.matchAll(/\s(href|src)="([^"]*)"/g)) out.push({ kind: m[1], url: m[2] });
  for (const m of text.matchAll(/\ssrcset="([^"]*)"/g)) for (const part of m[1].split(',')) out.push({ kind: 'srcset', url: part.trim().split(/\s+/)[0] });
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ kind: 'md', url: m[1] });
  return out;
}

const texts = Object.fromEntries(PAGES.map((p) => [p, withoutCode(readFileSync(path.join(root, p), 'utf8'))]));
const anchors = Object.fromEntries(PAGES.map((p) => [p, anchorsOf(texts[p])]));
const problems = [];
const web = new Set();
let checked = 0;

for (const page of PAGES) {
  const text = texts[page];
  for (const { kind, url } of targetsOf(text)) {
    checked++;
    if (/^(https?:|mailto:)/.test(url)) {
      web.add(url);
      continue;
    }
    if (url === '') {
      problems.push(`${page}: empty ${kind}`);
      continue;
    }
    const [file, hash] = url.split('#');
    const target = file ? path.normalize(file) : page;
    if (file && !existsSync(path.join(root, decodeURIComponent(file)))) {
      problems.push(`${page}: ${kind} "${url}" does not exist`);
      continue;
    }
    if (hash !== undefined) {
      const set = anchors[target.replace(/\\/g, '/')];
      if (!set) problems.push(`${page}: "${url}" has an anchor on a file this check does not read`);
      else if (!set.has(decodeURIComponent(hash))) problems.push(`${page}: anchor "#${hash}" not found in ${target}`);
    }
  }
  for (const m of text.matchAll(/<img\b[^>]*>/g)) {
    if (!/\salt="/.test(m[0])) problems.push(`${page}: <img> without alt: ${m[0].slice(0, 90)}`);
  }
}

// In-page anchors that one page links to must exist on the other page too.
const linked = (page) => new Set([...texts[page].matchAll(/href="#([^"]+)"|\]\(#([^)]+)\)/g)].map((m) => m[1] ?? m[2]));
for (const [a, b] of [PAGES, [...PAGES].reverse()]) {
  for (const id of linked(a)) if (!anchors[b].has(id)) problems.push(`${b}: has no anchor "#${id}" that ${a} links to`);
}

if (problems.length) {
  console.error(`check-readme-links: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-readme-links: ${checked} links and images in ${PAGES.join(', ')} resolve; web links not fetched: ${web.size}`);
