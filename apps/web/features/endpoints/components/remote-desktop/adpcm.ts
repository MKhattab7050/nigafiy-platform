// IMA ADPCM decoder for the session audio (agent: internal/audio/adpcm.go). Each packet carries the
// decoder state of every channel at its start, so packets decode on their own. Samples are
// interleaved; two 4-bit codes per byte, low nibble first.

const STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279,
  307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428,
  4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

export interface AudioHeader {
  t: 'audio';
  seq: number;
  codec: string;
  rate: number;
  ch: number;
  frames: number;
  st: Array<{ p: number; i: number }>;
}

export function parseAudioPacket(buf: ArrayBuffer): { header: AudioHeader; data: Uint8Array } | null {
  const b = new Uint8Array(buf);
  if (b.length < 6 || b[0] !== 0x4e || b[1] !== 2) return null;
  const n = new DataView(buf).getUint32(2);
  if (n === 0 || 6 + n > b.length) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b.subarray(6, 6 + n))) as AudioHeader;
    if (header.t !== 'audio' || header.codec !== 'ima_adpcm' || !Array.isArray(header.st) || header.st.length !== header.ch) return null;
    return { header, data: b.subarray(6 + n) };
  } catch {
    return null;
  }
}

/** Decodes to one Float32Array per channel (−1…1). */
export function decodeAdpcm(h: AudioHeader, data: Uint8Array): Float32Array[] {
  const ch = h.ch;
  const st = h.st.map((s) => ({ p: s.p, i: s.i }));
  const out = Array.from({ length: ch }, () => new Float32Array(h.frames));
  const total = h.frames * ch;
  for (let k = 0; k < total && k >> 1 < data.length; k++) {
    let code = data[k >> 1]!;
    if (k & 1) code >>= 4;
    code &= 15;
    const s = st[k % ch]!;
    const step = STEP[s.i]!;
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    s.p = Math.max(-32768, Math.min(32767, code & 8 ? s.p - delta : s.p + delta));
    s.i = Math.max(0, Math.min(88, s.i + INDEX[code]!));
    out[k % ch]![Math.floor(k / ch)] = s.p / 32768;
  }
  return out;
}
