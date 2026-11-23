// The generated .ico files exist and each lists every Windows icon size (pnpm --filter @nigafiy/brand test).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ICO_SIZES } from '../scripts/make-icons.mjs';
import { PROGRAM_IDS } from '../src/tokens.ts';

const root = path.resolve(import.meta.dirname, '..');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Reads an ICO directory: the size of each entry, checking each entry is a PNG of that size. */
function icoSizes(file) {
  const buf = readFileSync(file);
  assert.equal(buf.readUInt16LE(0), 0, `${file}: reserved field`);
  assert.equal(buf.readUInt16LE(2), 1, `${file}: type is icon`);
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf.readUInt8(e) || 256;
    const length = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    assert.ok(offset + length <= buf.length, `${file}: entry ${size} inside the file`);
    const png = buf.subarray(offset, offset + length);
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE, `${file}: entry ${size} is a PNG`);
    assert.equal(png.readUInt32BE(16), size, `${file}: entry ${size} width`);
    assert.equal(png.readUInt32BE(20), size, `${file}: entry ${size} height`);
    sizes.push(size);
  }
  return sizes;
}

test('the sizes are the Windows set 16 to 256', () => {
  assert.deepEqual(ICO_SIZES, [16, 20, 24, 32, 40, 48, 64, 256]);
});

for (const name of ['app', ...PROGRAM_IDS]) {
  test(`ico/${name}.ico lists all ${ICO_SIZES.length} sizes`, () => {
    assert.deepEqual(icoSizes(path.join(root, 'ico', `${name}.ico`)), ICO_SIZES);
  });
}

test('the SVGs carry no font dependency and no raster image', () => {
  for (const name of ['mark', 'app-icon', 'wordmark', 'wordmark-light', 'logo', 'logo-light', ...PROGRAM_IDS.map((id) => `programs/${id}`)]) {
    const svg = readFileSync(path.join(root, 'svg', `${name}.svg`), 'utf8');
    assert.match(svg, /^<svg /, name);
    assert.doesNotMatch(svg, /<text|<image|font-family|@font-face/, name);
  }
});
