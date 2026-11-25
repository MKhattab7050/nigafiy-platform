import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Ecc, alignmentPositions, dataCodewords, dataPositions, eccLayout, encodeQr, formatBits, functionModules, MASKS, rawDataModules, rsDivisor, rsRemainder, versionBits } from './qr.ts';

test('Reed–Solomon matches the published 1-M "HELLO WORLD" example', () => {
  // thonky.com QR tutorial, error correction coding (version 1-M, 10 EC codewords).
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('capacities, alignment positions, format and version bits match ISO/IEC 18004', () => {
  assert.equal(dataCodewords(1, 'M'), 16);
  assert.equal(dataCodewords(10, 'M'), 216);
  assert.equal(dataCodewords(40, 'L'), 2956);
  assert.equal(dataCodewords(40, 'H'), 1276);
  assert.equal(rawDataModules(40), 29648);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(36), [6, 24, 50, 76, 102, 128, 154]);
  assert.equal(formatBits('L', 0), 0b111011111000100);
  assert.equal(formatBits('M', 0), 0b101010000010010);
  // H, mask 7: checked by long division by 0x537, then XOR 0x5412.
  assert.equal(formatBits('H', 7), 0b000100000111011);
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(40), 0x28c69);
  // Every data and error-correction bit has a place (the remainder bits are 0–7).
  for (const v of [1, 2, 6, 7, 14, 21, 27, 40]) {
    const spare = dataPositions(v).length - Math.floor(rawDataModules(v) / 8) * 8;
    assert.ok(spare >= 0 && spare < 8, `version ${v}: ${spare} remainder bits`);
  }
});

/** Reads a code back the way a scanner does on a clean image, and checks every block's syndromes. */
function decode(modules: boolean[][]): { text: string; ecc: Ecc; mask: number; version: number } {
  const size = modules.length;
  const version = (size - 17) / 4;
  const at = (x: number, y: number) => modules[y]![x]!;
  let first = 0;
  for (let i = 0; i <= 5; i++) first |= Number(at(8, i)) << i;
  first |= Number(at(8, 7)) << 6;
  first |= Number(at(8, 8)) << 7;
  first |= Number(at(7, 8)) << 8;
  for (let i = 9; i < 15; i++) first |= Number(at(14 - i, 8)) << i;
  let second = 0;
  for (let i = 0; i < 8; i++) second |= Number(at(size - 1 - i, 8)) << i;
  for (let i = 8; i < 15; i++) second |= Number(at(8, size - 15 + i)) << i;
  assert.equal(first, second, 'both copies of the format information agree');
  assert.equal(at(8, size - 8), true, 'dark module');
  let found: { ecc: Ecc; mask: number } | null = null;
  for (const ecc of ['L', 'M', 'Q', 'H'] as const) for (let mask = 0; mask < 8; mask++) if (formatBits(ecc, mask) === first) found = { ecc, mask };
  assert.ok(found, 'format information is a valid code word');
  if (version >= 7) {
    let v1 = 0;
    let v2 = 0;
    for (let i = 0; i < 18; i++) {
      v1 |= Number(at(size - 11 + (i % 3), Math.floor(i / 3))) << i;
      v2 |= Number(at(Math.floor(i / 3), size - 11 + (i % 3))) << i;
    }
    assert.equal(v1, versionBits(version));
    assert.equal(v2, versionBits(version));
  }
  // Finder pattern centres and the timing pattern.
  for (const [x, y] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    assert.equal(at(x, y), true);
  for (let i = 8; i < size - 8; i++) assert.equal(at(6, i), i % 2 === 0);
  assert.equal(functionModules(version)[size - 8]![8], true);

  const bits = dataPositions(version).map(([x, y]) => at(x, y) !== MASKS[found!.mask]!(x, y));
  const raw = Math.floor(rawDataModules(version) / 8);
  const cw: number[] = [];
  for (let i = 0; i < raw; i++) cw.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | Number(b), 0));
  const { blocks: nb, eccPerBlock } = eccLayout(version, found.ecc);
  const numShort = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const blocks: number[][] = Array.from({ length: nb }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let j = 0; j < nb; j++) {
      // Short blocks have one data codeword fewer: no codeword at that index.
      if (i === shortLen - eccPerBlock && j < numShort) continue;
      blocks[j]!.push(cw[k++]!);
    }
  }
  assert.equal(k, raw);
  const divisor = rsDivisor(eccPerBlock);
  const data: number[] = [];
  for (const b of blocks) {
    const d = b.slice(0, b.length - eccPerBlock);
    assert.deepEqual(rsRemainder(d, divisor), b.slice(b.length - eccPerBlock), 'block error correction is consistent');
    data.push(...d);
  }
  const stream = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
  const read = (from: number, n: number) => stream.slice(from, from + n).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(read(0, 4), 0b0100, 'byte mode');
  const countBits = version <= 9 ? 8 : 16;
  const len = read(4, countBits);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = read(4 + countBits + i * 8, 8);
  return { text: new TextDecoder().decode(out), ecc: found.ecc, mask: found.mask, version };
}

test('codes read back to the exact text at every error-correction level and size', () => {
  const link = 'nigafiy://enroll?server=https%3A%2F%2Fnigafiy.example.test%3A47143&token=ldea_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_&pin=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const provisioning = JSON.stringify({
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': 'com.nigafiy.agent/.admin.NigafiyAdminReceiver',
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': 'https://nigafiy.example.test:47143/api/v1/agent/android/agent.apk',
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA',
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { server: 'https://nigafiy.example.test:47143', token: 'ldea_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_', pin: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0' },
  });
  for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
    for (const text of ['A', 'https://nigafiy.example.test', link, provisioning, 'هاتف الاستقبال — Nigafiy', 'x'.repeat(1200)]) {
      const qr = encodeQr(text, ecc);
      const back = decode(qr.modules);
      assert.equal(back.text, text);
      assert.equal(back.ecc, ecc);
      assert.equal(back.mask, qr.mask);
      assert.equal(back.version, qr.version);
    }
  }
  assert.ok(encodeQr(provisioning, 'M').version >= 7, 'the provisioning JSON exercises the version information');
  assert.throws(() => encodeQr('x'.repeat(3000), 'H'));
});
