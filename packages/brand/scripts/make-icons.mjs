// Generates every Nigafiy brand file from src/tokens.ts:
//   svg/mark.svg, svg/app-icon.svg, svg/wordmark.svg, svg/logo.svg, svg/programs/<id>.svg
//   ico/app.ico, ico/<id>.ico          (16, 20, 24, 32, 40, 48, 64 and 256 px, PNG-compressed entries)
//   png/app-256.png, png/<id>-256.png  (for Electron windows and the tray)
//
//   pnpm --filter @nigafiy/brand build
//
// The wordmark is Poppins 600 converted to outlines, so no font is needed where it is shown.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import opentype from 'opentype.js';
import sharp from 'sharp';
import { APP_ICON_PATHS, BRAND, MARK_PATHS, PROGRAM_IDS, PROGRAMS_BRAND } from '../src/tokens.ts';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

const out = (rel, data) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
};

// ── SVG sources ──────────────────────────────────────────────────────────────────────────────

export function markSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Nigafiy</title><path d="${MARK_PATHS.blue}" fill="${BRAND.blue}"/><path d="${MARK_PATHS.navy}" fill="${BRAND.navy}"/></svg>\n`;
}

export function appIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Nigafiy</title><rect width="32" height="32" rx="8" fill="${BRAND.iconGround}"/><path d="${APP_ICON_PATHS.blue}" fill="${BRAND.blue}"/><path d="${APP_ICON_PATHS.shade}" fill="${BRAND.iconShade}"/></svg>\n`;
}

/**
 * A program glyph on its rounded accent square. Small sizes get a bigger glyph and a heavier
 * stroke so they stay legible at 16 px (the same steps as the approved icon mockup).
 */
export function programSvg(id, size = 256) {
  const p = PROGRAMS_BRAND[id];
  const [fraction, stroke] = size <= 16 ? [0.62, 3] : size <= 24 ? [0.58, 2.4] : [0.53, 2];
  const glyph = 100 * fraction;
  const offset = (100 - glyph) / 2;
  const scale = glyph / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>${p.name}</title><rect width="100" height="100" rx="25" fill="${p.accent}"/><path d="${p.glyph}" transform="translate(${offset} ${offset}) scale(${scale.toFixed(4)})" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`;
}

function wordmarkOutline() {
  const fontFile = require.resolve('@fontsource/poppins/files/poppins-latin-600-normal.woff');
  const buf = readFileSync(fontFile);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const fontSize = 100;
  const text = font.getPath('nigafiy', 0, 0, fontSize);
  const box = text.getBoundingBox();
  return { d: text.toPathData(2), x: box.x1, y: box.y1, w: box.x2 - box.x1, h: box.y2 - box.y1, fontSize };
}

export function wordmarkSvg(color = BRAND.wordmark) {
  const w = wordmarkOutline();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${w.x.toFixed(2)} ${w.y.toFixed(2)} ${w.w.toFixed(2)} ${w.h.toFixed(2)}"><title>nigafiy</title><path d="${w.d}" fill="${color}"/></svg>\n`;
}

/** Mark and wordmark side by side, as in the approved logo D lock-up. */
export function logoSvg(color = BRAND.wordmark) {
  const w = wordmarkOutline();
  // The mark is as tall as the wordmark's x-height-to-descender span; scale the 32-grid to it.
  const markSize = w.h * 1.05;
  const gap = markSize * 0.28;
  const s = markSize / 32;
  const width = markSize + gap + w.w;
  const tx = markSize + gap - w.x;
  const ty = -w.y + (markSize - w.h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${markSize.toFixed(2)}"><title>Nigafiy</title><g transform="scale(${s.toFixed(4)})"><path d="${MARK_PATHS.blue}" fill="${BRAND.blue}"/><path d="${MARK_PATHS.navy}" fill="${BRAND.navy}"/></g><path d="${w.d}" transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)})" fill="${color}"/></svg>\n`;
}

// ── ICO container (PNG-compressed entries; Windows Vista and later) ──────────────────────────────

export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function renderPng(svg, size) {
  // Render well above the target and downscale: crisp edges at 16 px.
  return sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil((72 * size * 4) / 32)) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function icoFor(svgForSize) {
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, png: await renderPng(svgForSize(size), size) });
  return { ico: encodeIco(images), png256: images.at(-1).png };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  out('svg/mark.svg', markSvg());
  out('svg/app-icon.svg', appIconSvg());
  out('svg/wordmark.svg', wordmarkSvg());
  out('svg/wordmark-light.svg', wordmarkSvg('#FFFFFF'));
  out('svg/logo.svg', logoSvg());
  out('svg/logo-light.svg', logoSvg('#FFFFFF'));

  const app = await icoFor(() => appIconSvg());
  out('ico/app.ico', app.ico);
  out('png/app-256.png', app.png256);

  for (const id of PROGRAM_IDS) {
    out(`svg/programs/${id}.svg`, programSvg(id));
    const icon = await icoFor((size) => programSvg(id, size));
    out(`ico/${id}.ico`, icon.ico);
    out(`png/${id}-256.png`, icon.png256);
  }
  console.log(`brand files written to ${root}`);
}
