// Unit tests of the session-audio decoder against the agent's IMA ADPCM encoder (the encoder below
// mirrors agents/endpoint-agent/internal/audio/adpcm.go line for line). Run with `pnpm --filter
// @nigafiy/web test:unit`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AudioHeader, decodeAdpcm, parseAudioPacket } from './adpcm.ts';

const STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279,
  307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428,
  4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The agent's encoder (adpcm.go encodeSample), interleaved, low nibble first. Returns the predictor trail too. */
function encode(samples: number[], ch: number, st: Array<{ p: number; i: number }>): { data: Uint8Array; trail: number[] } {
  const data = new Uint8Array(Math.ceil(samples.length / 2));
  const trail: number[] = [];
  samples.forEach((sample, k) => {
    const s = st[k % ch]!;
    let step = STEP[s.i]!;
    let diff = sample - s.p;
    let code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    let delta = step >> 3;
    if (diff >= step) {
      code |= 4;
      diff -= step;
      delta += step;
    }
    step >>= 1;
    if (diff >= step) {
      code |= 2;
      diff -= step;
      delta += step;
    }
    step >>= 1;
    if (diff >= step) {
      code |= 1;
      delta += step;
    }
    s.p = clamp(code & 8 ? s.p - delta : s.p + delta, -32768, 32767);
    s.i = clamp(s.i + INDEX[code]!, 0, 88);
    trail.push(s.p);
    data[k >> 1]! |= k & 1 ? code << 4 : code;
  });
  return { data, trail };
}

function packet(h: AudioHeader, data: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(h));
  const buf = new Uint8Array(6 + json.length + data.length);
  buf[0] = 0x4e;
  buf[1] = 2;
  new DataView(buf.buffer).setUint32(2, json.length);
  buf.set(json, 6);
  buf.set(data, 6 + json.length);
  return buf.buffer;
}

describe('IMA ADPCM session audio', () => {
  it('decodes bit-exactly what the agent encoder produced (stereo, interleaved)', () => {
    const frames = 1920; // 40 ms at 48 kHz
    const pcm: number[] = [];
    for (let f = 0; f < frames; f++) {
      pcm.push(Math.round(12000 * Math.sin((2 * Math.PI * 440 * f) / 48000)));
      pcm.push(Math.round(8000 * Math.sin((2 * Math.PI * 1000 * f) / 48000)));
    }
    const start = [
      { p: 0, i: 0 },
      { p: 0, i: 0 },
    ];
    const header: AudioHeader = { t: 'audio', seq: 1, codec: 'ima_adpcm', rate: 48000, ch: 2, frames, st: start.map((s) => ({ ...s })) };
    const { data, trail } = encode(pcm, 2, start);
    const parsed = parseAudioPacket(packet(header, data));
    assert.ok(parsed);
    assert.equal(parsed.data.length, frames); // 2 channels × 4 bits = 1 byte per frame
    const out = decodeAdpcm(parsed.header, parsed.data);
    assert.equal(out.length, 2);
    for (let k = 0; k < pcm.length; k++) assert.equal(Math.round(out[k % 2]![Math.floor(k / 2)]! * 32768), trail[k]);
    // And it follows the signal once the step size has adapted.
    const err = pcm.slice(400).reduce((m, v, k) => Math.max(m, Math.abs(v - trail[k + 400]!)), 0);
    assert.ok(err < 1500, `max error ${err}`);
  });

  it('starts from the state in the header, so each packet decodes on its own', () => {
    const st = [{ p: 1000, i: 40 }];
    const { data, trail } = encode([1200, 900, 1500, 1500], 1, st.map((s) => ({ ...s })));
    const out = decodeAdpcm({ t: 'audio', seq: 9, codec: 'ima_adpcm', rate: 48000, ch: 1, frames: 4, st }, data);
    assert.deepEqual(Array.from(out[0]!, (v) => Math.round(v * 32768)), trail);
  });

  it('refuses what is not an audio packet', () => {
    const h: AudioHeader = { t: 'audio', seq: 1, codec: 'ima_adpcm', rate: 48000, ch: 2, frames: 2, st: [{ p: 0, i: 0 }] };
    assert.equal(parseAudioPacket(packet(h, new Uint8Array(2))), null); // state for one channel only
    assert.equal(parseAudioPacket(packet({ ...h, codec: 'opus', st: [h.st[0]!, h.st[0]!] }, new Uint8Array(2))), null);
    const frame = new Uint8Array(packet({ ...h, st: [h.st[0]!, h.st[0]!] }, new Uint8Array(2)));
    frame[1] = 1; // a video frame
    assert.equal(parseAudioPacket(frame.buffer), null);
    assert.equal(parseAudioPacket(new Uint8Array([0x4e, 2, 0, 0, 0, 99]).buffer), null);
  });
});
