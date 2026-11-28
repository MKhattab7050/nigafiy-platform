// Unit tests of the transfer queue's SHA-256 and its resume rules against node:crypto. Run with
// `pnpm --filter @nigafiy/web test:unit`.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { Sha256 } from './sha256.ts';
import { crc32 } from 'node:zlib';
import { crumbsOf, joinRemote, relPath } from './paths.ts';
import { Crc32, MemoryZipSink, ZipWriter } from './zip-writer.ts';

const ref = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('Sha256', () => {
  it('matches node:crypto for every length around the block edges, fed in odd pieces', () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const data = new Uint8Array(randomBytes(n));
      const s = new Sha256();
      for (let i = 0; i < n; ) {
        const step = 1 + ((i * 7) % 97);
        s.update(data.subarray(i, i + step));
        i += step;
      }
      assert.equal(s.hex(), ref(data), `length ${n}`);
    }
    assert.equal(new Sha256().update(new TextEncoder().encode('abc')).hex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Sha256 state', () => {
  it('continues the same checksum after save and restore (a page reload)', () => {
    const data = new Uint8Array(randomBytes(200_003));
    const a = new Sha256().update(data.subarray(0, 77_777));
    const b = Sha256.restore(JSON.parse(JSON.stringify(a.save())));
    b.update(data.subarray(77_777));
    assert.equal(b.hex(), ref(data));
  });
});

describe('paths', () => {
  it('joins and splits Windows and phone paths', () => {
    assert.equal(joinRemote('C:\\Users\\Pat', 'Trip/Day 1/a.jpg'), 'C:\\Users\\Pat\\Trip\\Day 1\\a.jpg');
    assert.equal(joinRemote('C:\\', 'a.txt'), 'C:\\a.txt');
    assert.equal(joinRemote('/storage/emulated/0/DCIM', 'Camera/x.jpg'), '/storage/emulated/0/DCIM/Camera/x.jpg');
    assert.equal(relPath('C:\\Users\\Pat\\Trip', 'C:\\Users\\Pat\\Trip\\Day 1\\a.jpg'), 'Day 1/a.jpg');
    assert.equal(relPath('/sdcard/DCIM', '/sdcard/DCIM/Camera/x.jpg'), 'Camera/x.jpg');
    assert.deepEqual(
      crumbsOf('C:\\Users\\Pat').map((c) => c.path),
      ['C:\\', 'C:\\Users', 'C:\\Users\\Pat'],
    );
    assert.deepEqual(
      crumbsOf('/storage/emulated').map((c) => c.path),
      ['/', '/storage', '/storage/emulated'],
    );
  });
});

describe('ZipWriter', () => {
  it('writes stored entries whose CRC and sizes match, folders included', async () => {
    assert.equal(new Crc32().update(new TextEncoder().encode('hello')).value(), crc32('hello'));
    const sink = new MemoryZipSink();
    const z = new ZipWriter(sink);
    await z.addFolder('Trip/empty');
    const a = new Uint8Array(randomBytes(70_001));
    await z.begin('Trip/a.bin', a.length);
    await z.data(a.subarray(0, 1000));
    await z.data(a.subarray(1000));
    await z.end();
    await z.finish();
    const buf = Buffer.from(await sink.blob().arrayBuffer());
    // End of central directory: 2 entries.
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.equal(buf.readUInt16LE(eocd + 10), 2);
    // The file's local header carries the CRC written after its data.
    const local = buf.indexOf(Buffer.from('Trip/a.bin')) - 30;
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    assert.equal(buf.readUInt32LE(local + 14), crc32(a));
    assert.equal(buf.readUInt32LE(local + 18), a.length);
    // A wrong size is refused, never written silently.
    const z2 = new ZipWriter(new MemoryZipSink());
    await z2.begin('x', 3);
    await z2.data(new Uint8Array(2));
    await assert.rejects(() => z2.end());
  });
});
