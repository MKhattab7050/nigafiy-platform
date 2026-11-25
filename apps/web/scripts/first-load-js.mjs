// Measures first-load JavaScript per route from a finished `next build` (Turbopack output).
// Next 16 no longer prints sizes, so this sums the root main files plus each page's entry chunks
// (from page_client-reference-manifest.js) — the scripts a browser must fetch before the page runs.
// Usage: node apps/web/scripts/first-load-js.mjs [route-filter]   (run after `pnpm build`)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const nextDir = join(import.meta.dirname, '..', '.next');
const build = JSON.parse(readFileSync(join(nextDir, 'build-manifest.json'), 'utf8'));
const root = [...build.rootMainFiles, ...build.polyfillFiles];
const filter = process.argv[2] ?? '';

const sizes = new Map();
function size(file) {
  if (!sizes.has(file)) {
    const buf = readFileSync(join(nextDir, file));
    sizes.set(file, { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length });
  }
  return sizes.get(file);
}

function* manifests(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* manifests(full);
    else if (name === 'page_client-reference-manifest.js') yield full;
  }
}

const rows = [];
for (const file of manifests(join(nextDir, 'server', 'app'))) {
  const route = `/${relative(join(nextDir, 'server', 'app'), file).split(sep).slice(0, -1).join('/')}`.replace(/\/\([^)]+\)/g, '') || '/';
  if (!route.includes(filter)) continue;
  const text = readFileSync(file, 'utf8');
  const m = /"entryJSFiles":(\{.*?\})\s*[,}]\s*"entryCSSFiles"|"entryJSFiles":(\{[^{}]*\})/s.exec(text);
  const entry = JSON.parse(m[1] ?? m[2]);
  const files = new Set(root);
  for (const list of Object.values(entry)) for (const f of list) files.add(f);
  let raw = 0;
  let gz = 0;
  for (const f of files) {
    const s = size(f);
    raw += s.raw;
    gz += s.gz;
  }
  rows.push({ route, raw, gz });
}
rows.sort((a, b) => b.raw - a.raw);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
for (const r of rows) console.log(`${r.route.padEnd(42)} ${kb(r.raw).padStart(9)} ${kb(r.gz).padStart(9)} gz`);
const total = rows.reduce((a, r) => a + r.raw, 0);
const totalGz = rows.reduce((a, r) => a + r.gz, 0);
console.log(`\n${rows.length} routes, mean ${kb(total / rows.length)} (${kb(totalGz / rows.length)} gz), root shared ${kb(root.reduce((a, f) => a + size(f).raw, 0))}`);
