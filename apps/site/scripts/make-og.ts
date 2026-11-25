// Writes public/og.png (1200×630, the Open Graph image) from the brand: the app icon, the
// wordmark and the program glyphs in their accent squares. No text is drawn with a font: the
// wordmark is the path packages/brand generated from Poppins 600.
//
//   pnpm --filter @nigafiy/site og
//
// sharp is borrowed from @nigafiy/brand (it already depends on it), so the site adds no dependency.
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP_ICON_PATHS, BRAND, PROGRAMS_BRAND, type ProgramId } from '../../../packages/brand/src/tokens.ts';
import { WORDMARK } from '../../../packages/brand/src/wordmark.ts';
import { REPO_ROOT, SITE_DIR } from '../lib/paths.ts';

const require = createRequire(path.join(REPO_ROOT, 'packages', 'brand', 'package.json'));
const sharp = require('sharp') as (input: Buffer) => { png: () => { toFile: (f: string) => Promise<unknown> } };

const W = 1200;
const H = 630;
const [, , ww = 344.8, wh = 105.7] = WORDMARK.viewBox.split(' ').map(Number);
const wordH = 96;
const wordW = (wordH * ww) / wh;
const programs: ProgramId[] = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'];
const tile = 84;
const gap = 22;
const rowW = programs.length * tile + (programs.length - 1) * gap;

const glyphs = programs
  .map((id, i) => {
    const x = (W - rowW) / 2 + i * (tile + gap);
    const y = 420;
    const p = PROGRAMS_BRAND[id];
    return `<g transform="translate(${x} ${y})"><rect width="${tile}" height="${tile}" rx="${tile / 4}" fill="${p.accent}"/><path d="${p.glyph}" transform="translate(${tile * 0.2} ${tile * 0.2}) scale(${(tile * 0.6) / 24})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  })
  .join('');

const icon = 150;
const groupW = icon + 36 + wordW;
const gx = (W - groupW) / 2;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<rect y="${H - 12}" width="${W}" height="12" fill="${BRAND.blue}"/>
<g transform="translate(${gx} 150)">
  <rect width="${icon}" height="${icon}" rx="${icon / 4}" fill="${BRAND.iconGround}"/>
  <g transform="scale(${icon / 32})"><path d="${APP_ICON_PATHS.blue}" fill="${BRAND.blue}"/><path d="${APP_ICON_PATHS.shade}" fill="${BRAND.iconShade}"/></g>
  <svg x="${icon + 36}" y="${(icon - wordH) / 2 + 6}" width="${wordW}" height="${wordH}" viewBox="${WORDMARK.viewBox}"><path d="${WORDMARK.d}" fill="${BRAND.wordmark}"/></svg>
</g>
${glyphs}
</svg>`;

const out = path.join(SITE_DIR, 'public', 'og.png');
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`[og] wrote ${path.relative(REPO_ROOT, out)}`);
